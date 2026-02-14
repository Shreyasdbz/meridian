import { describe, it, expect } from 'vitest';

import type { StepCondition } from '@meridian/shared';

import type { StepResultRef } from './condition-evaluator.js';
import { ConditionEvaluator } from './condition-evaluator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResults(
  ...entries: StepResultRef[]
): Map<string, StepResultRef> {
  const map = new Map<string, StepResultRef>();
  for (const entry of entries) {
    map.set(entry.stepId, entry);
  }
  return map;
}

function makeCondition(
  field: string,
  operator: StepCondition['operator'],
  value?: unknown,
): StepCondition {
  return { field, operator, value };
}

// ---------------------------------------------------------------------------
// ConditionEvaluator
// ---------------------------------------------------------------------------

describe('ConditionEvaluator', () => {
  const evaluator = new ConditionEvaluator();

  // -----------------------------------------------------------------------
  // eq operator
  // -----------------------------------------------------------------------

  describe('eq operator', () => {
    it('should return true when field value equals condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { code: 200 },
      });
      const condition = makeCondition('step:stepA.result.code', 'eq', 200);
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return false when field value does not equal condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { code: 200 },
      });
      const condition = makeCondition('step:stepA.result.code', 'eq', 404);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should coerce numeric strings when comparing with eq', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { count: '42' },
      });
      const condition = makeCondition('step:stepA.result.count', 'eq', 42);
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should compare string values with eq', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { name: 'hello' },
      });
      const condition = makeCondition('step:stepA.result.name', 'eq', 'hello');
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // neq operator
  // -----------------------------------------------------------------------

  describe('neq operator', () => {
    it('should return true when field value does not equal condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { code: 200 },
      });
      const condition = makeCondition('step:stepA.result.code', 'neq', 404);
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return false when field value equals condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { code: 200 },
      });
      const condition = makeCondition('step:stepA.result.code', 'neq', 200);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // gt operator
  // -----------------------------------------------------------------------

  describe('gt operator', () => {
    it('should return true when field value is greater than condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { score: 85 },
      });
      const condition = makeCondition('step:stepA.result.score', 'gt', 80);
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return false when field value equals condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { score: 80 },
      });
      const condition = makeCondition('step:stepA.result.score', 'gt', 80);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when field value is less than condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { score: 75 },
      });
      const condition = makeCondition('step:stepA.result.score', 'gt', 80);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when field value is not a number', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { score: 'high' },
      });
      const condition = makeCondition('step:stepA.result.score', 'gt', 80);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when condition value is not a number', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { score: 85 },
      });
      const condition = makeCondition('step:stepA.result.score', 'gt', 'high');
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // lt operator
  // -----------------------------------------------------------------------

  describe('lt operator', () => {
    it('should return true when field value is less than condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { latency: 50 },
      });
      const condition = makeCondition('step:stepA.result.latency', 'lt', 100);
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return false when field value equals condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { latency: 100 },
      });
      const condition = makeCondition('step:stepA.result.latency', 'lt', 100);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when field value is greater than condition value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { latency: 150 },
      });
      const condition = makeCondition('step:stepA.result.latency', 'lt', 100);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when field value is NaN', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { latency: 'fast' },
      });
      const condition = makeCondition('step:stepA.result.latency', 'lt', 100);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // contains operator
  // -----------------------------------------------------------------------

  describe('contains operator', () => {
    it('should return true when string field contains the substring', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { message: 'operation succeeded' },
      });
      const condition = makeCondition(
        'step:stepA.result.message',
        'contains',
        'succeeded',
      );
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return false when string field does not contain the substring', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { message: 'operation failed' },
      });
      const condition = makeCondition(
        'step:stepA.result.message',
        'contains',
        'succeeded',
      );
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return true when array field contains the value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { tags: ['important', 'urgent', 'review'] },
      });
      const condition = makeCondition(
        'step:stepA.result.tags',
        'contains',
        'urgent',
      );
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return false when array field does not contain the value', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { tags: ['important', 'review'] },
      });
      const condition = makeCondition(
        'step:stepA.result.tags',
        'contains',
        'urgent',
      );
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when field is not a string or array', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { count: 42 },
      });
      const condition = makeCondition(
        'step:stepA.result.count',
        'contains',
        '42',
      );
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // exists operator
  // -----------------------------------------------------------------------

  describe('exists operator', () => {
    it('should return true when field value is defined', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { data: 'present' },
      });
      const condition = makeCondition('step:stepA.result.data', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return true when field value is zero', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { count: 0 },
      });
      const condition = makeCondition('step:stepA.result.count', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return true when field value is an empty string', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { name: '' },
      });
      const condition = makeCondition('step:stepA.result.name', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return true when field value is false', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { enabled: false },
      });
      const condition = makeCondition('step:stepA.result.enabled', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return false when field value is null', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { data: null },
      });
      const condition = makeCondition('step:stepA.result.data', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when field value is undefined (missing key)', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { other: 'value' },
      });
      const condition = makeCondition('step:stepA.result.missing', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Step status access
  // -----------------------------------------------------------------------

  describe('step status field access', () => {
    it('should resolve step status via step:<id>.status', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
      });
      const condition = makeCondition('step:stepA.status', 'eq', 'completed');
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should detect failed step status', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'failed',
      });
      const condition = makeCondition('step:stepA.status', 'eq', 'failed');
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should detect skipped step status', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'skipped',
      });
      const condition = makeCondition('step:stepA.status', 'neq', 'completed');
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Dot-path navigation
  // -----------------------------------------------------------------------

  describe('dot-path navigation', () => {
    it('should navigate deeply nested paths', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: {
          data: {
            items: {
              count: 7,
            },
          },
        },
      });
      const condition = makeCondition(
        'step:stepA.result.data.items.count',
        'eq',
        7,
      );
      expect(evaluator.evaluate(condition, results)).toBe(true);
    });

    it('should return false for partially valid nested path', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: {
          data: { value: 42 },
        },
      });
      const condition = makeCondition(
        'step:stepA.result.data.nonexistent.deep',
        'exists',
      );
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when navigating into a primitive', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { count: 42 },
      });
      const condition = makeCondition(
        'step:stepA.result.count.something',
        'exists',
      );
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Missing step reference
  // -----------------------------------------------------------------------

  describe('missing step reference', () => {
    it('should return false when the referenced step does not exist', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { code: 200 },
      });
      const condition = makeCondition('step:nonexistent.result.code', 'eq', 200);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false with exists operator for missing step', () => {
      const results = makeResults();
      const condition = makeCondition('step:missing.status', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Missing field path
  // -----------------------------------------------------------------------

  describe('missing field path', () => {
    it('should return false when field path does not exist in result', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { code: 200 },
      });
      const condition = makeCondition(
        'step:stepA.result.nonexistent',
        'eq',
        200,
      );
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when result is undefined and path is into result', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
      });
      const condition = makeCondition('step:stepA.result.code', 'eq', 200);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Empty results map
  // -----------------------------------------------------------------------

  describe('empty results map', () => {
    it('should return false for any condition when results map is empty', () => {
      const results = new Map<string, StepResultRef>();
      const condition = makeCondition('step:stepA.status', 'eq', 'completed');
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false for exists on empty results', () => {
      const results = new Map<string, StepResultRef>();
      const condition = makeCondition('step:stepA.result.data', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Invalid field format
  // -----------------------------------------------------------------------

  describe('invalid field format', () => {
    it('should return false when field does not start with step:', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
        result: { code: 200 },
      });
      const condition = makeCondition('invalid.path', 'eq', 200);
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });

    it('should return false when field is just step:<id> with no path', () => {
      const results = makeResults({
        stepId: 'stepA',
        status: 'completed',
      });
      const condition = makeCondition('step:stepA', 'exists');
      expect(evaluator.evaluate(condition, results)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple steps in results
  // -----------------------------------------------------------------------

  describe('multiple steps in results', () => {
    it('should resolve the correct step from multiple results', () => {
      const results = makeResults(
        {
          stepId: 'stepA',
          status: 'completed',
          result: { code: 200 },
        },
        {
          stepId: 'stepB',
          status: 'failed',
          result: { code: 500 },
        },
      );

      const condA = makeCondition('step:stepA.result.code', 'eq', 200);
      const condB = makeCondition('step:stepB.result.code', 'eq', 500);
      const condBStatus = makeCondition('step:stepB.status', 'eq', 'failed');

      expect(evaluator.evaluate(condA, results)).toBe(true);
      expect(evaluator.evaluate(condB, results)).toBe(true);
      expect(evaluator.evaluate(condBStatus, results)).toBe(true);
    });
  });
});
