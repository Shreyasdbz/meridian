// @meridian/gear — Isolate sandbox (Level 2 — isolated-vm) (Phase 10.4)
//
// Uses `isolated-vm` (optional dependency) for V8-level isolation.
// No Node.js APIs unless explicitly bridged. Memory/CPU limits via V8.
// Falls back to Level 1 (process sandbox) if isolated-vm is unavailable.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IsolateSandboxOptions {
  /** Maximum heap size in MB. Default: 128. */
  memoryLimitMb?: number;
  /** Execution timeout in milliseconds. Default: 30000. */
  timeoutMs?: number;
  /** Logger. */
  logger?: IsolateSandboxLogger;
}

export interface IsolateSandboxLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface IsolateHandle {
  isolate: unknown; // ivm.Isolate
  context: unknown; // ivm.Context
  disposed: boolean;
}

export interface IsolateExecutionResult {
  result: unknown;
  durationMs: number;
  heapUsedMb: number;
}

// ---------------------------------------------------------------------------
// Local type surface for isolated-vm (optional dependency, no @types available)
// ---------------------------------------------------------------------------

interface IvmHeapStatistics {
  used_heap_size: number;
  total_heap_size: number;
}

interface IvmScript {
  run(context: IvmContext, options?: { timeout: number }): Promise<unknown>;
}

type IvmContext = Record<string, unknown>;

interface IvmIsolate {
  createContext(): Promise<IvmContext>;
  compileScript(code: string): Promise<IvmScript>;
  getHeapStatisticsSync(): IvmHeapStatistics;
  dispose(): void;
}

interface IvmModule {
  Isolate: new (options: { memoryLimit: number }) => IvmIsolate;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MEMORY_LIMIT_MB = 128;
const DEFAULT_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

let isolatedVmAvailableCache: boolean | undefined;

/**
 * Check if isolated-vm is available.
 */
export async function isIsolatedVmAvailable(): Promise<boolean> {
  if (isolatedVmAvailableCache !== undefined) {
    return isolatedVmAvailableCache;
  }

  try {
    // @ts-expect-error — isolated-vm is an optional dependency
    await import('isolated-vm');
    isolatedVmAvailableCache = true;
    return true;
  } catch {
    isolatedVmAvailableCache = false;
    return false;
  }
}

/**
 * Reset the availability cache (for testing).
 */
export function resetIsolatedVmCache(): void {
  isolatedVmAvailableCache = undefined;
}

// ---------------------------------------------------------------------------
// Isolate lifecycle
// ---------------------------------------------------------------------------

/**
 * Create an isolated-vm sandbox.
 * Throws if isolated-vm is not available.
 */
export async function createIsolateSandbox(
  options: IsolateSandboxOptions = {},
): Promise<IsolateHandle> {
  const { memoryLimitMb = DEFAULT_MEMORY_LIMIT_MB, logger } = options;

  // Dynamic import — isolated-vm is an optional dependency
  // @ts-expect-error — isolated-vm is an optional dependency
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const ivm: IvmModule = await import('isolated-vm');

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  const context = await isolate.createContext();

  logger?.info('Isolate sandbox created', { memoryLimitMb });

  return {
    isolate,
    context,
    disposed: false,
  };
}

/**
 * Execute code in an isolate sandbox.
 */
export async function executeInIsolate(
  handle: IsolateHandle,
  code: string,
  options: IsolateSandboxOptions = {},
): Promise<IsolateExecutionResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (handle.disposed) {
    throw new Error('Isolate has been disposed');
  }

  const isolate = handle.isolate as IvmIsolate;
  const context = handle.context as IvmContext;

  const startTime = Date.now();

  const script = await isolate.compileScript(code);
  const result = await script.run(context, { timeout: timeoutMs });

  const durationMs = Date.now() - startTime;
  const heapStats = isolate.getHeapStatisticsSync();
  const heapUsedMb = heapStats.used_heap_size / (1024 * 1024);

  return {
    result,
    durationMs,
    heapUsedMb,
  };
}

/**
 * Dispose an isolate sandbox, releasing all resources.
 */
export function disposeIsolateSandbox(
  handle: IsolateHandle,
  logger?: IsolateSandboxLogger,
): void {
  if (handle.disposed) {
    return;
  }

  try {
    (handle.isolate as IvmIsolate).dispose();
    handle.disposed = true;
    logger?.info('Isolate sandbox disposed');
  } catch (error) {
    logger?.error('Failed to dispose isolate sandbox', {
      error: error instanceof Error ? error.message : String(error),
    });
    handle.disposed = true;
  }
}
