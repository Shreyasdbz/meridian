// @meridian/scout — failure-handler tests (Phase 3.3)

import { describe, it, expect } from 'vitest';

import type { ExecutionPlan } from '@meridian/shared';

import {
  classifyFailure,
  checkRepetitiveOutput,
  computePlanFingerprint,
  createFailureState,
  incrementRetryCount,
  isModelRefusal,
  isTruncatedOutput,
  isEmptyOrNonsensical,
  recordRejectedPlan,
} from './failure-handler.js';
import type { PlanningFailureState } from './failure-handler.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: 'plan-001',
    jobId: 'job-001',
    steps: [
      {
        id: 'step-001',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/tmp/test.txt' },
        riskLevel: 'low',
      },
    ],
    ...overrides,
  };
}

function makeState(overrides?: Partial<PlanningFailureState>): PlanningFailureState {
  return { ...createFailureState(), ...overrides };
}

// ---------------------------------------------------------------------------
// isModelRefusal
// ---------------------------------------------------------------------------

describe('isModelRefusal', () => {
  it('should detect "I cannot help with"', () => {
    expect(isModelRefusal('I cannot help with this request.')).toBe(true);
  });

  it('should detect "I\'m sorry, but I cannot"', () => {
    expect(isModelRefusal("I'm sorry, but I cannot assist with this task.")).toBe(true);
  });

  it('should detect "As an AI, I cannot"', () => {
    expect(isModelRefusal('As an AI, I cannot perform destructive operations.')).toBe(true);
  });

  it('should detect "This request violates"', () => {
    expect(isModelRefusal('This request violates my safety guidelines.')).toBe(true);
  });

  it('should detect "against my guidelines"', () => {
    expect(isModelRefusal('That action is against my guidelines.')).toBe(true);
  });

  it('should not flag normal text', () => {
    expect(isModelRefusal('Here is the information you requested.')).toBe(false);
  });

  it('should not flag plan JSON', () => {
    expect(isModelRefusal('{"id":"p1","jobId":"j1","steps":[]}')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTruncatedOutput
// ---------------------------------------------------------------------------

describe('isTruncatedOutput', () => {
  it('should detect incomplete JSON (missing closing brace)', () => {
    expect(isTruncatedOutput('{"id":"plan-001","steps":[{"gear":"fi')).toBe(true);
  });

  it('should detect incomplete JSON array', () => {
    expect(isTruncatedOutput('[{"id":"step-1"},')).toBe(true);
  });

  it('should not flag empty string', () => {
    expect(isTruncatedOutput('')).toBe(false);
  });

  it('should not flag complete JSON', () => {
    expect(isTruncatedOutput('{"id":"plan-001","steps":[]}')).toBe(false);
  });

  it('should not flag normal text ending with punctuation', () => {
    expect(isTruncatedOutput('This is a complete sentence.')).toBe(false);
  });

  it('should detect text cut off mid-word without punctuation nearby', () => {
    // Produce a string that's >50 chars, all letters, ending mid-word
    const cutOff = 'This sentence was cut off mid word and there is no punctuation at all to be foun';
    expect(isTruncatedOutput(cutOff)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isEmptyOrNonsensical
// ---------------------------------------------------------------------------

describe('isEmptyOrNonsensical', () => {
  it('should detect empty string', () => {
    expect(isEmptyOrNonsensical('')).toBe(true);
  });

  it('should detect whitespace-only string', () => {
    expect(isEmptyOrNonsensical('   ')).toBe(true);
  });

  it('should detect very short responses', () => {
    expect(isEmptyOrNonsensical('ok')).toBe(true);
  });

  it('should detect plan with zero steps', () => {
    const plan = JSON.stringify({ id: 'p', jobId: 'j', steps: [] });
    expect(isEmptyOrNonsensical(plan)).toBe(true);
  });

  it('should not flag normal text', () => {
    expect(isEmptyOrNonsensical('Here is a normal response to your question.')).toBe(false);
  });

  it('should not flag valid plan JSON with steps', () => {
    const plan = JSON.stringify({
      id: 'p',
      jobId: 'j',
      steps: [{ id: 's', gear: 'g', action: 'a', parameters: {}, riskLevel: 'low' }],
    });
    expect(isEmptyOrNonsensical(plan)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computePlanFingerprint
// ---------------------------------------------------------------------------

describe('computePlanFingerprint', () => {
  it('should produce consistent fingerprints for identical plans', () => {
    const plan = makePlan();
    expect(computePlanFingerprint(plan)).toBe(computePlanFingerprint(plan));
  });

  it('should produce different fingerprints for different Gear', () => {
    const plan1 = makePlan();
    const plan2 = makePlan({
      steps: [
        { id: 'step-001', gear: 'web-search', action: 'read', parameters: { path: '/tmp/test.txt' }, riskLevel: 'low' },
      ],
    });
    expect(computePlanFingerprint(plan1)).not.toBe(computePlanFingerprint(plan2));
  });

  it('should produce the same fingerprint regardless of step order', () => {
    const plan1 = makePlan({
      steps: [
        { id: 's1', gear: 'a', action: 'x', parameters: {}, riskLevel: 'low' },
        { id: 's2', gear: 'b', action: 'y', parameters: {}, riskLevel: 'medium' },
      ],
    });
    const plan2 = makePlan({
      steps: [
        { id: 's2', gear: 'b', action: 'y', parameters: {}, riskLevel: 'medium' },
        { id: 's1', gear: 'a', action: 'x', parameters: {}, riskLevel: 'low' },
      ],
    });
    expect(computePlanFingerprint(plan1)).toBe(computePlanFingerprint(plan2));
  });

  it('should differ when parameter keys differ', () => {
    const plan1 = makePlan({
      steps: [{ id: 's', gear: 'g', action: 'a', parameters: { path: '/tmp' }, riskLevel: 'low' }],
    });
    const plan2 = makePlan({
      steps: [{ id: 's', gear: 'g', action: 'a', parameters: { url: 'http://x' }, riskLevel: 'low' }],
    });
    expect(computePlanFingerprint(plan1)).not.toBe(computePlanFingerprint(plan2));
  });
});

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

describe('classifyFailure', () => {
  it('should recommend retry_with_error for first malformed JSON failure', () => {
    const state = makeState();
    const result = classifyFailure('', state, 'Unexpected token at position 42');
    expect(result.type).toBe('malformed_json');
    expect(result.action).toBe('retry_with_error');
    expect(result.retryContext).toContain('Unexpected token at position 42');
  });

  it('should fail after MAX_MALFORMED_JSON_RETRIES malformed JSON failures', () => {
    const state = makeState({ malformedJsonRetries: 2 });
    const result = classifyFailure('', state, 'Still broken');
    expect(result.type).toBe('malformed_json');
    expect(result.action).toBe('fail');
  });

  it('should recommend retry_with_rephrase for first model refusal', () => {
    const state = makeState();
    const result = classifyFailure("I'm sorry, but I cannot help with that request.", state);
    expect(result.type).toBe('model_refusal');
    expect(result.action).toBe('retry_with_rephrase');
  });

  it('should escalate to user after MAX_REFUSAL_RETRIES refusals', () => {
    const state = makeState({ refusalRetries: 1 });
    const result = classifyFailure("I cannot assist with this.", state);
    expect(result.type).toBe('model_refusal');
    expect(result.action).toBe('escalate_to_user');
  });

  it('should recommend retry for first empty output', () => {
    const state = makeState();
    const result = classifyFailure('', state);
    expect(result.type).toBe('empty_output');
    expect(result.action).toBe('retry');
  });

  it('should fail after MAX_EMPTY_RETRIES empty outputs', () => {
    const state = makeState({ emptyRetries: 1 });
    const result = classifyFailure('', state);
    expect(result.type).toBe('empty_output');
    expect(result.action).toBe('fail');
  });

  it('should recommend retry_with_reduced_context for truncated output', () => {
    const state = makeState();
    const result = classifyFailure('{"id":"plan","steps":[{"gear":"fi', state);
    expect(result.type).toBe('truncated_output');
    expect(result.action).toBe('retry_with_reduced_context');
  });

  it('should fail after MAX_TRUNCATED_RETRIES truncated outputs', () => {
    const state = makeState({ truncatedRetries: 1 });
    const result = classifyFailure('{"id":"plan","steps":[{"gear":"fi', state);
    expect(result.type).toBe('truncated_output');
    expect(result.action).toBe('fail');
  });

  it('should fail on infinite replanning (revisionCount >= 3)', () => {
    const state = makeState({ revisionCount: 3 });
    const result = classifyFailure('any output', state);
    expect(result.type).toBe('infinite_replanning');
    expect(result.action).toBe('fail');
    expect(result.message).toContain('revision cycles');
  });

  it('should fail on infinite replanning (replanCount >= 2)', () => {
    const state = makeState({ replanCount: 2 });
    const result = classifyFailure('any output', state);
    expect(result.type).toBe('infinite_replanning');
    expect(result.action).toBe('fail');
    expect(result.message).toContain('replan attempts');
  });

  it('should check replanning limits before other failure types', () => {
    // Even with a malformed JSON error, replanning limits take precedence
    const state = makeState({ revisionCount: 3, malformedJsonRetries: 0 });
    const result = classifyFailure('', state, 'parse error');
    expect(result.type).toBe('infinite_replanning');
    expect(result.action).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// checkRepetitiveOutput
// ---------------------------------------------------------------------------

describe('checkRepetitiveOutput', () => {
  it('should return undefined for first plan', () => {
    const state = makeState();
    const plan = makePlan();
    expect(checkRepetitiveOutput(plan, state)).toBeUndefined();
  });

  it('should detect repetitive plan', () => {
    const plan = makePlan();
    const state = makeState();
    recordRejectedPlan(state, plan, 'unsafe action');

    const result = checkRepetitiveOutput(plan, state);
    expect(result).toBeDefined();
    expect(result?.type).toBe('repetitive_output');
    expect(result?.action).toBe('fail');
    expect(result?.message).toContain('model is stuck');
    expect(result?.message).toContain('unsafe action');
  });

  it('should not flag structurally different plan', () => {
    const plan1 = makePlan();
    const plan2 = makePlan({
      steps: [
        { id: 's', gear: 'web-search', action: 'search', parameters: { q: 'test' }, riskLevel: 'low' },
      ],
    });
    const state = makeState();
    recordRejectedPlan(state, plan1, 'rejected');

    expect(checkRepetitiveOutput(plan2, state)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// incrementRetryCount
// ---------------------------------------------------------------------------

describe('incrementRetryCount', () => {
  it('should increment malformedJsonRetries', () => {
    const state = makeState();
    incrementRetryCount(state, 'malformed_json');
    expect(state.malformedJsonRetries).toBe(1);
  });

  it('should increment refusalRetries', () => {
    const state = makeState();
    incrementRetryCount(state, 'model_refusal');
    expect(state.refusalRetries).toBe(1);
  });

  it('should increment truncatedRetries', () => {
    const state = makeState();
    incrementRetryCount(state, 'truncated_output');
    expect(state.truncatedRetries).toBe(1);
  });

  it('should increment emptyRetries for empty_output', () => {
    const state = makeState();
    incrementRetryCount(state, 'empty_output');
    expect(state.emptyRetries).toBe(1);
  });

  it('should increment emptyRetries for nonsensical_output', () => {
    const state = makeState();
    incrementRetryCount(state, 'nonsensical_output');
    expect(state.emptyRetries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createFailureState
// ---------------------------------------------------------------------------

describe('createFailureState', () => {
  it('should create a clean state with all counters at zero', () => {
    const state = createFailureState();
    expect(state.revisionCount).toBe(0);
    expect(state.replanCount).toBe(0);
    expect(state.malformedJsonRetries).toBe(0);
    expect(state.emptyRetries).toBe(0);
    expect(state.refusalRetries).toBe(0);
    expect(state.truncatedRetries).toBe(0);
    expect(state.lastPlanFingerprint).toBeUndefined();
    expect(state.lastRejectionReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordRejectedPlan
// ---------------------------------------------------------------------------

describe('recordRejectedPlan', () => {
  it('should store plan fingerprint and rejection reason', () => {
    const state = makeState();
    const plan = makePlan();
    recordRejectedPlan(state, plan, 'Undeclared network access');

    expect(state.lastPlanFingerprint).toBeDefined();
    expect(state.lastRejectionReason).toBe('Undeclared network access');
  });

  it('should overwrite previous fingerprint', () => {
    const state = makeState();
    const plan1 = makePlan();
    const plan2 = makePlan({
      steps: [{ id: 's', gear: 'x', action: 'y', parameters: {}, riskLevel: 'low' }],
    });

    recordRejectedPlan(state, plan1, 'reason 1');
    const fp1 = state.lastPlanFingerprint;

    recordRejectedPlan(state, plan2, 'reason 2');
    expect(state.lastPlanFingerprint).not.toBe(fp1);
    expect(state.lastRejectionReason).toBe('reason 2');
  });
});
