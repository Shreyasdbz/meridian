// @meridian/gear — public API

// Phase 5.1: Manifest parsing, validation, and checksum
export { validateManifest, computeChecksum, computeChecksumFromBuffer } from './manifest.js';
export type { ManifestIssueType, ManifestIssue } from './manifest.js';

// Phase 5.1: Gear registry — CRUD, cache, GearLookup
export { GearRegistry } from './registry.js';
export type {
  GearListFilter,
  RegistryLogger,
  BuiltinGearDefinition,
} from './registry.js';

// Phase 5.2: Process sandbox — Level 1 sandbox with OS-level restrictions
export {
  createSandbox,
  destroySandbox,
  signMessage,
  verifySignature,
  generateSigningKey,
  generateSeatbeltProfile,
  generateSeccompProfile,
  buildSandboxEnv,
  injectSecrets,
  cleanupSecrets,
  isPathAllowed,
  isDomainAllowed,
} from './sandbox/process-sandbox.js';
export type {
  SandboxRequest,
  SandboxResponse,
  SandboxProgress,
  SandboxStdoutMessage,
  SandboxOptions,
  SandboxLogger,
  SandboxHandle,
  SeccompProfile,
} from './sandbox/process-sandbox.js';

// Phase 5.2: Gear host — host-side process management and communication
export { GearHost } from './sandbox/gear-host.js';
export type {
  GearExecutionResult,
  ExecuteActionOptions,
  ProgressCallback,
  LogCallback,
  SubJobCallback,
  CommandCallback,
  GearHostConfig,
} from './sandbox/gear-host.js';

// Phase 5.3: Gear context — constrained API for Gear code inside the sandbox
export {
  GearContextImpl,
  createGearContext,
  validatePath,
  validateUrl,
  isPrivateIp,
  checkDnsRebinding,
} from './context.js';
export type {
  SecretProvider,
  SubJobCreator,
  LogSink,
  ProgressSink,
  CommandHandler,
  GearContextConfig,
  DnsResolver,
} from './context.js';

// Phase 5.3: Gear runtime — runs inside the sandbox process
export { startRuntime } from './sandbox/gear-runtime.js';

// ---------------------------------------------------------------------------
// Phase 5.7: Gear Integration — createGearRuntime()
// ---------------------------------------------------------------------------
// Wires GearRegistry + GearHost + Axis message handler together.
// Registers as 'gear:runtime' with the component registry to handle
// execute.request messages dispatched through Axis.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AxisMessage,
  ComponentId,
  ComponentRegistry,
  DatabaseClient,
  GearManifest,
  MessageHandler,
} from '@meridian/shared';
import { generateId, ValidationError } from '@meridian/shared';

import { GearRegistry } from './registry.js';
import type { BuiltinGearDefinition, RegistryLogger } from './registry.js';
import { GearHost } from './sandbox/gear-host.js';
import type { ProgressCallback, LogCallback, SubJobCallback } from './sandbox/gear-host.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The ComponentId used to register the Gear runtime handler with Axis.
 * All execute.request messages are addressed to this component.
 */
export const GEAR_RUNTIME_ID: ComponentId = 'gear:runtime';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for the Gear runtime.
 */
export interface GearRuntimeLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Configuration for the Gear runtime.
 */
export interface GearRuntimeConfig {
  /** Database client for the Gear registry (meridian.db). */
  db: DatabaseClient;
  /** Path where Gear packages are stored. */
  gearPackagesDir: string;
  /** Workspace path for Gear file operations. */
  workspacePath: string;
  /** Built-in Gear manifests. Defaults to loading from builtin/ directory. */
  builtinManifests?: GearManifest[];
  /** Optional logger. */
  logger?: GearRuntimeLogger;
  /** Secret provider for Gear execution. */
  getSecrets?: (gearId: string, secretNames: string[]) => Promise<Map<string, Buffer>>;
  /** Callback for progress updates from running Gear. */
  onProgress?: ProgressCallback;
  /** Callback for log messages from running Gear. */
  onLog?: LogCallback;
  /** Callback for sub-job requests from running Gear. */
  onSubJob?: SubJobCallback;
}

/**
 * Dependencies injected into the Gear runtime.
 */
export interface GearRuntimeDeps {
  /** Axis component registry for handler registration. */
  registry: ComponentRegistry;
}

/**
 * The Gear runtime handle returned by createGearRuntime().
 *
 * Provides access to the GearRegistry (for plan validation as GearLookup)
 * and the GearHost (for direct execution if needed).
 */
export interface GearRuntime {
  /** The Gear registry — satisfies GearLookup for plan validation. */
  readonly gearRegistry: GearRegistry;
  /** The Gear host — manages sandbox execution. */
  readonly gearHost: GearHost;
  /** Shut down the Gear runtime: kill all active sandboxes. */
  shutdown(): Promise<void>;
  /** Dispose: unregister from Axis component registry. Idempotent. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Built-in manifest loader
// ---------------------------------------------------------------------------

/**
 * Load built-in Gear manifests from the builtin/ directory.
 *
 * Scans `src/gear/builtin/<name>/manifest.json` for each subdirectory
 * and returns the parsed manifests. Returns an empty array if the
 * builtin directory is not found.
 */
export function loadBuiltinManifests(): GearManifest[] {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const builtinDir = join(currentDir, 'builtin');

  if (!existsSync(builtinDir)) {
    return [];
  }

  const manifests: GearManifest[] = [];
  const entries = readdirSync(builtinDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(builtinDir, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    const raw = readFileSync(manifestPath, 'utf-8');
    manifests.push(JSON.parse(raw) as GearManifest);
  }

  return manifests;
}

// ---------------------------------------------------------------------------
// createGearRuntime()
// ---------------------------------------------------------------------------

/**
 * Create the Gear runtime: wire GearRegistry, GearHost, and Axis together.
 *
 * This is the top-level integration function for the Gear module (Phase 5.7).
 * It:
 * 1. Creates a GearRegistry and loads the manifest cache
 * 2. Registers built-in Gear (file-manager, web-fetch, shell)
 * 3. Creates a GearHost for sandbox execution
 * 4. Registers a message handler with Axis for execute.request messages
 *
 * The handler processes execute.request messages through the full lifecycle:
 * look up Gear -> verify integrity -> create sandbox -> inject secrets ->
 * execute action -> collect results -> destroy sandbox -> return response.
 *
 * @param config - Configuration for the Gear runtime
 * @param deps - Dependencies (Axis component registry)
 * @returns A GearRuntime handle with registry, host, and lifecycle methods
 */
export async function createGearRuntime(
  config: GearRuntimeConfig,
  deps: GearRuntimeDeps,
): Promise<GearRuntime> {
  const logger: GearRuntimeLogger = config.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  // 1. Create the GearRegistry
  const gearRegistry = new GearRegistry(config.db, logger as RegistryLogger);

  // 2. Register built-in Gear
  const builtinManifests = config.builtinManifests ?? loadBuiltinManifests();
  const builtinDefs: BuiltinGearDefinition[] = builtinManifests.map((m) => ({
    manifest: m,
    packagePath: join(config.gearPackagesDir, m.id, 'index.js'),
  }));

  await gearRegistry.registerBuiltins(builtinDefs);
  await gearRegistry.loadCache();

  logger.info('Gear registry initialized', {
    builtinCount: builtinManifests.length,
    cachedCount: gearRegistry.cacheSize,
  });

  // 3. Create the GearHost
  const gearHost = new GearHost({
    gearPackagesDir: config.gearPackagesDir,
    workspacePath: config.workspacePath,
    logger,
    getStoredChecksum: (gearId) => gearRegistry.getChecksum(gearId),
    disableGear: (gearId) => gearRegistry.disable(gearId),
    getSecrets: config.getSecrets,
    onProgress: config.onProgress,
    onLog: config.onLog,
    onSubJob: config.onSubJob,
  });

  // 4. Create the execute.request message handler
  const handler: MessageHandler = async (message, signal) => {
    if (message.type !== 'execute.request') {
      throw new ValidationError(
        `Gear runtime only handles 'execute.request', got: '${message.type}'`,
      );
    }

    const payload = message.payload;
    if (!payload) {
      throw new ValidationError('execute.request missing payload');
    }

    const gearId = payload['gear'] as string | undefined;
    const action = payload['action'] as string | undefined;
    const parameters = (payload['parameters'] as Record<string, unknown> | undefined) ?? {};
    const stepId = payload['stepId'] as string | undefined;

    if (!gearId || !action) {
      throw new ValidationError(
        'execute.request missing required fields: gear and action',
      );
    }

    // Look up Gear manifest in registry (only enabled Gear are cached)
    const manifest = gearRegistry.getManifest(gearId);
    if (!manifest) {
      return buildErrorResponse(message, gearId, {
        code: 'GEAR_NOT_FOUND',
        message: `Gear '${gearId}' not found or disabled`,
      });
    }

    // Execute via GearHost (integrity -> sandbox -> secrets -> execute -> provenance -> cleanup)
    const result = await gearHost.execute(manifest, {
      gearId,
      action,
      parameters,
      correlationId: message.correlationId,
      signal,
    });

    if (!result.ok) {
      return buildErrorResponse(message, gearId, {
        code: 'GEAR_EXECUTION_FAILED',
        message: result.error,
      });
    }

    // Build successful execute.response
    return {
      id: generateId(),
      correlationId: message.correlationId,
      timestamp: new Date().toISOString(),
      from: `gear:${gearId}` as ComponentId,
      to: message.from,
      type: 'execute.response' as const,
      replyTo: message.id,
      jobId: message.jobId,
      payload: {
        result: result.value.result,
        source: result.value.source,
        durationMs: result.value.durationMs,
        stepId,
      },
    };
  };

  // 5. Register with Axis component registry
  let registered = false;
  deps.registry.register(GEAR_RUNTIME_ID, handler);
  registered = true;

  logger.info('Gear runtime registered with Axis', {
    componentId: GEAR_RUNTIME_ID,
  });

  // 6. Return the GearRuntime handle
  return {
    gearRegistry,
    gearHost,

    async shutdown(): Promise<void> {
      await gearHost.shutdown();
      logger.info('Gear runtime shut down');
    },

    dispose(): void {
      if (registered) {
        try {
          deps.registry.unregister(GEAR_RUNTIME_ID);
        } catch {
          // Already unregistered — safe to ignore
        }
        registered = false;
        logger.info('Gear runtime unregistered from Axis');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build an execute.response AxisMessage containing an error payload.
 */
function buildErrorResponse(
  request: AxisMessage,
  gearId: string,
  error: { code: string; message: string },
): AxisMessage {
  return {
    id: generateId(),
    correlationId: request.correlationId,
    timestamp: new Date().toISOString(),
    from: `gear:${gearId}` as ComponentId,
    to: request.from,
    type: 'execute.response',
    replyTo: request.id,
    jobId: request.jobId,
    payload: {
      error,
    },
  };
}
