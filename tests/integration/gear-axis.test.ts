// Phase 5.7 Integration Test — Gear ↔ Axis
//
// Tests that the Gear runtime registers with Axis and correctly handles
// execute.request messages dispatched through the message router.
// Verifies the full lifecycle: registry lookup, integrity check, sandbox
// creation/destruction, result collection, and error propagation.
//
// Architecture references:
// - Section 5.1.14 (Startup Sequence — Component Registration)
// - Section 5.6 (Gear — Plugin System)
// - Section 9.1 (AxisMessage schema)

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { Axis, JobProcessor } from '@meridian/axis';
import { createAxis } from '@meridian/axis';
import {
  createGearRuntime,
  computeChecksum,
  GEAR_RUNTIME_ID,
} from '@meridian/gear';
import type { GearRuntime } from '@meridian/gear';
import {
  DatabaseClient,
  generateId,
  getDefaultConfig,
  migrate,
} from '@meridian/shared';
import type {
  AxisMessage,
  GearManifest,
  MeridianConfig,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

let tempDir: string;
let dataDir: string;
let gearPackagesDir: string;
let workspacePath: string;
let db: DatabaseClient;
let axis: Axis | undefined;
let gearRuntime: GearRuntime | undefined;

function makeConfig(): MeridianConfig {
  const config = getDefaultConfig('desktop');
  return {
    ...config,
    axis: {
      ...config.axis,
      workers: 1,
    },
    bridge: {
      ...config.bridge,
      port: 40000 + Math.floor(Math.random() * 10000),
    },
  };
}

const noopProcessor: JobProcessor = async () => {};

/**
 * Build an execute.request message addressed to gear:runtime.
 */
function buildExecuteRequest(
  gearId: string,
  action: string,
  parameters: Record<string, unknown> = {},
  extra?: Partial<AxisMessage>,
): AxisMessage {
  const id = generateId();
  return {
    id,
    correlationId: id,
    timestamp: new Date().toISOString(),
    from: 'bridge',
    to: GEAR_RUNTIME_ID,
    type: 'execute.request',
    jobId: generateId(),
    payload: {
      gear: gearId,
      action,
      parameters,
      stepId: 'step-001',
    },
    ...extra,
  };
}

/**
 * Create a minimal test Gear manifest.
 */
function createTestManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'test-echo-gear',
    name: 'Test Echo Gear',
    version: '1.0.0',
    description: 'A test Gear that echoes parameters back',
    author: 'Meridian',
    license: 'Apache-2.0',
    origin: 'user',
    checksum: 'placeholder',
    actions: [
      {
        name: 'echo',
        description: 'Echo parameters back',
        parameters: { type: 'object', properties: {} },
        returns: { type: 'object', properties: {} },
        riskLevel: 'low',
      },
    ],
    permissions: {},
    ...overrides,
  };
}

/**
 * Write a Gear that reads from stdin and echoes the parameters back.
 * Returns the entry point path.
 */
function writeEchoGear(gearId: string): string {
  const gearDir = join(gearPackagesDir, gearId);
  mkdirSync(gearDir, { recursive: true });
  const entryPoint = join(gearDir, 'index.js');

  writeFileSync(entryPoint, `
    process.stdin.setEncoding('utf-8');
    let buffer = '';

    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        try {
          const request = JSON.parse(line);
          const { correlationId, action, parameters } = request;
          const response = {
            correlationId,
            result: { echoed: parameters, action },
            hmac: 'unsigned',
          };
          process.stdout.write(JSON.stringify(response) + '\\n');
        } catch (e) {
          // ignore parse errors
        }
      }
    });

    process.stdin.resume();
  `);

  return entryPoint;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'meridian-test-gear-axis-'));
  dataDir = join(tempDir, 'data');
  gearPackagesDir = join(tempDir, 'gear-packages');
  workspacePath = join(tempDir, 'workspace');

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(gearPackagesDir, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });

  db = new DatabaseClient({ dataDir, direct: true });
  await db.start();
  await db.open('meridian');
  await migrate(db, 'meridian', PROJECT_ROOT);
});

afterEach(async () => {
  if (gearRuntime) {
    try {
      await gearRuntime.shutdown();
      gearRuntime.dispose();
    } catch {
      // Best-effort
    }
    gearRuntime = undefined;
  }

  if (axis) {
    try {
      await axis.stop();
    } catch {
      // Best-effort
    }
    axis = undefined;
  }

  await db.close();

  try {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests: Registration
// ---------------------------------------------------------------------------

describe('Gear ↔ Axis integration', () => {
  describe('registration', () => {
    it('should register gear:runtime as a message handler with Axis', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [], // No built-ins for this test
        },
        { registry: axis.internals.registry },
      );

      expect(axis.internals.registry.has(GEAR_RUNTIME_ID)).toBe(true);
    });

    it('should unregister gear:runtime on dispose', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      expect(axis.internals.registry.has(GEAR_RUNTIME_ID)).toBe(true);

      gearRuntime.dispose();
      gearRuntime = undefined; // prevent double-dispose in afterEach

      expect(axis.internals.registry.has(GEAR_RUNTIME_ID)).toBe(false);
    });

    it('should be idempotent on multiple dispose calls', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      gearRuntime.dispose();
      // Second dispose should not throw
      const gr = gearRuntime;
      expect(() => { gr.dispose(); }).not.toThrow();
      gearRuntime = undefined;
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Built-in auto-registration
  // ---------------------------------------------------------------------------

  describe('built-in auto-registration', () => {
    it('should register built-in Gear in the registry during startup', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const builtinManifest = createTestManifest({
        id: 'test-builtin',
        name: 'Test Builtin',
        origin: 'builtin',
        checksum: 'builtin',
      });

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [builtinManifest],
        },
        { registry: axis.internals.registry },
      );

      // Should be in registry and cache
      const manifest = gearRuntime.gearRegistry.getManifest('test-builtin');
      expect(manifest).toBeDefined();
      expect(manifest?.name).toBe('Test Builtin');
    });

    it('should load cache with enabled Gear after startup', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const builtinManifests = [
        createTestManifest({
          id: 'builtin-a',
          name: 'Builtin A',
          origin: 'builtin',
          checksum: 'builtin',
        }),
        createTestManifest({
          id: 'builtin-b',
          name: 'Builtin B',
          origin: 'builtin',
          checksum: 'builtin',
        }),
      ];

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests,
        },
        { registry: axis.internals.registry },
      );

      expect(gearRuntime.gearRegistry.cacheSize).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: execute.request → execute.response
  // ---------------------------------------------------------------------------

  describe('execute.request dispatched through Axis', () => {
    it('should execute a Gear action and return results', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      // Write echo gear and compute checksum
      const entryPoint = writeEchoGear('test-echo-gear');
      const checksum = await computeChecksum(entryPoint);

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      // Install the test gear into the registry
      const manifest = createTestManifest({ checksum });
      const installResult = await gearRuntime.gearRegistry.install(
        manifest,
        entryPoint,
      );
      expect(installResult.ok).toBe(true);

      // Build and dispatch execute.request through Axis
      const request = buildExecuteRequest('test-echo-gear', 'echo', {
        hello: 'world',
      });
      const response = await axis.internals.router.dispatch(request);

      // Verify response structure
      expect(response.type).toBe('execute.response');
      expect(response.from).toBe('gear:test-echo-gear');
      expect(response.to).toBe('bridge');
      expect(response.correlationId).toBe(request.correlationId);
      expect(response.replyTo).toBe(request.id);
      expect(response.jobId).toBe(request.jobId);

      // Verify result payload
      const payload = response.payload as Record<string, unknown>;
      expect(payload['error']).toBeUndefined();
      expect(payload['source']).toBe('gear:test-echo-gear');
      expect(typeof payload['durationMs']).toBe('number');
      expect(payload['stepId']).toBe('step-001');

      // Verify echoed result with provenance
      const result = payload['result'] as Record<string, unknown>;
      expect(result['echoed']).toEqual({ hello: 'world' });
      expect(result['action']).toBe('echo');
      expect(result['_provenance']).toBeDefined();
    });

    it('should return results correctly with provenance tagging', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const entryPoint = writeEchoGear('provenance-gear');
      const checksum = await computeChecksum(entryPoint);

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const manifest = createTestManifest({
        id: 'provenance-gear',
        checksum,
      });
      await gearRuntime.gearRegistry.install(manifest, entryPoint);

      const request = buildExecuteRequest('provenance-gear', 'echo', {
        data: 42,
      });
      const response = await axis.internals.router.dispatch(request);

      const payload = response.payload as Record<string, unknown>;
      const result = payload['result'] as Record<string, unknown>;
      const provenance = result['_provenance'] as Record<string, unknown>;

      expect(provenance['source']).toBe('gear:provenance-gear');
      expect(provenance['action']).toBe('echo');
      expect(provenance['correlationId']).toBe(request.correlationId);
      expect(typeof provenance['timestamp']).toBe('string');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Sandbox lifecycle
  // ---------------------------------------------------------------------------

  describe('sandbox created and destroyed', () => {
    it('should have zero active sandboxes after execution completes', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const entryPoint = writeEchoGear('sandbox-lifecycle-gear');
      const checksum = await computeChecksum(entryPoint);

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const manifest = createTestManifest({
        id: 'sandbox-lifecycle-gear',
        checksum,
      });
      await gearRuntime.gearRegistry.install(manifest, entryPoint);

      const request = buildExecuteRequest('sandbox-lifecycle-gear', 'echo', {});
      await axis.internals.router.dispatch(request);

      // After execution, sandbox should be cleaned up
      expect(gearRuntime.gearHost.activeSandboxCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Integrity check failure
  // ---------------------------------------------------------------------------

  describe('integrity check failure blocks execution', () => {
    it('should return error and disable Gear when checksum mismatches', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      // Write the echo gear
      const entryPoint = writeEchoGear('tampered-gear');
      const checksum = await computeChecksum(entryPoint);

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const manifest = createTestManifest({
        id: 'tampered-gear',
        checksum,
      });
      await gearRuntime.gearRegistry.install(manifest, entryPoint);

      // Now tamper with the file
      writeFileSync(entryPoint, 'console.log("tampered");');

      // Dispatch execute.request
      const request = buildExecuteRequest('tampered-gear', 'echo', {});
      const response = await axis.internals.router.dispatch(request);

      // Should return execute.response with error
      expect(response.type).toBe('execute.response');
      const payload = response.payload as Record<string, unknown>;
      const error = payload['error'] as Record<string, unknown>;
      expect(error).toBeDefined();
      expect(error['code']).toBe('GEAR_EXECUTION_FAILED');
      expect((error['message'] as string)).toContain('checksum mismatch');

      // Gear should have been disabled
      const isEnabled = await gearRuntime.gearRegistry.isEnabled('tampered-gear');
      expect(isEnabled).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should return error for non-existent Gear', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const request = buildExecuteRequest('nonexistent-gear', 'do_thing', {});
      const response = await axis.internals.router.dispatch(request);

      expect(response.type).toBe('execute.response');
      const payload = response.payload as Record<string, unknown>;
      const error = payload['error'] as Record<string, unknown>;
      expect(error).toBeDefined();
      expect(error['code']).toBe('GEAR_NOT_FOUND');
      expect((error['message'] as string)).toContain('not found or disabled');
    });

    it('should return error for disabled Gear', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const entryPoint = writeEchoGear('disabled-gear');
      const checksum = await computeChecksum(entryPoint);

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const manifest = createTestManifest({
        id: 'disabled-gear',
        checksum,
      });
      await gearRuntime.gearRegistry.install(manifest, entryPoint);
      await gearRuntime.gearRegistry.disable('disabled-gear');

      const request = buildExecuteRequest('disabled-gear', 'echo', {});
      const response = await axis.internals.router.dispatch(request);

      const payload = response.payload as Record<string, unknown>;
      const error = payload['error'] as Record<string, unknown>;
      expect(error).toBeDefined();
      expect(error['code']).toBe('GEAR_NOT_FOUND');
    });

    it('should return error response for non-execute.request message types', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const wrongTypeMessage: AxisMessage = {
        id: generateId(),
        correlationId: generateId(),
        timestamp: new Date().toISOString(),
        from: 'bridge',
        to: GEAR_RUNTIME_ID,
        type: 'status.update', // Wrong type
        payload: { gear: 'test', action: 'test' },
      };

      // The router's error middleware wraps the ValidationError
      const response = await axis.internals.router.dispatch(wrongTypeMessage);
      expect(response.type).toBe('error');
    });

    it('should return error response when payload is missing', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const noPayloadMessage: AxisMessage = {
        id: generateId(),
        correlationId: generateId(),
        timestamp: new Date().toISOString(),
        from: 'bridge',
        to: GEAR_RUNTIME_ID,
        type: 'execute.request',
        // No payload
      };

      const response = await axis.internals.router.dispatch(noPayloadMessage);
      expect(response.type).toBe('error');
    });

    it('should return error response when gear or action fields are missing', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const missingFieldsMessage: AxisMessage = {
        id: generateId(),
        correlationId: generateId(),
        timestamp: new Date().toISOString(),
        from: 'bridge',
        to: GEAR_RUNTIME_ID,
        type: 'execute.request',
        payload: { parameters: {} }, // Missing gear and action
      };

      const response = await axis.internals.router.dispatch(missingFieldsMessage);
      expect(response.type).toBe('error');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: GearLookup integration with plan validator
  // ---------------------------------------------------------------------------

  describe('GearLookup integration', () => {
    it('should provide GearRegistry as GearLookup for plan validation', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const entryPoint = writeEchoGear('lookup-gear');

      gearRuntime = await createGearRuntime(
        {
          db,
          gearPackagesDir,
          workspacePath,
          builtinManifests: [],
        },
        { registry: axis.internals.registry },
      );

      const manifest = createTestManifest({
        id: 'lookup-gear',
        checksum: 'test-checksum',
        actions: [
          {
            name: 'process',
            description: 'Process data',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
            },
            returns: { type: 'object', properties: {} },
            riskLevel: 'low',
          },
        ],
      });
      await gearRuntime.gearRegistry.install(manifest, entryPoint);

      // The gearRegistry satisfies GearLookup interface
      const lookup = gearRuntime.gearRegistry;
      const found = lookup.getManifest('lookup-gear');
      expect(found).toBeDefined();
      expect(found?.actions[0]?.name).toBe('process');

      // Non-existent returns undefined
      expect(lookup.getManifest('nonexistent')).toBeUndefined();
    });
  });
});
