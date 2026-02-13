// @meridian/sentinel — Plan stripper (Section 5.3.2/5.3.7)
//
// Strips all non-required fields from ExecutionPlan and ExecutionStep
// before Sentinel review. This prevents a compromised Scout from embedding
// persuasive framing, justifications, or emotional language in free-form
// fields (e.g., reasoning, description, metadata) that might influence
// Sentinel's judgment.
//
// After stripping, Sentinel receives ONLY:
// - ExecutionPlan: id, jobId, steps
// - ExecutionStep: id, gear, action, parameters, riskLevel
//
// Acknowledged limitation (Section 5.3.2): the `parameters` field inherently
// carries user intent (e.g., a filename, URL, message body) and cannot be
// stripped without breaking Sentinel's ability to assess the plan.

import type { ExecutionPlan, ExecutionStep } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A stripped execution step containing only the fields Sentinel needs
 * for safety evaluation. All optional/free-form fields are removed.
 */
export interface StrippedExecutionStep {
  id: string;
  gear: string;
  action: string;
  parameters: Record<string, unknown>;
  riskLevel: ExecutionStep['riskLevel'];
}

/**
 * A stripped execution plan containing only the fields Sentinel needs.
 * All optional fields (reasoning, estimatedDurationMs, estimatedCost,
 * journalSkip, metadata) are removed.
 */
export interface StrippedExecutionPlan {
  id: string;
  jobId: string;
  steps: StrippedExecutionStep[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip an execution step down to its required fields only.
 *
 * Removes: description, order, dependsOn, parallelGroup, rollback,
 * condition, metadata, and any other non-required fields.
 *
 * Preserves: id, gear, action, parameters, riskLevel.
 */
export function stripStep(step: ExecutionStep): StrippedExecutionStep {
  return {
    id: step.id,
    gear: step.gear,
    action: step.action,
    parameters: step.parameters,
    riskLevel: step.riskLevel,
  };
}

/**
 * Strip an execution plan down to its required fields only.
 *
 * Removes: reasoning, estimatedDurationMs, estimatedCost, journalSkip,
 * metadata, and any other non-required fields from both the plan and
 * each step within it.
 *
 * Preserves: id, jobId, steps (each stripped to required fields).
 *
 * This is a critical security function — it prevents a compromised Scout
 * from embedding persuasive content in optional fields that might influence
 * Sentinel's LLM-based validation.
 */
export function stripPlan(plan: ExecutionPlan): StrippedExecutionPlan {
  return {
    id: plan.id,
    jobId: plan.jobId,
    steps: plan.steps.map(stripStep),
  };
}
