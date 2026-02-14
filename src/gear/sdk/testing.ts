// @meridian/gear — Gear SDK Testing Utilities (Section 9.4)
// Test helpers for Gear developers to validate their Gear implementations.

import type { GearContext, GearManifest } from '@meridian/shared';
import { generateId } from '@meridian/shared';

import type { GearResult } from './types.js';

// ---------------------------------------------------------------------------
// Mock GearContext
// ---------------------------------------------------------------------------

/**
 * Create a mock GearContext for testing Gear handlers.
 *
 * All methods are functional no-ops by default. Override individual
 * methods or params by passing an overrides object.
 *
 * Usage:
 * ```ts
 * const ctx = createMockContext({
 *   params: { path: '/test/file.txt' },
 * });
 * const result = await myHandler(ctx);
 * expect(result.success).toBe(true);
 * ```
 */
export function createMockContext(
  overrides?: Partial<GearContext>,
): GearContext {
  const logs: string[] = [];
  const progressUpdates: Array<{ percent: number; message?: string }> = [];
  const writtenFiles: Map<string, Buffer> = new Map();

  const base: GearContext = {
    params: {},

    getSecret(_name: string): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },

    readFile(_path: string): Promise<Buffer> {
      return Promise.resolve(Buffer.from(''));
    },

    writeFile(path: string, content: Buffer): Promise<void> {
      writtenFiles.set(path, content);
      return Promise.resolve();
    },

    deleteFile(_path: string): Promise<void> {
      return Promise.resolve();
    },

    listFiles(_dir: string): Promise<string[]> {
      return Promise.resolve([]);
    },

    fetch(_url: string, _options?) {
      return Promise.resolve({
        status: 200,
        headers: {},
        body: '',
      });
    },

    log: (message: string): void => {
      logs.push(message);
    },

    progress: (percent: number, message?: string): void => {
      progressUpdates.push({ percent, message });
    },

    createSubJob(_description: string) {
      return Promise.resolve({
        jobId: generateId(),
        status: 'completed' as const,
        result: {},
      });
    },
  };

  // Apply overrides
  const context = { ...base, ...overrides };

  // Store test inspection data in a non-enumerable property
  // so tests can inspect what happened
  Object.defineProperty(context, '__test', {
    value: { logs, progressUpdates, writtenFiles },
    enumerable: false,
    configurable: false,
  });

  return context;
}

/**
 * Test inspection data attached to mock contexts.
 */
export interface MockContextTestData {
  logs: string[];
  progressUpdates: Array<{ percent: number; message?: string }>;
  writtenFiles: Map<string, Buffer>;
}

/**
 * Retrieve test inspection data from a mock context.
 * Returns null if the context is not a mock.
 */
export function getMockTestData(context: GearContext): MockContextTestData | null {
  const testData = (context as unknown as Record<string, unknown>)['__test'] as
    | MockContextTestData
    | undefined;
  return testData ?? null;
}

// ---------------------------------------------------------------------------
// Test manifest factory
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid GearManifest for testing.
 *
 * Returns a structurally valid manifest with sensible defaults.
 * Override individual fields as needed.
 *
 * Usage:
 * ```ts
 * const manifest = createTestManifest({
 *   id: 'my-test-gear',
 *   actions: [{ name: 'custom_action', ... }],
 * });
 * ```
 */
export function createTestManifest(
  overrides?: Partial<GearManifest>,
): GearManifest {
  return {
    id: 'test-gear',
    name: 'Test Gear',
    version: '1.0.0',
    description: 'A test Gear for unit testing',
    author: 'test',
    license: 'MIT',
    origin: 'user',
    checksum: 'test-checksum-000',
    actions: [
      {
        name: 'test_action',
        description: 'A test action',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
        returns: {
          type: 'object',
          properties: {
            output: { type: 'string' },
          },
        },
        riskLevel: 'low',
      },
    ],
    permissions: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Handler validation
// ---------------------------------------------------------------------------

/**
 * Result from validating a Gear handler.
 */
export interface HandlerValidationResult {
  success: boolean;
  result?: GearResult;
  error?: string;
}

/**
 * Validate a Gear handler against its manifest action.
 *
 * Creates a mock context with the provided test input, invokes the handler,
 * and verifies that:
 * 1. The handler does not throw
 * 2. The result matches the GearResult interface
 * 3. The action name exists in the manifest
 *
 * Usage:
 * ```ts
 * const result = await validateHandler(
 *   manifest,
 *   'read_file',
 *   readFileHandler,
 *   { path: '/test/file.txt' },
 * );
 * expect(result.success).toBe(true);
 * ```
 */
export async function validateHandler(
  manifest: GearManifest,
  actionName: string,
  handler: (context: GearContext) => Promise<unknown>,
  testInput: Record<string, unknown>,
): Promise<HandlerValidationResult> {
  // Verify the action exists in the manifest
  const action = manifest.actions.find((a) => a.name === actionName);
  if (!action) {
    return {
      success: false,
      error: `Action "${actionName}" not found in manifest for Gear "${manifest.id}"`,
    };
  }

  // Create mock context with test input
  const context = createMockContext({ params: testInput });

  try {
    const raw: unknown = await handler(context);

    // Validate result structure
    if (typeof raw !== 'object' || raw === null) {
      return {
        success: false,
        error: 'Handler must return a non-null object',
      };
    }

    const result = raw as Record<string, unknown>;

    if (typeof result['success'] !== 'boolean') {
      return {
        success: false,
        error: 'Handler result must include a boolean "success" field',
      };
    }

    if (result['data'] !== undefined && (typeof result['data'] !== 'object' || result['data'] === null)) {
      return {
        success: false,
        error: 'Handler result "data" must be an object if provided',
      };
    }

    if (result['error'] !== undefined && typeof result['error'] !== 'string') {
      return {
        success: false,
        error: 'Handler result "error" must be a string if provided',
      };
    }

    return {
      success: true,
      result: raw as GearResult,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Handler threw an exception: ${message}`,
    };
  }
}
