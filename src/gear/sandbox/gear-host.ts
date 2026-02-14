// @meridian/gear — Host-side Gear execution and communication (Section 5.6.3, 5.6.4)
// Manages sandbox lifecycle, message protocol, integrity checks, and provenance tagging.

import type { GearManifest, Result, Ed25519Keypair, ComponentId } from '@meridian/shared';
import {
  ok,
  err,
  DEFAULT_GEAR_TIMEOUT_MS,
  generateEphemeralKeypair,
  zeroPrivateKey,
} from '@meridian/shared';

import { computeChecksum } from '../manifest.js';

import type {
  SandboxHandle,
  SandboxLogger,
  SandboxOptions,
  SandboxProgress,
  SandboxRequest,
  SandboxResponse,
} from './process-sandbox.js';
import {
  createSandbox,
  destroySandbox,
  signMessage,
  verifySignature,
  generateSigningKey,
  signSandboxRequest,
  verifySandboxResponseSignature,
} from './process-sandbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a Gear action execution.
 */
export interface GearExecutionResult {
  /** The Gear's output, wrapped with provenance. */
  result: Record<string, unknown>;
  /** Provenance tag for the output. */
  source: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
}

/**
 * Options for executing a Gear action.
 */
export interface ExecuteActionOptions {
  /** The Gear ID. */
  gearId: string;
  /** The action name. */
  action: string;
  /** Action parameters (already validated against JSON Schema). */
  parameters: Record<string, unknown>;
  /** Unique correlation ID for request/response matching. */
  correlationId: string;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Callback for receiving progress updates from a running Gear.
 */
export type ProgressCallback = (percent: number, message?: string) => void;

/**
 * Callback for receiving log messages from a running Gear.
 */
export type LogCallback = (gearId: string, message: string) => void;

/**
 * Callback for handling sub-job requests from a running Gear.
 */
export type SubJobCallback = (description: string, requestId: string) => void;

/**
 * Callback for handling system command requests from Gear.
 * Returns the command result to be sent back to the sandbox.
 */
export type CommandCallback = (
  command: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Configuration for the GearHost.
 */
export interface GearHostConfig {
  /** Path to the Gear packages directory. */
  gearPackagesDir: string;
  /** Workspace path for Gear file operations. */
  workspacePath: string;
  /** Logger instance. */
  logger?: SandboxLogger;
  /** Callback for progress updates. */
  onProgress?: ProgressCallback;
  /** Callback for log messages from Gear. */
  onLog?: LogCallback;
  /** Callback for sub-job requests from Gear. */
  onSubJob?: SubJobCallback;
  /** Callback for system command requests from Gear. */
  onCommand?: CommandCallback;
  /** Function to retrieve the stored checksum for a Gear. */
  getStoredChecksum: (gearId: string) => Promise<string>;
  /** Function to disable a Gear in the registry. */
  disableGear: (gearId: string) => Promise<void>;
  /** Function to retrieve secrets for a Gear. */
  getSecrets?: (gearId: string, secretNames: string[]) => Promise<Map<string, Buffer>>;
  /**
   * Enable Ed25519 ephemeral keypair signing for Gear communication (v0.2).
   * When true, each Gear execution gets a fresh Ed25519 keypair.
   */
  useEd25519?: boolean;
  /**
   * Callback to register an ephemeral public key with the signing service.
   * Called when a Gear execution starts. The key should be removed when
   * the execution completes (handled by GearHost).
   */
  onEphemeralKeyRegistered?: (gearComponentId: ComponentId, publicKey: Buffer) => void;
  /**
   * Callback to unregister an ephemeral public key after execution completes.
   */
  onEphemeralKeyRemoved?: (gearComponentId: ComponentId) => void;
}

// ---------------------------------------------------------------------------
// GearHost
// ---------------------------------------------------------------------------

/**
 * GearHost manages the execution of Gear actions in sandbox processes.
 *
 * Responsibilities:
 * 1. Integrity check: re-compute SHA-256 before execution
 * 2. Sandbox lifecycle: create -> execute -> destroy
 * 3. Message protocol: JSON over stdin/stdout with HMAC-SHA256 (v0.1) or Ed25519 (v0.2)
 * 4. Ephemeral keypair management: generate, distribute, zero (v0.2)
 * 5. Timeout enforcement: SIGTERM -> grace period -> SIGKILL
 * 6. Output provenance tagging: wraps all Gear output with source tag
 */
export class GearHost {
  private readonly config: GearHostConfig;
  private readonly signingKey: Buffer;
  private activeSandboxes = new Map<string, SandboxHandle>();

  constructor(config: GearHostConfig) {
    this.config = config;
    this.signingKey = generateSigningKey();
  }

  /**
   * Execute a Gear action in a sandbox.
   *
   * Full flow:
   * 1. Verify Gear integrity (SHA-256 checksum)
   * 2. Resolve entry point
   * 3. Retrieve secrets (if declared)
   * 4. Generate ephemeral Ed25519 keypair (v0.2) or use HMAC (v0.1)
   * 5. Create sandbox process
   * 6. Send action request with signature
   * 7. Wait for response (with timeout), verify signature
   * 8. Wrap output with provenance tag
   * 9. Destroy sandbox, zero ephemeral keys
   */
  async execute(
    manifest: GearManifest,
    options: ExecuteActionOptions,
  ): Promise<Result<GearExecutionResult, string>> {
    const startTime = Date.now();
    const { gearId, action, parameters, correlationId, signal } = options;
    const logger = this.config.logger;

    // 1. Verify integrity
    const integrityResult = await this.verifyIntegrity(manifest);
    if (!integrityResult.ok) {
      return integrityResult;
    }

    // 2. Resolve entry point
    const entryPoint = this.resolveEntryPoint(gearId);

    // 3. Retrieve secrets if needed
    let secrets: Map<string, Buffer> | undefined;
    if (manifest.permissions.secrets && manifest.permissions.secrets.length > 0 && this.config.getSecrets) {
      try {
        secrets = await this.config.getSecrets(gearId, manifest.permissions.secrets);
      } catch (e) {
        return err(`Failed to retrieve secrets for Gear '${gearId}': ${String(e)}`);
      }
    }

    // 4. Generate ephemeral keypair for Ed25519 (v0.2) or use HMAC
    let ephemeralKeypair: Ed25519Keypair | undefined;
    const gearComponentId: ComponentId = `gear:${gearId}`;

    if (this.config.useEd25519) {
      ephemeralKeypair = generateEphemeralKeypair();
      // Register the public key so the signing service can verify responses
      this.config.onEphemeralKeyRegistered?.(gearComponentId, ephemeralKeypair.publicKey);
    }

    // 5. Create sandbox
    const sandboxOptions: SandboxOptions = {
      entryPoint,
      manifest,
      signingKey: this.signingKey,
      workspacePath: this.config.workspacePath,
      secrets,
      logger,
      ephemeralKeypair,
    };

    const sandboxResult = createSandbox(sandboxOptions);
    if (!sandboxResult.ok) {
      if (ephemeralKeypair) {
        zeroPrivateKey(ephemeralKeypair);
        this.config.onEphemeralKeyRemoved?.(gearComponentId);
      }
      return err(sandboxResult.error);
    }

    const handle = sandboxResult.value;
    this.activeSandboxes.set(correlationId, handle);

    try {
      // 6. Execute action
      const timeout = manifest.resources?.timeoutMs ?? DEFAULT_GEAR_TIMEOUT_MS;
      const response = await this.sendAndWait(handle, {
        correlationId,
        action,
        parameters,
        timeout,
        signal,
      });

      if (!response.ok) {
        return err(response.error);
      }

      const durationMs = Date.now() - startTime;

      // 7. Check for Gear-level errors
      if (response.value.error) {
        return err(
          `Gear '${gearId}' action '${action}' failed: [${response.value.error.code}] ${response.value.error.message}`,
        );
      }

      // 8. Wrap output with provenance tag
      const result: GearExecutionResult = {
        result: {
          ...response.value.result,
          _provenance: {
            source: `gear:${gearId}`,
            action,
            correlationId,
            timestamp: new Date().toISOString(),
          },
        },
        source: `gear:${gearId}`,
        durationMs,
      };

      logger?.info('Gear action completed', {
        gearId,
        action,
        correlationId,
        durationMs,
      });

      return ok(result);
    } finally {
      // 9. Always destroy sandbox and clean up ephemeral keys
      this.activeSandboxes.delete(correlationId);
      await destroySandbox(handle, logger);
      if (this.config.useEd25519) {
        this.config.onEphemeralKeyRemoved?.(gearComponentId);
      }
    }
  }

  /**
   * Verify Gear package integrity by re-computing SHA-256 checksum
   * and comparing against the stored value in the registry.
   *
   * If checksum mismatch: disable Gear, return error.
   */
  private async verifyIntegrity(
    manifest: GearManifest,
  ): Promise<Result<void, string>> {
    const logger = this.config.logger;
    const entryPoint = this.resolveEntryPoint(manifest.id);

    try {
      const currentChecksum = await computeChecksum(entryPoint);
      const storedChecksum = await this.config.getStoredChecksum(manifest.id);

      if (currentChecksum !== storedChecksum) {
        logger?.error('Gear integrity check failed: checksum mismatch', {
          gearId: manifest.id,
          expected: storedChecksum,
          actual: currentChecksum,
        });

        // Disable the Gear
        try {
          await this.config.disableGear(manifest.id);
        } catch (e) {
          logger?.error('Failed to disable tampered Gear', {
            gearId: manifest.id,
            error: String(e),
          });
        }

        return err(
          `Gear '${manifest.id}' integrity check failed: checksum mismatch. Gear has been disabled.`,
        );
      }

      return ok(undefined);
    } catch (e) {
      return err(`Integrity check failed for Gear '${manifest.id}': ${String(e)}`);
    }
  }

  /**
   * Resolve the entry point path for a Gear.
   * Convention: gear packages are at <gearPackagesDir>/<gearId>/index.js.
   * Existence is validated later by createSandbox (avoids TOCTOU).
   */
  private resolveEntryPoint(gearId: string): string {
    return `${this.config.gearPackagesDir}/${gearId}/index.js`;
  }

  /**
   * Send an action request to the sandbox and wait for the response.
   * Enforces timeout with SIGTERM -> grace -> SIGKILL.
   */
  private async sendAndWait(
    handle: SandboxHandle,
    options: {
      correlationId: string;
      action: string;
      parameters: Record<string, unknown>;
      timeout: number;
      signal?: AbortSignal;
    },
  ): Promise<Result<SandboxResponse, string>> {
    const { correlationId, action, parameters, timeout, signal } = options;
    const logger = this.config.logger;
    const child = handle.process;
    const stdin = child.stdin;
    const stdout = child.stdout;

    if (!stdin || !stdout) {
      return err('Sandbox process stdin/stdout not available');
    }

    // Build and sign request
    let request: SandboxRequest;

    if (handle.ephemeralKeypair) {
      // v0.2: Ed25519 signing with ephemeral keypair
      request = signSandboxRequest(
        { correlationId, action, parameters },
        handle.ephemeralKeypair.privateKey,
        handle.manifest.id,
      );
    } else {
      // v0.1 fallback: HMAC-SHA256 signing
      const requestPayload: Omit<SandboxRequest, 'hmac'> = {
        correlationId,
        action,
        parameters,
      };
      const hmac = signMessage(requestPayload as Record<string, unknown>, handle.signingKey);
      request = { ...requestPayload, hmac };
    }

    return new Promise<Result<SandboxResponse, string>>((resolve) => {
      let settled = false;
      let dataBuffer = '';

      const settle = (result: Result<SandboxResponse, string>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdout.removeListener('data', onData);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve(result);
      };

      // Handle stdout data (line-delimited JSON)
      const onData = (chunk: Buffer): void => {
        dataBuffer += chunk.toString('utf-8');

        // Process complete lines
        let newlineIdx: number;
        while ((newlineIdx = dataBuffer.indexOf('\n')) !== -1) {
          const line = dataBuffer.slice(0, newlineIdx).trim();
          dataBuffer = dataBuffer.slice(newlineIdx + 1);

          if (!line) continue;

          try {
            const message = JSON.parse(line) as Record<string, unknown>;

            // Handle progress messages
            if (message['type'] === 'progress') {
              const progress = message as unknown as SandboxProgress;
              this.config.onProgress?.(progress.percent, progress.message);
              continue;
            }

            // Handle log messages from Gear
            if (message['type'] === 'log') {
              const gearId = message['gearId'] as string;
              const logMessage = message['message'] as string;
              this.config.onLog?.(gearId, logMessage);
              continue;
            }

            // Handle sub-job requests from Gear (fire-and-forget in v0.1)
            if (message['type'] === 'subjob') {
              const description = message['description'] as string;
              const requestId = message['requestId'] as string;
              this.config.onSubJob?.(description, requestId);
              continue;
            }

            // Handle command requests from Gear (v0.2)
            if (message['type'] === 'command') {
              const command = message['command'] as string;
              const cmdParams = message['params'] as Record<string, unknown>;
              const requestId = message['requestId'] as string;
              if (this.config.onCommand) {
                void this.config.onCommand(command, cmdParams).then((result) => {
                  const response = JSON.stringify({
                    type: 'command_response',
                    requestId,
                    result,
                  });
                  try {
                    stdin.write(response + '\n');
                  } catch {
                    // Sandbox already closed
                  }
                }).catch((cmdError: unknown) => {
                  const response = JSON.stringify({
                    type: 'command_response',
                    requestId,
                    error: cmdError instanceof Error ? cmdError.message : String(cmdError),
                  });
                  try {
                    stdin.write(response + '\n');
                  } catch {
                    // Sandbox already closed
                  }
                });
              } else {
                const response = JSON.stringify({
                  type: 'command_response',
                  requestId,
                  error: 'Command execution not supported',
                });
                try {
                  stdin.write(response + '\n');
                } catch {
                  // Sandbox already closed
                }
              }
              continue;
            }

            // Handle response
            const response = message as unknown as SandboxResponse;
            if (response.correlationId !== correlationId) {
              logger?.warn('Received response with wrong correlationId', {
                expected: correlationId,
                received: response.correlationId,
              });
              continue;
            }

            // Verify response signature
            if (handle.ephemeralKeypair && response.hmac === 'ed25519' && response.envelope) {
              // v0.2: Ed25519 signature verification
              const valid = verifySandboxResponseSignature(response, handle.ephemeralKeypair.publicKey);
              if (!valid) {
                settle(err('Response Ed25519 signature verification failed'));
                return;
              }
            } else {
              // v0.1 fallback: HMAC-SHA256 verification
              // The sandbox runtime does not have the signing key in v0.1, so it
              // sends hmac: 'unsigned'. Accept this for v0.1 with a warning.
              const { hmac: responseHmac, envelope: _envelope, ...payload } = response;
              if (responseHmac === 'unsigned') {
                logger?.warn('Accepting unsigned response from sandbox (v0.1 limitation)', {
                  correlationId,
                });
              } else if (responseHmac !== 'ed25519' && !verifySignature(payload as Record<string, unknown>, responseHmac, handle.signingKey)) {
                settle(err('Response HMAC verification failed'));
                return;
              }
            }

            settle(ok(response));
          } catch {
            // Not valid JSON — could be console output, skip
            logger?.warn('Non-JSON output from Gear', { line });
          }
        }
      };

      const onExit = (code: number | null): void => {
        settle(err(`Sandbox process exited unexpectedly with code ${String(code)}`));
      };

      const onError = (e: Error): void => {
        settle(err(`Sandbox process error: ${e.message}`));
      };

      const onAbort = (): void => {
        settle(err('Gear execution cancelled'));
        if (!handle.destroyed) {
          void destroySandbox(handle, logger);
        }
      };

      // Wire up listeners
      stdout.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Set timeout
      const timer = setTimeout(() => {
        settle(err(`Gear action timed out after ${timeout}ms`));
        if (!handle.destroyed) {
          void destroySandbox(handle, logger);
        }
      }, timeout);

      // Send request
      try {
        stdin.write(JSON.stringify(request) + '\n');
      } catch (writeErr) {
        settle(err(`Failed to write to sandbox stdin: ${String(writeErr)}`));
      }
    });
  }

  /**
   * Kill all active sandboxes. Called during graceful shutdown.
   */
  async shutdown(): Promise<void> {
    const logger = this.config.logger;
    const promises: Promise<void>[] = [];

    for (const [correlationId, handle] of this.activeSandboxes) {
      logger?.info('Shutting down active sandbox', {
        correlationId,
        gearId: handle.manifest.id,
      });
      promises.push(destroySandbox(handle, logger));
    }

    await Promise.all(promises);
    this.activeSandboxes.clear();

    // Zero the signing key
    this.signingKey.fill(0);

    logger?.info('GearHost shutdown complete');
  }

  /**
   * Get the number of currently active sandboxes.
   */
  get activeSandboxCount(): number {
    return this.activeSandboxes.size;
  }
}
