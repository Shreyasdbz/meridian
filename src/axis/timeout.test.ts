import { describe, it, expect, vi, afterEach } from 'vitest';

import { TimeoutError } from '@meridian/shared';

import {
  TimeoutBudget,
  createCompositeSignal,
  runWithTimeout,
  cancelWithGrace,
  createJobBudget,
  getExecutionBudget,
} from './timeout.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock clock that advances manually. */
function createMockClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

/** Create a promise that resolves after a given delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TimeoutBudget
// ---------------------------------------------------------------------------

describe('TimeoutBudget', () => {
  it('should report full remaining time at creation', () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(5000, 'test', clock.now);
    expect(budget.remaining(clock.now)).toBe(5000);
  });

  it('should track elapsed time', () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(5000, 'test', clock.now);
    clock.advance(2000);
    expect(budget.elapsed(clock.now)).toBe(2000);
    expect(budget.remaining(clock.now)).toBe(3000);
  });

  it('should report expired when time is exhausted', () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(5000, 'test', clock.now);
    clock.advance(5000);
    expect(budget.isExpired(clock.now)).toBe(true);
    expect(budget.remaining(clock.now)).toBe(0);
  });

  it('should not report expired before time is up', () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(5000, 'test', clock.now);
    clock.advance(4999);
    expect(budget.isExpired(clock.now)).toBe(false);
  });

  it('should clamp remaining to zero (never negative)', () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(5000, 'test', clock.now);
    clock.advance(10000);
    expect(budget.remaining(clock.now)).toBe(0);
  });

  describe('cap', () => {
    it('should return requested timeout when less than remaining', () => {
      const clock = createMockClock(1000);
      const budget = new TimeoutBudget(5000, 'test', clock.now);
      expect(budget.cap(3000, 'phase', clock.now)).toBe(3000);
    });

    it('should cap to remaining when requested exceeds remaining', () => {
      const clock = createMockClock(1000);
      const budget = new TimeoutBudget(5000, 'test', clock.now);
      clock.advance(3000);
      expect(budget.cap(5000, 'phase', clock.now)).toBe(2000);
    });

    it('should throw TimeoutError when budget is exhausted', () => {
      const clock = createMockClock(1000);
      const budget = new TimeoutBudget(5000, 'test', clock.now);
      clock.advance(5000);
      expect(() => budget.cap(1000, 'phase', clock.now)).toThrow(TimeoutError);
      expect(() => budget.cap(1000, 'phase', clock.now)).toThrow(
        /budget exhausted before phase could start/,
      );
    });
  });

  it('should return the label', () => {
    const budget = new TimeoutBudget(5000, 'job');
    expect(budget.getLabel()).toBe('job');
  });

  it('should return the total budget', () => {
    const budget = new TimeoutBudget(5000, 'job');
    expect(budget.getTotalMs()).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// createCompositeSignal
// ---------------------------------------------------------------------------

describe('createCompositeSignal', () => {
  it('should create an initially non-aborted signal', () => {
    const { signal, cleanup } = createCompositeSignal(5000);
    expect(signal.aborted).toBe(false);
    cleanup();
  });

  it('should abort when timeout expires', async () => {
    const { signal, cleanup } = createCompositeSignal(50);
    await delay(100);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(TimeoutError);
    cleanup();
  });

  it('should abort when parent signal aborts', () => {
    const parent = new AbortController();
    const { signal, cleanup } = createCompositeSignal(5000, [parent.signal]);
    expect(signal.aborted).toBe(false);
    parent.abort(new Error('parent cancelled'));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('should abort immediately if parent is already aborted', () => {
    const parent = new AbortController();
    parent.abort(new Error('already cancelled'));
    const { signal, cleanup } = createCompositeSignal(5000, [parent.signal]);
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('should compose multiple parent signals', () => {
    const parent1 = new AbortController();
    const parent2 = new AbortController();
    const { signal, cleanup } = createCompositeSignal(5000, [parent1.signal, parent2.signal]);
    expect(signal.aborted).toBe(false);
    parent2.abort(new Error('parent2 cancelled'));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('should clean up timer on cleanup call', async () => {
    const { signal, cleanup } = createCompositeSignal(50);
    cleanup();
    await delay(100);
    // Signal should NOT have aborted because timer was cleaned up
    expect(signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runWithTimeout
// ---------------------------------------------------------------------------

describe('runWithTimeout', () => {
  it('should return the operation result on success', async () => {
    const result = await runWithTimeout({
      operation: () => Promise.resolve(42),
      timeoutMs: 5000,
      label: 'test',
    });
    expect(result).toBe(42);
  });

  it('should throw TimeoutError when operation exceeds timeout', async () => {
    await expect(
      runWithTimeout({
        operation: async () => {
          await delay(200);
          return 'too late';
        },
        timeoutMs: 50,
        label: 'slow op',
      }),
    ).rejects.toThrow(TimeoutError);
  });

  it('should pass AbortSignal to the operation', async () => {
    let receivedSignal: AbortSignal | null = null;
    await runWithTimeout({
      operation: (signal) => {
        receivedSignal = signal;
        return Promise.resolve();
      },
      timeoutMs: 5000,
      label: 'test',
    });
    expect(receivedSignal).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked above
    expect(receivedSignal!.aborted).toBe(false);
  });

  it('should cap timeout by budget', async () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(100, 'job', clock.now);
    clock.advance(60);

    // Budget remaining = 40ms, requested = 5000ms, effective = 40ms
    await expect(
      runWithTimeout({
        operation: async () => {
          await delay(200);
          return 'too late';
        },
        timeoutMs: 5000,
        label: 'capped op',
        budget,
        now: clock.now,
      }),
    ).rejects.toThrow(TimeoutError);
  });

  it('should throw when budget is already exhausted', async () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(100, 'job', clock.now);
    clock.advance(100);

    await expect(
      runWithTimeout({
        operation: () => Promise.resolve(42),
        timeoutMs: 5000,
        label: 'too late',
        budget,
        now: clock.now,
      }),
    ).rejects.toThrow(/budget exhausted/);
  });

  it('should abort when parent signal fires', async () => {
    const parent = new AbortController();

    const promise = runWithTimeout({
      operation: async (signal) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const reason = signal.reason instanceof Error
              ? signal.reason
              : new Error(String(signal.reason));
            reject(reason);
          }, { once: true });
        });
      },
      timeoutMs: 5000,
      label: 'parent cancel',
      parentSignals: [parent.signal],
    });

    parent.abort(new Error('user cancelled'));

    await expect(promise).rejects.toThrow(TimeoutError);
  });

  it('should propagate non-timeout errors from the operation', async () => {
    await expect(
      runWithTimeout({
        operation: () => Promise.reject(new Error('business logic failure')),
        timeoutMs: 5000,
        label: 'test',
      }),
    ).rejects.toThrow('business logic failure');
  });
});

// ---------------------------------------------------------------------------
// cancelWithGrace
// ---------------------------------------------------------------------------

describe('cancelWithGrace', () => {
  it('should return true when operation stops within grace period', async () => {
    const controller = new AbortController();
    let forceKilled = false;

    const operationDone = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        // Operation observes signal and stops quickly
        setTimeout(resolve, 10);
      }, { once: true });
    });

    const graceful = await cancelWithGrace({
      controller,
      graceMs: 5000,
      forceKill: () => { forceKilled = true; },
      operationDone,
    });

    expect(graceful).toBe(true);
    expect(forceKilled).toBe(false);
  });

  it('should return false and call forceKill when grace expires', async () => {
    const controller = new AbortController();
    let forceKilled = false;

    // Operation that never finishes
    const operationDone = new Promise<void>(() => {
      // intentionally never resolves
    });

    const graceful = await cancelWithGrace({
      controller,
      graceMs: 50,
      forceKill: () => { forceKilled = true; },
      operationDone,
    });

    expect(graceful).toBe(false);
    expect(forceKilled).toBe(true);
  });

  it('should abort the controller signal', async () => {
    const controller = new AbortController();

    const operationDone = Promise.resolve();

    await cancelWithGrace({
      controller,
      graceMs: 50,
      forceKill: () => {},
      operationDone,
    });

    expect(controller.signal.aborted).toBe(true);
  });

  it('should handle operation that rejects within grace period', async () => {
    const controller = new AbortController();
    let forceKilled = false;

    const operationDone = new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error('operation error'));
      }, { once: true });
    });

    const graceful = await cancelWithGrace({
      controller,
      graceMs: 5000,
      forceKill: () => { forceKilled = true; },
      operationDone,
    });

    expect(graceful).toBe(true);
    expect(forceKilled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createJobBudget
// ---------------------------------------------------------------------------

describe('createJobBudget', () => {
  const config = {
    jobTimeoutMs: 300_000,
    planningTimeoutMs: 60_000,
    validationTimeoutMs: 30_000,
    stepTimeoutMs: 60_000,
  };

  it('should create a budget with the full job timeout', () => {
    const clock = createMockClock(1000);
    const { budget } = createJobBudget(config, clock.now);
    expect(budget.getTotalMs()).toBe(300_000);
    expect(budget.remaining(clock.now)).toBe(300_000);
  });

  it('should return planning timeout capped by budget', () => {
    const clock = createMockClock(1000);
    const { getPhaseTimeout } = createJobBudget(config, clock.now);
    expect(getPhaseTimeout('planning')).toBe(60_000);
  });

  it('should return validation timeout capped by budget', () => {
    const clock = createMockClock(1000);
    const { getPhaseTimeout } = createJobBudget(config, clock.now);
    expect(getPhaseTimeout('validation')).toBe(30_000);
  });

  it('should return step timeout capped by budget', () => {
    const clock = createMockClock(1000);
    const { getPhaseTimeout } = createJobBudget(config, clock.now);
    expect(getPhaseTimeout('step')).toBe(60_000);
  });

  it('should cap planning timeout when budget is low', () => {
    const clock = createMockClock(1000);
    const { getPhaseTimeout } = createJobBudget(config, clock.now);
    // Simulate time passage
    clock.advance(280_000);
    // Only 20s left of 300s budget, planning wants 60s
    expect(getPhaseTimeout('planning')).toBe(20_000);
  });

  it('should throw when budget is exhausted', () => {
    const clock = createMockClock(1000);
    const { getPhaseTimeout } = createJobBudget(config, clock.now);
    clock.advance(300_000);
    expect(() => getPhaseTimeout('planning')).toThrow(TimeoutError);
  });
});

// ---------------------------------------------------------------------------
// getExecutionBudget
// ---------------------------------------------------------------------------

describe('getExecutionBudget', () => {
  it('should return full budget when nothing has elapsed', () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(300_000, 'job', clock.now);
    expect(getExecutionBudget(budget, clock.now)).toBe(300_000);
  });

  it('should return remaining budget after phases consumed time', () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(300_000, 'job', clock.now);
    // Simulate planning took 45s, validation took 20s
    clock.advance(65_000);
    expect(getExecutionBudget(budget, clock.now)).toBe(235_000);
  });

  it('should return 0 when budget is exhausted', () => {
    const clock = createMockClock(1000);
    const budget = new TimeoutBudget(300_000, 'job', clock.now);
    clock.advance(300_000);
    expect(getExecutionBudget(budget, clock.now)).toBe(0);
  });
});
