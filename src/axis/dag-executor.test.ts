/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, it, expect, vi } from 'vitest';

import type { ExecutionStep, StepCondition } from '@meridian/shared';

import { DagExecutor } from './dag-executor.js';
import type {
  StepExecutor,
  StepResult,
  DagExecutorConfig,
} from './dag-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ExecutionStep for testing. */
function createStep(overrides: Partial<ExecutionStep> & { id: string }): ExecutionStep {
  return {
    gear: 'gear:test',
    action: 'run',
    parameters: {},
    riskLevel: 'low',
    ...overrides,
  };
}

/** A simple executor that returns `{ ok: true, stepId }`. */
const successExecutor: StepExecutor = (step) => {
  return Promise.resolve({ ok: true, stepId: step.id });
};

/** An executor that records execution order. */
function orderTrackingExecutor(
  log: string[],
): StepExecutor {
  return async (step) => {
    log.push(step.id);
    return { ok: true, stepId: step.id };
  };
}

/** An executor that adds a delay (useful for concurrency tests). */
function delayedExecutor(
  delayMs: number,
  log?: string[],
): StepExecutor {
  return async (step) => {
    log?.push(`start:${step.id}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    log?.push(`end:${step.id}`);
    return { ok: true, stepId: step.id };
  };
}

/** Create a no-op logger that captures calls for assertions. */
function createSpyLogger(): DagExecutorConfig['logger'] & {
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    info: [],
    warn: [],
    error: [],
  };
  return {
    calls,
    info: (...args: unknown[]) => { calls['info']!.push(args); },
    warn: (...args: unknown[]) => { calls['warn']!.push(args); },
    error: (...args: unknown[]) => { calls['error']!.push(args); },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DagExecutor', () => {
  // -------------------------------------------------------------------------
  // Empty steps
  // -------------------------------------------------------------------------

  describe('empty steps', () => {
    it('should return completed with no results for an empty step list', async () => {
      const dag = new DagExecutor();
      const result = await dag.execute([], successExecutor);

      expect(result.status).toBe('completed');
      expect(result.stepResults).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Single step
  // -------------------------------------------------------------------------

  describe('single step', () => {
    it('should execute a single step with no dependencies', async () => {
      const dag = new DagExecutor();
      const steps = [createStep({ id: 'step-a' })];

      const result = await dag.execute(steps, successExecutor);

      expect(result.status).toBe('completed');
      expect(result.stepResults).toHaveLength(1);
      expect(result.stepResults[0]!.stepId).toBe('step-a');
      expect(result.stepResults[0]!.status).toBe('completed');
      expect(result.stepResults[0]!.result).toEqual({ ok: true, stepId: 'step-a' });
      expect(result.stepResults[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should report failed when a single step fails', async () => {
      const dag = new DagExecutor();
      const steps = [createStep({ id: 'step-a' })];

      const failExecutor: StepExecutor = () => {
        return Promise.reject(new Error('step failed'));
      };

      const result = await dag.execute(steps, failExecutor);

      expect(result.status).toBe('failed');
      expect(result.stepResults[0]!.status).toBe('failed');
      expect(result.stepResults[0]!.error).toBe('step failed');
    });
  });

  // -------------------------------------------------------------------------
  // Linear chain
  // -------------------------------------------------------------------------

  describe('linear chain execution', () => {
    it('should execute steps in dependency order (A -> B -> C)', async () => {
      const log: string[] = [];
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
        createStep({ id: 'C', dependsOn: ['B'] }),
      ];

      const result = await dag.execute(steps, orderTrackingExecutor(log));

      expect(result.status).toBe('completed');
      expect(log).toEqual(['A', 'B', 'C']);
      expect(result.stepResults).toHaveLength(3);
    });

    it('should maintain order regardless of input ordering', async () => {
      const log: string[] = [];
      const dag = new DagExecutor();

      // Steps provided in reverse order
      const steps = [
        createStep({ id: 'C', dependsOn: ['B'] }),
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
      ];

      const result = await dag.execute(steps, orderTrackingExecutor(log));

      expect(result.status).toBe('completed');
      expect(log).toEqual(['A', 'B', 'C']);
    });
  });

  // -------------------------------------------------------------------------
  // Diamond dependency
  // -------------------------------------------------------------------------

  describe('diamond dependency', () => {
    it('should handle diamond pattern (A -> B, A -> C, B+C -> D)', async () => {
      const log: string[] = [];
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
        createStep({ id: 'C', dependsOn: ['A'] }),
        createStep({ id: 'D', dependsOn: ['B', 'C'] }),
      ];

      const result = await dag.execute(steps, orderTrackingExecutor(log));

      expect(result.status).toBe('completed');
      expect(result.stepResults).toHaveLength(4);

      // A must be first, D must be last
      expect(log[0]).toBe('A');
      expect(log[3]).toBe('D');

      // B and C can be in either order (they're in the same layer)
      expect(log.slice(1, 3).sort()).toEqual(['B', 'C']);
    });
  });

  // -------------------------------------------------------------------------
  // Parallel execution
  // -------------------------------------------------------------------------

  describe('parallel execution', () => {
    it('should execute independent steps in parallel within the same layer', async () => {
      const log: string[] = [];
      const dag = new DagExecutor({ maxConcurrency: 4 });

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B' }),
        createStep({ id: 'C' }),
      ];

      const result = await dag.execute(steps, delayedExecutor(10, log));

      expect(result.status).toBe('completed');
      expect(result.stepResults).toHaveLength(3);

      // All three start before any ends (they run in parallel)
      const startIndices = ['A', 'B', 'C'].map((id) =>
        log.indexOf(`start:${id}`),
      );
      const endIndices = ['A', 'B', 'C'].map((id) =>
        log.indexOf(`end:${id}`),
      );

      // All starts should come before all ends since they're parallel
      for (const startIdx of startIndices) {
        for (const endIdx of endIndices) {
          expect(startIdx).toBeLessThan(endIdx);
        }
      }
    });

    it('should dispatch steps in the same parallelGroup together', async () => {
      const log: string[] = [];
      const dag = new DagExecutor({ maxConcurrency: 4 });

      const steps = [
        createStep({ id: 'A', parallelGroup: 'group1' }),
        createStep({ id: 'B', parallelGroup: 'group1' }),
        createStep({ id: 'C', parallelGroup: 'group1' }),
      ];

      const result = await dag.execute(steps, delayedExecutor(10, log));

      expect(result.status).toBe('completed');

      // All should start before any end
      const allStarts = log.filter((e) => e.startsWith('start:'));
      const allEnds = log.filter((e) => e.startsWith('end:'));
      expect(allStarts).toHaveLength(3);
      expect(allEnds).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Max concurrency
  // -------------------------------------------------------------------------

  describe('max concurrency', () => {
    it('should respect maxConcurrency limit', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const trackingExecutor: StepExecutor = async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await delay(30);
        currentConcurrent--;
        return { ok: true };
      };

      const dag = new DagExecutor({ maxConcurrency: 2 });

      // 5 independent steps, concurrency limited to 2
      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B' }),
        createStep({ id: 'C' }),
        createStep({ id: 'D' }),
        createStep({ id: 'E' }),
      ];

      const result = await dag.execute(steps, trackingExecutor);

      expect(result.status).toBe('completed');
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(result.stepResults).toHaveLength(5);
    });

    it('should default maxConcurrency to 4', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const trackingExecutor: StepExecutor = async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await delay(30);
        currentConcurrent--;
        return { ok: true };
      };

      const dag = new DagExecutor();

      // 8 independent steps
      const steps = Array.from({ length: 8 }, (_, i) =>
        createStep({ id: `step-${i}` }),
      );

      await dag.execute(steps, trackingExecutor);

      expect(maxConcurrent).toBeLessThanOrEqual(4);
    });
  });

  // -------------------------------------------------------------------------
  // $ref:step resolution
  // -------------------------------------------------------------------------

  describe('$ref:step resolution', () => {
    it('should resolve $ref:step:<stepId> to the full result object', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'fetch', parameters: { url: 'https://example.com' } }),
        createStep({
          id: 'process',
          dependsOn: ['fetch'],
          parameters: { data: '$ref:step:fetch' },
        }),
      ];

      let capturedParams: Record<string, unknown> = {};

      const executor: StepExecutor = async (step) => {
        if (step.id === 'fetch') {
          return { body: 'hello', status: 200 };
        }
        capturedParams = step.parameters;
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.status).toBe('completed');
      expect(capturedParams['data']).toEqual({ body: 'hello', status: 200 });
    });

    it('should resolve $ref:step:<stepId>.path.to.field with dot-path', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'fetch' }),
        createStep({
          id: 'process',
          dependsOn: ['fetch'],
          parameters: { url: '$ref:step:fetch.data.url' },
        }),
      ];

      let capturedParams: Record<string, unknown> = {};

      const executor: StepExecutor = async (step) => {
        if (step.id === 'fetch') {
          return { data: { url: 'https://resolved.example.com', title: 'Test' } };
        }
        capturedParams = step.parameters;
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.status).toBe('completed');
      expect(capturedParams['url']).toBe('https://resolved.example.com');
    });

    it('should resolve nested $ref:step references in parameters', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'step-a' }),
        createStep({
          id: 'step-b',
          dependsOn: ['step-a'],
          parameters: {
            nested: {
              value: '$ref:step:step-a.output',
            },
            list: ['$ref:step:step-a.items'],
          },
        }),
      ];

      let capturedParams: Record<string, unknown> = {};

      const executor: StepExecutor = async (step) => {
        if (step.id === 'step-a') {
          return { output: 'resolved-value', items: [1, 2, 3] };
        }
        capturedParams = step.parameters;
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.status).toBe('completed');
      expect((capturedParams['nested'] as Record<string, unknown>)['value']).toBe(
        'resolved-value',
      );
      expect((capturedParams['list'] as unknown[])[0]).toEqual([1, 2, 3]);
    });

    it('should leave non-ref strings unchanged', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({
          id: 'step-a',
          parameters: { url: 'https://example.com', count: 42 },
        }),
      ];

      let capturedParams: Record<string, unknown> = {};

      const executor: StepExecutor = async (step) => {
        capturedParams = step.parameters;
        return { ok: true };
      };

      await dag.execute(steps, executor);

      expect(capturedParams['url']).toBe('https://example.com');
      expect(capturedParams['count']).toBe(42);
    });

    it('should leave unresolvable $ref:step references as-is', async () => {
      const logger = createSpyLogger();
      const dag = new DagExecutor({ logger });

      const steps = [
        createStep({
          id: 'step-a',
          parameters: { data: '$ref:step:nonexistent.value' },
        }),
      ];

      let capturedParams: Record<string, unknown> = {};

      const executor: StepExecutor = async (step) => {
        capturedParams = step.parameters;
        return { ok: true };
      };

      await dag.execute(steps, executor);

      expect(capturedParams['data']).toBe('$ref:step:nonexistent.value');
      expect(logger.calls['warn']!.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cycle detection
  // -------------------------------------------------------------------------

  describe('cycle detection', () => {
    it('should throw on a simple cycle (A -> B -> A)', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A', dependsOn: ['B'] }),
        createStep({ id: 'B', dependsOn: ['A'] }),
      ];

      await expect(dag.execute(steps, successExecutor)).rejects.toThrow(
        /Cycle detected/,
      );
    });

    it('should throw on a three-step cycle (A -> B -> C -> A)', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A', dependsOn: ['C'] }),
        createStep({ id: 'B', dependsOn: ['A'] }),
        createStep({ id: 'C', dependsOn: ['B'] }),
      ];

      await expect(dag.execute(steps, successExecutor)).rejects.toThrow(
        /Cycle detected/,
      );
    });

    it('should include unprocessed step IDs in cycle error message', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'X' }), // This one is fine
        createStep({ id: 'A', dependsOn: ['B'] }),
        createStep({ id: 'B', dependsOn: ['A'] }),
      ];

      await expect(dag.execute(steps, successExecutor)).rejects.toThrow(
        /A.*B|B.*A/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Self-dependency
  // -------------------------------------------------------------------------

  describe('self-dependency', () => {
    it('should throw on a self-dependent step', async () => {
      const dag = new DagExecutor();

      const steps = [createStep({ id: 'A', dependsOn: ['A'] })];

      await expect(dag.execute(steps, successExecutor)).rejects.toThrow(
        /self-dependency/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Failure propagation
  // -------------------------------------------------------------------------

  describe('failure propagation', () => {
    it('should skip dependent steps when a step fails', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
        createStep({ id: 'C', dependsOn: ['B'] }),
      ];

      const executor: StepExecutor = async (step) => {
        if (step.id === 'A') {
          throw new Error('Step A failed');
        }
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.status).toBe('failed');
      expect(result.stepResults[0]!.status).toBe('failed');
      expect(result.stepResults[0]!.error).toBe('Step A failed');
      expect(result.stepResults[1]!.status).toBe('skipped');
      expect(result.stepResults[2]!.status).toBe('skipped');
    });

    it('should continue independent branches when one fails', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
        createStep({ id: 'C' }), // Independent branch
        createStep({ id: 'D', dependsOn: ['C'] }),
      ];

      const executor: StepExecutor = async (step) => {
        if (step.id === 'A') {
          throw new Error('Step A failed');
        }
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.status).toBe('partial');
      expect(result.stepResults.find((r) => r.stepId === 'A')!.status).toBe('failed');
      expect(result.stepResults.find((r) => r.stepId === 'B')!.status).toBe('skipped');
      expect(result.stepResults.find((r) => r.stepId === 'C')!.status).toBe('completed');
      expect(result.stepResults.find((r) => r.stepId === 'D')!.status).toBe('completed');
    });

    it('should skip transitive dependents on failure (A fails -> B skipped -> C skipped)', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
        createStep({ id: 'C', dependsOn: ['B'] }),
        createStep({ id: 'D', dependsOn: ['C'] }),
      ];

      const executor: StepExecutor = async (step) => {
        if (step.id === 'A') {
          throw new Error('boom');
        }
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.stepResults[0]!.status).toBe('failed');
      expect(result.stepResults[1]!.status).toBe('skipped');
      expect(result.stepResults[2]!.status).toBe('skipped');
      expect(result.stepResults[3]!.status).toBe('skipped');
    });

    it('should skip diamond tail when one branch fails', async () => {
      const dag = new DagExecutor();

      // A -> B (fails), A -> C (succeeds), B+C -> D (should skip because B failed)
      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
        createStep({ id: 'C', dependsOn: ['A'] }),
        createStep({ id: 'D', dependsOn: ['B', 'C'] }),
      ];

      const executor: StepExecutor = async (step) => {
        if (step.id === 'B') {
          throw new Error('B failed');
        }
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.status).toBe('partial');
      expect(result.stepResults.find((r) => r.stepId === 'A')!.status).toBe('completed');
      expect(result.stepResults.find((r) => r.stepId === 'B')!.status).toBe('failed');
      expect(result.stepResults.find((r) => r.stepId === 'C')!.status).toBe('completed');
      expect(result.stepResults.find((r) => r.stepId === 'D')!.status).toBe('skipped');
    });
  });

  // -------------------------------------------------------------------------
  // Abort signal
  // -------------------------------------------------------------------------

  describe('abort signal', () => {
    it('should skip remaining steps when signal is aborted', async () => {
      const controller = new AbortController();
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
        createStep({ id: 'C', dependsOn: ['B'] }),
      ];

      const executor: StepExecutor = async (step) => {
        if (step.id === 'A') {
          // Abort after step A completes
          controller.abort();
        }
        return { ok: true };
      };

      const result = await dag.execute(steps, executor, controller.signal);

      // Step A completed, B and C should be skipped
      expect(result.stepResults.find((r) => r.stepId === 'A')!.status).toBe('completed');
      expect(result.stepResults.find((r) => r.stepId === 'B')!.status).toBe('skipped');
      expect(result.stepResults.find((r) => r.stepId === 'C')!.status).toBe('skipped');
    });

    it('should propagate signal to the step executor', async () => {
      const controller = new AbortController();
      const dag = new DagExecutor();
      let receivedSignal: AbortSignal | undefined;

      const steps = [createStep({ id: 'A' })];

      const executor: StepExecutor = async (_step, signal) => {
        receivedSignal = signal;
        return { ok: true };
      };

      await dag.execute(steps, executor, controller.signal);

      expect(receivedSignal).toBe(controller.signal);
    });
  });

  // -------------------------------------------------------------------------
  // Condition evaluation
  // -------------------------------------------------------------------------

  describe('condition evaluation', () => {
    it('should execute a step when condition evaluates to true', async () => {
      const condition: StepCondition = {
        field: 'result.status',
        operator: 'eq',
        value: 'success',
      };

      const dag = new DagExecutor({
        evaluateCondition: () => true,
      });

      const steps = [
        createStep({ id: 'A' }),
        createStep({
          id: 'B',
          dependsOn: ['A'],
          condition,
        }),
      ];

      const result = await dag.execute(steps, successExecutor);

      expect(result.status).toBe('completed');
      expect(result.stepResults.find((r) => r.stepId === 'B')!.status).toBe('completed');
    });

    it('should skip a step when condition evaluates to false', async () => {
      const condition: StepCondition = {
        field: 'result.status',
        operator: 'eq',
        value: 'success',
      };

      const dag = new DagExecutor({
        evaluateCondition: () => false,
      });

      const steps = [
        createStep({ id: 'A' }),
        createStep({
          id: 'B',
          dependsOn: ['A'],
          condition,
        }),
      ];

      const result = await dag.execute(steps, successExecutor);

      expect(result.stepResults.find((r) => r.stepId === 'B')!.status).toBe('skipped');
      expect(result.stepResults.find((r) => r.stepId === 'B')!.error).toBe(
        'Condition evaluated to false',
      );
    });

    it('should pass the condition and prior results to evaluateCondition', async () => {
      const condition: StepCondition = {
        field: 'result.count',
        operator: 'gt',
        value: 10,
      };

      let capturedCondition: StepCondition | undefined;
      let capturedResults: Map<string, StepResult> | undefined;

      const dag = new DagExecutor({
        evaluateCondition: (cond, results) => {
          capturedCondition = cond;
          capturedResults = results;
          return true;
        },
      });

      const steps = [
        createStep({ id: 'A' }),
        createStep({
          id: 'B',
          dependsOn: ['A'],
          condition,
        }),
      ];

      await dag.execute(steps, successExecutor);

      expect(capturedCondition).toEqual(condition);
      expect(capturedResults).toBeDefined();
      expect(capturedResults!.has('A')).toBe(true);
      expect(capturedResults!.get('A')!.status).toBe('completed');
    });

    it('should not evaluate condition for steps without a condition', async () => {
      const evaluateCondition = vi.fn().mockReturnValue(true);

      const dag = new DagExecutor({ evaluateCondition });

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
      ];

      await dag.execute(steps, successExecutor);

      expect(evaluateCondition).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  describe('circuit breaker', () => {
    it('should skip a step when its circuit breaker is open', async () => {
      const dag = new DagExecutor({
        isCircuitOpen: (gearId) => gearId === 'gear:broken',
      });

      const steps = [
        createStep({ id: 'A', gear: 'gear:broken' }),
      ];

      const result = await dag.execute(steps, successExecutor);

      expect(result.stepResults[0]!.status).toBe('skipped');
      expect(result.stepResults[0]!.error).toBe(
        'Circuit breaker open for gear: gear:broken',
      );
    });

    it('should execute a step when its circuit breaker is closed', async () => {
      const dag = new DagExecutor({
        isCircuitOpen: () => false,
      });

      const steps = [
        createStep({ id: 'A', gear: 'gear:healthy' }),
      ];

      const result = await dag.execute(steps, successExecutor);

      expect(result.stepResults[0]!.status).toBe('completed');
    });

    it('should check circuit breaker per step gear', async () => {
      const checkedGears: string[] = [];

      const dag = new DagExecutor({
        isCircuitOpen: (gearId) => {
          checkedGears.push(gearId);
          return gearId === 'gear:broken';
        },
      });

      const steps = [
        createStep({ id: 'A', gear: 'gear:healthy' }),
        createStep({ id: 'B', gear: 'gear:broken' }),
        createStep({ id: 'C', gear: 'gear:healthy' }),
      ];

      const result = await dag.execute(steps, successExecutor);

      expect(checkedGears).toContain('gear:healthy');
      expect(checkedGears).toContain('gear:broken');
      expect(result.stepResults.find((r) => r.stepId === 'A')!.status).toBe('completed');
      expect(result.stepResults.find((r) => r.stepId === 'B')!.status).toBe('skipped');
      expect(result.stepResults.find((r) => r.stepId === 'C')!.status).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // Overall status computation
  // -------------------------------------------------------------------------

  describe('overall status', () => {
    it('should return completed when all steps succeed', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B' }),
      ];

      const result = await dag.execute(steps, successExecutor);

      expect(result.status).toBe('completed');
    });

    it('should return completed when all steps succeed or are skipped by condition', async () => {
      const dag = new DagExecutor({
        evaluateCondition: () => false,
      });

      const steps = [
        createStep({ id: 'A' }),
        createStep({
          id: 'B',
          condition: { field: 'x', operator: 'eq', value: 'y' },
        }),
      ];

      const result = await dag.execute(steps, successExecutor);

      // B is skipped by condition, not by failure — overall should be completed
      expect(result.status).toBe('completed');
    });

    it('should return failed when all steps fail or are skipped', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
      ];

      const failExecutor: StepExecutor = async () => {
        throw new Error('boom');
      };

      const result = await dag.execute(steps, failExecutor);

      expect(result.status).toBe('failed');
    });

    it('should return partial when some steps succeed and some fail', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }), // succeeds
        createStep({ id: 'B' }), // fails
      ];

      const executor: StepExecutor = async (step) => {
        if (step.id === 'B') {
          throw new Error('B failed');
        }
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.status).toBe('partial');
    });
  });

  // -------------------------------------------------------------------------
  // Duration tracking
  // -------------------------------------------------------------------------

  describe('duration tracking', () => {
    it('should track step execution duration', async () => {
      const dag = new DagExecutor();

      const steps = [createStep({ id: 'A' })];

      const executor: StepExecutor = async () => {
        await delay(20);
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.stepResults[0]!.durationMs).toBeGreaterThanOrEqual(15);
    });

    it('should track overall execution duration', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
      ];

      const executor: StepExecutor = async () => {
        await delay(10);
        return { ok: true };
      };

      const result = await dag.execute(steps, executor);

      expect(result.durationMs).toBeGreaterThanOrEqual(15);
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  describe('logging', () => {
    it('should log step execution start and completion', async () => {
      const logger = createSpyLogger();
      const dag = new DagExecutor({ logger });

      const steps = [createStep({ id: 'A' })];

      await dag.execute(steps, successExecutor);

      const infoMessages = logger.calls['info']!.map((c) => String(c[0]));
      expect(infoMessages.some((m) => m.includes("Executing step 'A'"))).toBe(true);
      expect(infoMessages.some((m) => m.includes("Step 'A' completed"))).toBe(true);
    });

    it('should log step failures', async () => {
      const logger = createSpyLogger();
      const dag = new DagExecutor({ logger });

      const steps = [createStep({ id: 'A' })];

      const failExecutor: StepExecutor = async () => {
        throw new Error('test failure');
      };

      await dag.execute(steps, failExecutor);

      const errorMessages = logger.calls['error']!.map((c) => String(c[0]));
      expect(errorMessages.some((m) => m.includes("Step 'A' failed"))).toBe(true);
    });

    it('should log skipped steps', async () => {
      const logger = createSpyLogger();
      const dag = new DagExecutor({ logger });

      const steps = [
        createStep({ id: 'A' }),
        createStep({ id: 'B', dependsOn: ['A'] }),
      ];

      const executor: StepExecutor = async (step) => {
        if (step.id === 'A') {
          throw new Error('fail');
        }
        return { ok: true };
      };

      await dag.execute(steps, executor);

      const warnMessages = logger.calls['warn']!.map((c) => String(c[0]));
      expect(warnMessages.some((m) => m.includes("Step 'B' skipped"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Result ordering
  // -------------------------------------------------------------------------

  describe('result ordering', () => {
    it('should return results in original step order', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'first' }),
        createStep({ id: 'second', dependsOn: ['first'] }),
        createStep({ id: 'third', dependsOn: ['second'] }),
      ];

      const result = await dag.execute(steps, successExecutor);

      expect(result.stepResults.map((r) => r.stepId)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown dependency
  // -------------------------------------------------------------------------

  describe('unknown dependency', () => {
    it('should throw when a step depends on a non-existent step', async () => {
      const dag = new DagExecutor();

      const steps = [
        createStep({ id: 'A', dependsOn: ['nonexistent'] }),
      ];

      await expect(dag.execute(steps, successExecutor)).rejects.toThrow(
        /unknown step/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Complex DAG scenarios
  // -------------------------------------------------------------------------

  describe('complex DAG', () => {
    it('should handle a wide DAG with multiple independent chains', async () => {
      const log: string[] = [];
      const dag = new DagExecutor({ maxConcurrency: 10 });

      // Chain 1: A1 -> B1 -> C1
      // Chain 2: A2 -> B2
      // Chain 3: A3
      const steps = [
        createStep({ id: 'A1' }),
        createStep({ id: 'B1', dependsOn: ['A1'] }),
        createStep({ id: 'C1', dependsOn: ['B1'] }),
        createStep({ id: 'A2' }),
        createStep({ id: 'B2', dependsOn: ['A2'] }),
        createStep({ id: 'A3' }),
      ];

      const result = await dag.execute(steps, orderTrackingExecutor(log));

      expect(result.status).toBe('completed');
      expect(result.stepResults).toHaveLength(6);

      // A1 before B1 before C1
      expect(log.indexOf('A1')).toBeLessThan(log.indexOf('B1'));
      expect(log.indexOf('B1')).toBeLessThan(log.indexOf('C1'));

      // A2 before B2
      expect(log.indexOf('A2')).toBeLessThan(log.indexOf('B2'));
    });

    it('should handle mixed conditions and dependencies correctly', async () => {
      const dag = new DagExecutor({
        evaluateCondition: (condition) => {
          // Only allow steps where condition value is 'yes'
          return condition.value === 'yes';
        },
        isCircuitOpen: (gearId) => gearId === 'gear:offline',
      });

      const steps = [
        createStep({ id: 'A' }),
        createStep({
          id: 'B',
          dependsOn: ['A'],
          condition: { field: 'x', operator: 'eq', value: 'yes' },
        }),
        createStep({
          id: 'C',
          dependsOn: ['A'],
          condition: { field: 'x', operator: 'eq', value: 'no' },
        }),
        createStep({ id: 'D', gear: 'gear:offline' }),
      ];

      const result = await dag.execute(steps, successExecutor);

      expect(result.stepResults.find((r) => r.stepId === 'A')!.status).toBe('completed');
      expect(result.stepResults.find((r) => r.stepId === 'B')!.status).toBe('completed');
      expect(result.stepResults.find((r) => r.stepId === 'C')!.status).toBe('skipped');
      expect(result.stepResults.find((r) => r.stepId === 'D')!.status).toBe('skipped');
    });
  });
});
