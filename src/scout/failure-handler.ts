// @meridian/scout — LLM failure mode handling (Section 5.2.7)
//
// Handles various LLM failure modes gracefully:
// - Malformed JSON: retry up to 2 times with parse error in prompt
// - Model refusal: retry once with rephrase; if refused again, escalate to user
// - Infinite replanning: break at revisionCount >= 3 or replanCount >= 2
// - Truncated output: retry with reduced context
// - Empty/nonsensical output: retry once, then fail
// - Repetitive output: fail immediately (model is stuck)
//
// All retries are counted against the job's revisionCount limit.

import type { ExecutionPlan } from '@meridian/shared';
import { MAX_REVISION_COUNT, MAX_REPLAN_COUNT } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The type of LLM failure detected. */
export type FailureType =
  | 'malformed_json'
  | 'model_refusal'
  | 'infinite_replanning'
  | 'truncated_output'
  | 'empty_output'
  | 'nonsensical_output'
  | 'repetitive_output';

/** What the failure handler recommends. */
export type FailureAction =
  | 'retry'
  | 'retry_with_error'
  | 'retry_with_rephrase'
  | 'retry_with_reduced_context'
  | 'escalate_to_user'
  | 'fail';

/** Result of failure classification. */
export interface FailureClassification {
  type: FailureType;
  action: FailureAction;
  message: string;
  /** Additional context to include in the retry prompt, if applicable. */
  retryContext?: string;
}

/** Tracking state for a planning session's failure history. */
export interface PlanningFailureState {
  /** Number of revision cycles (Scout <-> Sentinel). */
  revisionCount: number;
  /** Number of replanning attempts within the current job. */
  replanCount: number;
  /** Number of malformed JSON retries in the current attempt. */
  malformedJsonRetries: number;
  /** Number of empty/nonsensical retries in the current attempt. */
  emptyRetries: number;
  /** Number of refusal retries in the current attempt. */
  refusalRetries: number;
  /** Number of truncated output retries in the current attempt. */
  truncatedRetries: number;
  /** Hash or fingerprint of the last plan for repetition detection. */
  lastPlanFingerprint?: string;
  /** Reason for last rejection (included in failure message for repetitive output). */
  lastRejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum malformed JSON retries before failing. */
const MAX_MALFORMED_JSON_RETRIES = 2;

/** Maximum refusal retries before escalating. */
const MAX_REFUSAL_RETRIES = 1;

/** Maximum empty output retries before failing. */
const MAX_EMPTY_RETRIES = 1;

/** Maximum truncated output retries before failing. */
const MAX_TRUNCATED_RETRIES = 1;

// ---------------------------------------------------------------------------
// Plan fingerprinting
// ---------------------------------------------------------------------------

/**
 * Compute a structural fingerprint of an ExecutionPlan for repetition detection.
 * Compares the structural shape (gear names, actions, parameter keys) rather
 * than exact content, to catch semantically identical plans.
 */
export function computePlanFingerprint(plan: ExecutionPlan): string {
  const stepSignatures = plan.steps.map((step) => {
    const paramKeys = Object.keys(step.parameters).sort().join(',');
    return `${step.gear}:${step.action}[${paramKeys}]@${step.riskLevel}`;
  });
  return stepSignatures.sort().join('|');
}

// ---------------------------------------------------------------------------
// Failure detection
// ---------------------------------------------------------------------------

/**
 * Detect if raw LLM output represents a model refusal.
 * Refusals typically contain specific phrases indicating the model
 * declined to produce a plan.
 */
export function isModelRefusal(raw: string): boolean {
  const refusalPatterns = [
    /I (?:cannot|can't|am unable to|won't|will not) (?:help|assist|do|create|generate|produce|make)/i,
    /I'm (?:sorry|afraid),? (?:but )?I (?:cannot|can't|am unable to|won't)/i,
    /(?:As an AI|As a language model),? I (?:cannot|can't)/i,
    /This (?:request|task) (?:violates|goes against|is against)/i,
    /I (?:must|have to) (?:decline|refuse)/i,
    /I'm not able to/i,
    /against my (?:guidelines|policies|programming|safety)/i,
  ];

  return refusalPatterns.some((pattern) => pattern.test(raw));
}

/**
 * Detect if raw output appears to be truncated.
 * Truncation typically manifests as incomplete JSON or text ending mid-sentence.
 */
export function isTruncatedOutput(raw: string): boolean {
  const trimmed = raw.trim();

  // Empty is not truncated — it's empty
  if (trimmed.length === 0) {
    return false;
  }

  // JSON that starts with { but doesn't end with }
  if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
    return true;
  }

  // JSON that starts with [ but doesn't end with ]
  if (trimmed.startsWith('[') && !trimmed.endsWith(']')) {
    return true;
  }

  // Text that ends mid-word (no terminal punctuation and last char is a letter)
  const lastChar = trimmed.at(-1);
  if (lastChar && /[a-zA-Z]/.test(lastChar)) {
    // Check if it looks like it was cut off (no sentence-ending punctuation nearby)
    const lastChunk = trimmed.slice(-50);
    if (!/[.!?:}\]"'`]/.test(lastChunk)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect if output is empty or nonsensical.
 * Nonsensical means: no steps in the plan, or steps reference nonexistent Gear
 * (we can't check Gear existence here, so we check for zero-step plans).
 */
export function isEmptyOrNonsensical(raw: string): boolean {
  const trimmed = raw.trim();

  // Completely empty
  if (trimmed.length === 0) {
    return true;
  }

  // Very short responses that don't convey meaningful content
  if (trimmed.length < 5) {
    return true;
  }

  // Try to parse as JSON plan and check for empty steps
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (Array.isArray(parsed['steps']) && parsed['steps'].length === 0) {
      return true;
    }
  } catch {
    // Not JSON — that's fine for fast-path text responses
  }

  return false;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Classify an LLM failure and determine the appropriate response action.
 *
 * @param raw - The raw LLM output
 * @param state - Current failure tracking state for this planning session
 * @param jsonParseError - If the output was expected to be JSON but failed to parse
 * @returns Classification with recommended action
 */
export function classifyFailure(
  raw: string,
  state: PlanningFailureState,
  jsonParseError?: string,
): FailureClassification {
  // Check infinite replanning limits first (Section 5.2.7)
  if (state.revisionCount >= MAX_REVISION_COUNT) {
    return {
      type: 'infinite_replanning',
      action: 'fail',
      message: `Planning loop limit reached: ${state.revisionCount} revision cycles (max ${MAX_REVISION_COUNT})`,
    };
  }

  if (state.replanCount >= MAX_REPLAN_COUNT) {
    return {
      type: 'infinite_replanning',
      action: 'fail',
      message: `Replanning limit reached: ${state.replanCount} replan attempts (max ${MAX_REPLAN_COUNT})`,
    };
  }

  // Malformed JSON
  if (jsonParseError) {
    if (state.malformedJsonRetries < MAX_MALFORMED_JSON_RETRIES) {
      return {
        type: 'malformed_json',
        action: 'retry_with_error',
        message: `Malformed JSON in plan output (attempt ${state.malformedJsonRetries + 1}/${MAX_MALFORMED_JSON_RETRIES})`,
        retryContext: `Your previous response contained invalid JSON. Parse error: ${jsonParseError}\n\nPlease produce valid JSON conforming to the ExecutionPlan schema.`,
      };
    }
    return {
      type: 'malformed_json',
      action: 'fail',
      message: `Malformed JSON in plan output after ${MAX_MALFORMED_JSON_RETRIES} retries: ${jsonParseError}`,
    };
  }

  // Model refusal
  if (isModelRefusal(raw)) {
    if (state.refusalRetries < MAX_REFUSAL_RETRIES) {
      return {
        type: 'model_refusal',
        action: 'retry_with_rephrase',
        message: `Model refused to produce a plan (attempt ${state.refusalRetries + 1}/${MAX_REFUSAL_RETRIES})`,
        retryContext: 'Please reconsider and produce an execution plan for this task. If you truly cannot help with this specific request, explain why in a brief text response.',
      };
    }
    return {
      type: 'model_refusal',
      action: 'escalate_to_user',
      message: `Model refused to produce a plan after retry. Refusal: ${raw.slice(0, 200)}`,
    };
  }

  // Truncated output
  if (isTruncatedOutput(raw)) {
    if (state.truncatedRetries < MAX_TRUNCATED_RETRIES) {
      return {
        type: 'truncated_output',
        action: 'retry_with_reduced_context',
        message: `Output appears truncated (attempt ${state.truncatedRetries + 1}/${MAX_TRUNCATED_RETRIES})`,
        retryContext: 'Your previous response was truncated. Please produce a complete response.',
      };
    }
    return {
      type: 'truncated_output',
      action: 'fail',
      message: 'Output truncated after retry with reduced context',
    };
  }

  // Empty or nonsensical output
  if (isEmptyOrNonsensical(raw)) {
    if (state.emptyRetries < MAX_EMPTY_RETRIES) {
      return {
        type: 'empty_output',
        action: 'retry',
        message: `Empty or nonsensical output (attempt ${state.emptyRetries + 1}/${MAX_EMPTY_RETRIES})`,
        retryContext: 'Your previous response was empty or did not contain meaningful content. Please try again.',
      };
    }
    return {
      type: 'empty_output',
      action: 'fail',
      message: 'Empty or nonsensical output after retry',
    };
  }

  // If nothing else matched, this is an unexpected failure
  return {
    type: 'empty_output',
    action: 'fail',
    message: `Unclassifiable LLM output failure`,
  };
}

/**
 * Check if a plan is repetitive (structurally identical to the previous
 * rejected plan). If so, fail immediately — the model is stuck.
 *
 * @returns Classification if repetitive, undefined if not
 */
export function checkRepetitiveOutput(
  plan: ExecutionPlan,
  state: PlanningFailureState,
): FailureClassification | undefined {
  const fingerprint = computePlanFingerprint(plan);

  if (state.lastPlanFingerprint && fingerprint === state.lastPlanFingerprint) {
    const reason = state.lastRejectionReason
      ? ` Last rejection reason: ${state.lastRejectionReason}`
      : '';
    return {
      type: 'repetitive_output',
      action: 'fail',
      message: `Plan is structurally identical to the previous rejected plan — model is stuck.${reason}`,
    };
  }

  return undefined;
}

/**
 * Create a fresh failure state for a new planning session.
 */
export function createFailureState(): PlanningFailureState {
  return {
    revisionCount: 0,
    replanCount: 0,
    malformedJsonRetries: 0,
    emptyRetries: 0,
    refusalRetries: 0,
    truncatedRetries: 0,
  };
}

/**
 * Increment the appropriate retry counter in the failure state
 * based on the failure classification.
 */
export function incrementRetryCount(
  state: PlanningFailureState,
  failureType: FailureType,
): void {
  switch (failureType) {
    case 'malformed_json':
      state.malformedJsonRetries++;
      break;
    case 'model_refusal':
      state.refusalRetries++;
      break;
    case 'truncated_output':
      state.truncatedRetries++;
      break;
    case 'empty_output':
    case 'nonsensical_output':
      state.emptyRetries++;
      break;
  }
  // revisionCount is incremented by the caller (planner) after each revision cycle
}

/**
 * Record a rejected plan's fingerprint for repetition detection.
 */
export function recordRejectedPlan(
  state: PlanningFailureState,
  plan: ExecutionPlan,
  rejectionReason: string,
): void {
  state.lastPlanFingerprint = computePlanFingerprint(plan);
  state.lastRejectionReason = rejectionReason;
}
