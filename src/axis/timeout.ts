// @meridian/axis — Nested timeout hierarchy with AbortSignal composition
// Architecture Reference: Section 5.1.10
//
// Timeout hierarchy:
//   Job timeout (default: 300s)
//   ├── Planning timeout (default: 60s)
//   │   └── LLM call timeout (30s first token, 30s stall)
//   ├── Validation timeout (default: 30s)
//   │   └── LLM call timeout
//   └── Execution timeout (remaining budget)
//       └── Step timeout (per step, default: 60s)
//
// Each inner timeout is capped by the remaining parent budget.
// Cancellation protocol: signal → 5s grace → force kill.

import { TimeoutError } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace period between cancellation signal and force kill (ms). */
const CANCELLATION_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// TimeoutBudget — tracks remaining time from a parent budget
// ---------------------------------------------------------------------------

/**
 * A budget that tracks remaining time from a parent allocation.
 * Inner timeouts are capped by whatever time remains in the budget.
 */
export class TimeoutBudget {
  private readonly startedAt: number;
  private readonly totalMs: number;
  private readonly label: string;

  constructor(totalMs: number, label: string, now: () => number = Date.now) {
    this.startedAt = now();
    this.totalMs = totalMs;
    this.label = label;
  }

  /**
   * Get the elapsed time since the budget started.
   */
  elapsed(now: () => number = Date.now): number {
    return now() - this.startedAt;
  }

  /**
   * Get the remaining time in the budget.
   * Returns 0 if the budget is exhausted.
   */
  remaining(now: () => number = Date.now): number {
    return Math.max(0, this.totalMs - this.elapsed(now));
  }

  /**
   * Check if the budget is exhausted.
   */
  isExpired(now: () => number = Date.now): boolean {
    return this.remaining(now) <= 0;
  }

  /**
   * Cap a requested timeout by the remaining budget.
   * Returns the minimum of the requested timeout and remaining budget.
   *
   * @throws TimeoutError if the budget is already exhausted.
   */
  cap(requestedMs: number, phaseLabel: string, now: () => number = Date.now): number {
    const rem = this.remaining(now);
    if (rem <= 0) {
      throw new TimeoutError(
        `${this.label} budget exhausted before ${phaseLabel} could start`,
      );
    }
    return Math.min(requestedMs, rem);
  }

  /**
   * Get the budget label (for diagnostics).
   */
  getLabel(): string {
    return this.label;
  }

  /**
   * Get the total budget in milliseconds.
   */
  getTotalMs(): number {
    return this.totalMs;
  }
}

// ---------------------------------------------------------------------------
// AbortSignal composition
// ---------------------------------------------------------------------------

/**
 * Create a composite AbortSignal that aborts when ANY of the provided
 * signals abort, or when the timeout expires — whichever comes first.
 *
 * Returns both the signal and a cleanup function to prevent leaks.
 */
export function createCompositeSignal(
  timeoutMs: number,
  parentSignals: AbortSignal[] = [],
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const cleanupFns: (() => void)[] = [];

  // Timeout leg
  const timer = setTimeout(() => {
    controller.abort(
      new TimeoutError(`Operation timed out after ${timeoutMs}ms`),
    );
  }, timeoutMs);
  cleanupFns.push(() => { clearTimeout(timer); });

  // Parent signal legs
  for (const parent of parentSignals) {
    if (parent.aborted) {
      // Parent already aborted — abort immediately
      controller.abort(parent.reason as Error);
      break;
    }

    const onAbort = (): void => {
      controller.abort(parent.reason as Error);
    };
    parent.addEventListener('abort', onAbort, { once: true });
    cleanupFns.push(() => { parent.removeEventListener('abort', onAbort); });
  }

  const cleanup = (): void => {
    for (const fn of cleanupFns) {
      fn();
    }
  };

  return { signal: controller.signal, cleanup };
}

// ---------------------------------------------------------------------------
// Phase timeout runner
// ---------------------------------------------------------------------------

/**
 * Options for running a timed operation.
 */
export interface TimedOperationOptions<T> {
  /** The operation to run. Receives an AbortSignal to observe. */
  operation: (signal: AbortSignal) => Promise<T>;
  /** Timeout in milliseconds for this operation. */
  timeoutMs: number;
  /** Human-readable label for error messages. */
  label: string;
  /** Optional parent AbortSignals to compose with. */
  parentSignals?: AbortSignal[];
  /** Optional budget to cap the timeout against. */
  budget?: TimeoutBudget;
  /** Clock function for testing. */
  now?: () => number;
}

/**
 * Run an operation with a timeout, optionally capped by a parent budget.
 *
 * If the budget is provided, the effective timeout is
 * `min(timeoutMs, budget.remaining())`.
 *
 * @throws TimeoutError if the operation exceeds its timeout.
 */
export async function runWithTimeout<T>(
  options: TimedOperationOptions<T>,
): Promise<T> {
  const {
    operation,
    timeoutMs,
    label,
    parentSignals = [],
    budget,
    now = Date.now,
  } = options;

  // Cap timeout by budget if provided
  const effectiveTimeout = budget
    ? budget.cap(timeoutMs, label, now)
    : timeoutMs;

  const { signal, cleanup } = createCompositeSignal(effectiveTimeout, parentSignals);

  // Race the operation against the abort signal.
  // This ensures the timeout fires even if the operation doesn't observe the signal.
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : new TimeoutError(String(signal.reason));
      reject(reason);
      return;
    }
    signal.addEventListener('abort', () => {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : new TimeoutError(String(signal.reason));
      reject(reason);
    }, { once: true });
  });

  try {
    const result = await Promise.race([operation(signal), abortPromise]);
    return result;
  } catch (error: unknown) {
    // Re-throw timeout errors with a descriptive label
    if (error instanceof TimeoutError) {
      throw error;
    }
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      if (reason instanceof TimeoutError) {
        throw reason;
      }
      // Parent signal was the cause (could be a cancellation)
      throw new TimeoutError(
        `${label} aborted: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
    throw error;
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Cancellation protocol
// ---------------------------------------------------------------------------

/**
 * Cancellation handler that implements the signal → grace → force kill protocol.
 *
 * 1. Signal the operation via AbortController.
 * 2. Wait up to `graceMs` for the operation to observe the signal and stop.
 * 3. If still running, invoke the `forceKill` callback.
 */
export interface CancellationProtocolOptions {
  /** The controller to signal. */
  controller: AbortController;
  /** Grace period in milliseconds before force kill. */
  graceMs?: number;
  /** Callback to force-kill the operation after grace period. */
  forceKill: () => void;
  /** Promise that resolves when the operation finishes (or rejects). */
  operationDone: Promise<unknown>;
}

/**
 * Execute the cancellation protocol: signal → grace → force kill.
 *
 * @returns true if the operation stopped within the grace period, false if force-killed.
 */
export async function cancelWithGrace(
  options: CancellationProtocolOptions,
): Promise<boolean> {
  const {
    controller,
    graceMs = CANCELLATION_GRACE_MS,
    forceKill,
    operationDone,
  } = options;

  // Step 1: Signal the operation
  controller.abort(new TimeoutError('Operation cancelled'));

  // Step 2: Race the operation against the grace timer
  let graceful = true;

  const graceTimer = new Promise<'timeout'>((resolve) => {
    setTimeout(() => { resolve('timeout'); }, graceMs);
  });

  const result = await Promise.race([
    operationDone.then(() => 'done' as const).catch(() => 'done' as const),
    graceTimer,
  ]);

  if (result === 'timeout') {
    // Step 3: Force kill
    graceful = false;
    forceKill();
  }

  return graceful;
}

// ---------------------------------------------------------------------------
// Job-level timeout orchestration
// ---------------------------------------------------------------------------

/**
 * Configuration for the job timeout hierarchy.
 */
export interface JobTimeoutConfig {
  /** Overall job timeout in milliseconds. */
  jobTimeoutMs: number;
  /** Planning phase timeout in milliseconds. */
  planningTimeoutMs: number;
  /** Validation phase timeout in milliseconds. */
  validationTimeoutMs: number;
  /** Per-step execution timeout in milliseconds. */
  stepTimeoutMs: number;
}

/**
 * Create a job-level timeout budget with phase-level sub-budgets.
 *
 * The job budget tracks overall remaining time. Each phase gets
 * a sub-timeout capped by the remaining job budget.
 */
export function createJobBudget(
  config: JobTimeoutConfig,
  now: () => number = Date.now,
): {
  budget: TimeoutBudget;
  getPhaseTimeout: (phase: 'planning' | 'validation' | 'step') => number;
} {
  const budget = new TimeoutBudget(config.jobTimeoutMs, 'job', now);

  const phaseDefaults: Record<'planning' | 'validation' | 'step', number> = {
    planning: config.planningTimeoutMs,
    validation: config.validationTimeoutMs,
    step: config.stepTimeoutMs,
  };

  return {
    budget,
    getPhaseTimeout: (phase: 'planning' | 'validation' | 'step'): number => {
      return budget.cap(phaseDefaults[phase], phase, now);
    },
  };
}

/**
 * Compute the remaining execution budget for a job.
 *
 * The execution phase gets whatever time remains in the job budget
 * after planning and validation phases have consumed their share.
 */
export function getExecutionBudget(
  budget: TimeoutBudget,
  now: () => number = Date.now,
): number {
  return budget.remaining(now);
}
