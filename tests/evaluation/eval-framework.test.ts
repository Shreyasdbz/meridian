// Meridian — LLM Evaluation Framework tests (Phase 9.7)

/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, it, expect } from 'vitest';

import type { EvalCase } from './eval-framework.js';
import { EvalRunner } from './eval-framework.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPassingCase(id: string): EvalCase {
  return {
    id,
    name: `Passing case ${id}`,
    description: `A case that always passes (${id})`,
    difficulty: 'easy',
    input: { value: 42 },
    expectedOutput: { result: 42 },
    validator: (output, expected) => output['result'] === expected['result'],
  };
}

function createFailingCase(id: string): EvalCase {
  return {
    id,
    name: `Failing case ${id}`,
    description: `A case that always fails validation (${id})`,
    difficulty: 'medium',
    input: { value: 1 },
    expectedOutput: { result: 999 },
    validator: (output, expected) => output['result'] === expected['result'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvalRunner', () => {
  describe('constructor', () => {
    it('should default to mock mode', () => {
      const runner = new EvalRunner('test-suite');
      expect(runner.getMode()).toBe('mock');
    });

    it('should accept an explicit mode', () => {
      const runner = new EvalRunner('test-suite', 'live');
      expect(runner.getMode()).toBe('live');
    });

    it('should store the suite name', () => {
      const runner = new EvalRunner('sentinel-evals');
      expect(runner.getSuiteName()).toBe('sentinel-evals');
    });
  });

  describe('run', () => {
    it('should run all cases and collect results', async () => {
      const runner = new EvalRunner('basic-suite');
      const cases: EvalCase[] = [
        createPassingCase('case-1'),
        createPassingCase('case-2'),
        createPassingCase('case-3'),
      ];

      const executor = async (input: Record<string, unknown>) => {
        return { result: input['value'] };
      };

      const result = await runner.run(cases, executor);

      expect(result.suiteName).toBe('basic-suite');
      expect(result.totalCases).toBe(3);
      expect(result.results).toHaveLength(3);
      expect(result.results[0]!.caseId).toBe('case-1');
      expect(result.results[1]!.caseId).toBe('case-2');
      expect(result.results[2]!.caseId).toBe('case-3');
    });

    it('should count passed and failed correctly', async () => {
      const runner = new EvalRunner('mixed-suite');
      const cases: EvalCase[] = [
        createPassingCase('pass-1'),
        createFailingCase('fail-1'),
        createPassingCase('pass-2'),
        createFailingCase('fail-2'),
      ];

      const executor = async (input: Record<string, unknown>) => {
        return { result: input['value'] };
      };

      const result = await runner.run(cases, executor);

      expect(result.totalCases).toBe(4);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(2);
    });

    it('should capture errors from failing executors', async () => {
      const runner = new EvalRunner('error-suite');
      const cases: EvalCase[] = [
        createPassingCase('ok-case'),
        createPassingCase('error-case'),
      ];

      const executor = async (input: Record<string, unknown>) => {
        if (input['value'] === 42) {
          // First call succeeds, second call would also be 42 — use a counter
          throw new Error('LLM provider unavailable');
        }
        return { result: input['value'] };
      };

      const result = await runner.run(cases, executor);

      expect(result.totalCases).toBe(2);
      // Both cases have value 42, so both throw
      expect(result.failed).toBe(2);

      const errorResult = result.results[0]!;
      expect(errorResult.passed).toBe(false);
      expect(errorResult.error).toBe('LLM provider unavailable');
      expect(errorResult.output).toEqual({});
    });

    it('should capture non-Error throws as strings', async () => {
      const runner = new EvalRunner('string-error-suite');
      const cases: EvalCase[] = [createPassingCase('throw-case')];

      const executor = async (_input: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'unexpected string error';
      };

      const result = await runner.run(cases, executor);

      expect(result.results[0]!.error).toBe('unexpected string error');
      expect(result.results[0]!.passed).toBe(false);
    });

    it('should record duration for each case', async () => {
      const runner = new EvalRunner('timing-suite');
      const cases: EvalCase[] = [createPassingCase('timed-case')];

      const executor = async (input: Record<string, unknown>) => {
        // Small delay to ensure measurable duration
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { result: input['value'] };
      };

      const result = await runner.run(cases, executor);

      expect(result.results[0]!.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle an empty case list', async () => {
      const runner = new EvalRunner('empty-suite');

      const executor = async (_input: Record<string, unknown>) => {
        return {};
      };

      const result = await runner.run([], executor);

      expect(result.suiteName).toBe('empty-suite');
      expect(result.totalCases).toBe(0);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.results).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include output in results for passing cases', async () => {
      const runner = new EvalRunner('output-suite');
      const cases: EvalCase[] = [createPassingCase('output-case')];

      const executor = async (input: Record<string, unknown>) => {
        return { result: input['value'] };
      };

      const result = await runner.run(cases, executor);

      expect(result.results[0]!.output).toEqual({ result: 42 });
      expect(result.results[0]!.passed).toBe(true);
      expect(result.results[0]!.error).toBeUndefined();
    });

    it('should run cases with different difficulty levels', async () => {
      const runner = new EvalRunner('difficulty-suite');
      const cases: EvalCase[] = [
        {
          id: 'easy-1',
          name: 'Easy case',
          description: 'Simple validation',
          difficulty: 'easy',
          input: { prompt: 'hello' },
          expectedOutput: { response: 'hello' },
          validator: (output, expected) =>
            output['response'] === expected['response'],
        },
        {
          id: 'hard-1',
          name: 'Hard case',
          description: 'Complex validation',
          difficulty: 'hard',
          input: { prompt: 'complex' },
          expectedOutput: { response: 'complex' },
          validator: (output, expected) =>
            output['response'] === expected['response'],
        },
      ];

      const executor = async (input: Record<string, unknown>) => {
        return { response: input['prompt'] };
      };

      const result = await runner.run(cases, executor);

      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
    });
  });
});
