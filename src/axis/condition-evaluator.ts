// @meridian/axis — Step condition evaluator
// Architecture Reference: Phase 9.9 — Conditional step execution

import type { StepCondition } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reference to a completed step's result, used as context for condition evaluation.
 */
export interface StepResultRef {
  stepId: string;
  status: 'completed' | 'failed' | 'skipped';
  result?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dot-path navigation
// ---------------------------------------------------------------------------

/**
 * Navigate a dot-separated path into a nested object.
 *
 * Returns `undefined` if any segment is missing or the current value
 * is not an object.  This makes missing paths safe — callers get
 * `undefined` rather than a thrown error.
 */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    // eslint-disable-next-line eqeqeq -- intentionally check both null and undefined
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Operator helpers
// ---------------------------------------------------------------------------

/**
 * Strict equality with numeric coercion.
 *
 * If both sides look numeric, compare as numbers so that
 * `"42" eq 42` evaluates to true.
 */
function isEq(fieldValue: unknown, conditionValue: unknown): boolean {
  if (fieldValue === conditionValue) {
    return true;
  }

  // Numeric coercion: both sides must convert to a finite number
  const numField = Number(fieldValue);
  const numCond = Number(conditionValue);
  if (!Number.isNaN(numField) && !Number.isNaN(numCond)) {
    return numField === numCond;
  }

  return false;
}

/**
 * Greater-than comparison. Returns false if either side is NaN.
 */
function isGt(fieldValue: unknown, conditionValue: unknown): boolean {
  const numField = Number(fieldValue);
  const numCond = Number(conditionValue);
  if (Number.isNaN(numField) || Number.isNaN(numCond)) {
    return false;
  }
  return numField > numCond;
}

/**
 * Less-than comparison. Returns false if either side is NaN.
 */
function isLt(fieldValue: unknown, conditionValue: unknown): boolean {
  const numField = Number(fieldValue);
  const numCond = Number(conditionValue);
  if (Number.isNaN(numField) || Number.isNaN(numCond)) {
    return false;
  }
  return numField < numCond;
}

/**
 * Contains check for strings and arrays.
 *
 * - String: `fieldValue.includes(conditionValue)`
 * - Array: `fieldValue.includes(conditionValue)`
 * - Otherwise: false
 */
function doesContain(fieldValue: unknown, conditionValue: unknown): boolean {
  if (typeof fieldValue === 'string' && typeof conditionValue === 'string') {
    return fieldValue.includes(conditionValue);
  }

  if (Array.isArray(fieldValue)) {
    return fieldValue.includes(conditionValue);
  }

  return false;
}

/**
 * Existence check: value is neither undefined nor null.
 */
function doesExist(fieldValue: unknown): boolean {
  return fieldValue !== undefined && fieldValue !== null;
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/**
 * Parse the condition's `field` string and resolve it against step results.
 *
 * Field format: `step:<stepId>.<path>` where `<path>` is either `status`
 * or a dot-delimited path into the step's `result` object (e.g.
 * `step:stepA.result.data.count`).
 *
 * Returns `undefined` if the step is not found or the path cannot be resolved.
 */
function resolveField(
  field: string,
  results: Map<string, StepResultRef>,
): unknown {
  if (!field.startsWith('step:')) {
    return undefined;
  }

  // Extract stepId and remaining path
  const withoutPrefix = field.slice('step:'.length);
  const dotIndex = withoutPrefix.indexOf('.');
  if (dotIndex === -1) {
    // No path after stepId — nothing to resolve
    return undefined;
  }

  const stepId = withoutPrefix.slice(0, dotIndex);
  const path = withoutPrefix.slice(dotIndex + 1);

  const stepResult = results.get(stepId);
  if (stepResult === undefined) {
    return undefined;
  }

  // `status` lives directly on StepResultRef; everything else is nested
  if (path === 'status') {
    return stepResult.status;
  }

  // Navigate into the StepResultRef as a generic object so callers can
  // reference `result.data.value` etc.
  return resolvePath(stepResult, path);
}

// ---------------------------------------------------------------------------
// ConditionEvaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates `StepCondition` objects against accumulated step results.
 *
 * Used by Axis during plan execution to decide whether a conditional step
 * should run.  The evaluator is intentionally conservative: any unresolvable
 * field or type mismatch returns `false` (safe default — skip the step).
 */
export class ConditionEvaluator {
  /**
   * Evaluate a single StepCondition against the current step results.
   *
   * The `field` uses dot-path notation referencing step results:
   * - `step:<stepId>.status` — the step's status
   * - `step:<stepId>.result.data.value` — nested path in step result
   *
   * Operators:
   * - `eq`:       field value === condition value (with numeric coercion)
   * - `neq`:      field value !== condition value (negation of eq)
   * - `gt`:       field value > condition value (numeric)
   * - `lt`:       field value < condition value (numeric)
   * - `contains`: string includes substring, or array includes value
   * - `exists`:   field value is not undefined/null
   *
   * Returns `false` if the referenced step or field does not exist (safe default).
   */
  evaluate(
    condition: StepCondition,
    results: Map<string, StepResultRef>,
  ): boolean {
    const fieldValue = resolveField(condition.field, results);

    switch (condition.operator) {
      case 'eq':
        return isEq(fieldValue, condition.value);
      case 'neq':
        return !isEq(fieldValue, condition.value);
      case 'gt':
        return isGt(fieldValue, condition.value);
      case 'lt':
        return isLt(fieldValue, condition.value);
      case 'contains':
        return doesContain(fieldValue, condition.value);
      case 'exists':
        return doesExist(fieldValue);
      default:
        return false;
    }
  }
}
