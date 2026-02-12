// @meridian/sentinel — Approval flow (Section 5.3.4)
// Routes validation verdicts to their corresponding job state transitions.
// Handles the four outcomes: approved, needs_revision, needs_user_approval, rejected.

import type {
  ExecutionPlan,
  Job,
  Logger,
  StepValidation,
  ValidationResult,
} from '@meridian/shared';
import { MAX_REVISION_COUNT, generateId } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome produced by routing a validation verdict.
 * Tells Axis what job state transition to perform and what data to include.
 */
export type ApprovalOutcome =
  | ApprovedOutcome
  | NeedsRevisionOutcome
  | NeedsUserApprovalOutcome
  | RejectedOutcome;

export interface ApprovedOutcome {
  action: 'execute';
  jobStatus: 'executing';
}

export interface NeedsRevisionOutcome {
  action: 'revise';
  jobStatus: 'planning';
  revisionCount: number;
  suggestedRevisions?: string;
}

export interface NeedsUserApprovalOutcome {
  action: 'request_approval';
  jobStatus: 'awaiting_approval';
  approvalRequest: ApprovalRequest;
}

export interface RejectedOutcome {
  action: 'reject';
  jobStatus: 'failed';
  reason: string;
}

/**
 * Structured approval request sent to Bridge for user display.
 * Contains a human-readable summary and per-step risk breakdowns
 * so the UI can render an informed approval dialog.
 */
export interface ApprovalRequest {
  id: string;
  jobId: string;
  planId: string;
  summary: string;
  steps: ApprovalStepSummary[];
  overallRisk: string;
  metadata?: Record<string, unknown>;
}

/**
 * Per-step summary included in an approval request.
 */
export interface ApprovalStepSummary {
  stepId: string;
  description: string;
  gear: string;
  action: string;
  verdict: string;
  riskLevel: string;
  reasoning?: string;
}

/**
 * User's response to an approval request, received from Bridge.
 */
export interface ApprovalResponse {
  jobId: string;
  approved: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Outcome after processing a user's approval response.
 */
export type UserApprovalOutcome =
  | { action: 'execute'; jobStatus: 'executing' }
  | { action: 'cancel'; jobStatus: 'cancelled'; reason: string };

// ---------------------------------------------------------------------------
// Verdict routing
// ---------------------------------------------------------------------------

/**
 * Route a validation verdict to the corresponding job state transition.
 *
 * Per Section 5.3.4:
 * - `approved` → Axis executes the plan
 * - `needs_revision` → Scout revises (respects MAX_REVISION_COUNT)
 * - `needs_user_approval` → Bridge prompts the user
 * - `rejected` → Job fails with explanation
 *
 * @param validation - The validation result from the policy engine
 * @param plan - The execution plan that was validated
 * @param job - The current job (used for revision count tracking)
 * @param logger - Logger instance
 */
export function routeVerdict(
  validation: ValidationResult,
  plan: ExecutionPlan,
  job: Job,
  logger: Logger,
): ApprovalOutcome {
  switch (validation.verdict) {
    case 'approved':
      return handleApproved(validation, logger);

    case 'needs_revision':
      return handleNeedsRevision(validation, job, logger);

    case 'needs_user_approval':
      return handleNeedsUserApproval(validation, plan, job, logger);

    case 'rejected':
      return handleRejected(validation, logger);

    default: {
      // Exhaustiveness check
      const _exhaustive: never = validation.verdict;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Verdict handlers
// ---------------------------------------------------------------------------

function handleApproved(
  validation: ValidationResult,
  logger: Logger,
): ApprovedOutcome {
  logger.info('Plan approved, transitioning to execution', {
    planId: validation.planId,
    overallRisk: validation.overallRisk,
  });

  return {
    action: 'execute',
    jobStatus: 'executing',
  };
}

function handleNeedsRevision(
  validation: ValidationResult,
  job: Job,
  logger: Logger,
): NeedsRevisionOutcome | RejectedOutcome {
  const currentCount = job.revisionCount ?? 0;

  if (currentCount >= MAX_REVISION_COUNT) {
    logger.warn('Revision limit reached, rejecting plan', {
      planId: validation.planId,
      revisionCount: currentCount,
      maxRevisions: MAX_REVISION_COUNT,
    });

    return {
      action: 'reject',
      jobStatus: 'failed',
      reason:
        `Plan revision limit reached (${MAX_REVISION_COUNT} attempts). ` +
        `Last issue: ${validation.suggestedRevisions ?? validation.reasoning ?? 'Unknown'}`,
    };
  }

  const nextCount = currentCount + 1;

  logger.info('Plan needs revision, returning to Scout', {
    planId: validation.planId,
    revisionCount: nextCount,
    maxRevisions: MAX_REVISION_COUNT,
    suggestedRevisions: validation.suggestedRevisions,
  });

  return {
    action: 'revise',
    jobStatus: 'planning',
    revisionCount: nextCount,
    suggestedRevisions: validation.suggestedRevisions,
  };
}

function handleNeedsUserApproval(
  validation: ValidationResult,
  plan: ExecutionPlan,
  job: Job,
  logger: Logger,
): NeedsUserApprovalOutcome {
  const approvalRequest = buildApprovalRequest(validation, plan, job);

  logger.info('Plan requires user approval', {
    planId: validation.planId,
    approvalRequestId: approvalRequest.id,
    overallRisk: validation.overallRisk,
    stepsNeedingApproval: validation.stepResults
      .filter((s) => s.verdict === 'needs_user_approval')
      .map((s) => s.stepId),
  });

  return {
    action: 'request_approval',
    jobStatus: 'awaiting_approval',
    approvalRequest,
  };
}

function handleRejected(
  validation: ValidationResult,
  logger: Logger,
): RejectedOutcome {
  const reason = buildRejectionReason(validation);

  logger.warn('Plan rejected by Sentinel', {
    planId: validation.planId,
    overallRisk: validation.overallRisk,
    reason,
    rejectedSteps: validation.stepResults
      .filter((s) => s.verdict === 'rejected')
      .map((s) => ({ stepId: s.stepId, reasoning: s.reasoning })),
  });

  return {
    action: 'reject',
    jobStatus: 'failed',
    reason,
  };
}

// ---------------------------------------------------------------------------
// User approval response handling
// ---------------------------------------------------------------------------

/**
 * Process a user's response to an approval request.
 *
 * Per Section 5.3.4:
 * - User approves → job transitions to `executing`
 * - User rejects → job transitions to `cancelled`
 */
export function processUserApproval(
  response: ApprovalResponse,
  logger: Logger,
): UserApprovalOutcome {
  if (response.approved) {
    logger.info('User approved plan execution', {
      jobId: response.jobId,
    });

    return {
      action: 'execute',
      jobStatus: 'executing',
    };
  }

  const reason = response.reason ?? 'User rejected the execution plan';

  logger.info('User rejected plan execution', {
    jobId: response.jobId,
    reason,
  });

  return {
    action: 'cancel',
    jobStatus: 'cancelled',
    reason,
  };
}

// ---------------------------------------------------------------------------
// Approval request construction
// ---------------------------------------------------------------------------

/**
 * Build a structured approval request for Bridge to render.
 * Includes plain-language summaries and per-step risk indicators.
 */
function buildApprovalRequest(
  validation: ValidationResult,
  plan: ExecutionPlan,
  job: Job,
): ApprovalRequest {
  const steps = buildStepSummaries(validation, plan);
  const summary = buildPlanSummary(validation, steps);

  return {
    id: generateId(),
    jobId: job.id,
    planId: plan.id,
    summary,
    steps,
    overallRisk: validation.overallRisk ?? 'unknown',
    metadata: validation.metadata,
  };
}

/**
 * Build per-step approval summaries combining plan step info
 * with validation results.
 */
function buildStepSummaries(
  validation: ValidationResult,
  plan: ExecutionPlan,
): ApprovalStepSummary[] {
  return validation.stepResults.map((stepResult) => {
    const planStep = plan.steps.find((s) => s.id === stepResult.stepId);

    return {
      stepId: stepResult.stepId,
      description: planStep?.description ?? `${planStep?.gear ?? 'unknown'}:${planStep?.action ?? 'unknown'}`,
      gear: planStep?.gear ?? 'unknown',
      action: planStep?.action ?? 'unknown',
      verdict: stepResult.verdict,
      riskLevel: stepResult.riskLevel ?? 'unknown',
      reasoning: stepResult.reasoning,
    };
  });
}

/**
 * Build a plain-language summary of what the plan wants to do.
 */
function buildPlanSummary(
  validation: ValidationResult,
  steps: ApprovalStepSummary[],
): string {
  const totalSteps = steps.length;
  const approvalNeeded = steps.filter(
    (s) => s.verdict === 'needs_user_approval',
  );
  const rejected = steps.filter((s) => s.verdict === 'rejected');

  const parts: string[] = [];

  parts.push(
    `This plan has ${totalSteps} step${totalSteps === 1 ? '' : 's'}.`,
  );

  if (approvalNeeded.length > 0) {
    parts.push(
      `${approvalNeeded.length} step${approvalNeeded.length === 1 ? '' : 's'} ` +
        `require${approvalNeeded.length === 1 ? 's' : ''} your approval:`,
    );

    for (const step of approvalNeeded) {
      const risk = step.riskLevel !== 'unknown' ? ` [${step.riskLevel} risk]` : '';
      parts.push(`  - ${step.description}${risk}`);
    }
  }

  if (rejected.length > 0) {
    parts.push(
      `${rejected.length} step${rejected.length === 1 ? ' was' : 's were'} rejected:`,
    );

    for (const step of rejected) {
      parts.push(`  - ${step.description}: ${step.reasoning ?? 'No reason provided'}`);
    }
  }

  if (validation.reasoning) {
    parts.push(`Note: ${validation.reasoning}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Rejection reason construction
// ---------------------------------------------------------------------------

/**
 * Build a human-readable rejection reason from the validation result.
 */
function buildRejectionReason(validation: ValidationResult): string {
  const rejectedSteps = validation.stepResults.filter(
    (s) => s.verdict === 'rejected',
  );

  if (rejectedSteps.length === 0) {
    return validation.reasoning ?? 'Plan rejected by safety validator';
  }

  const reasons = rejectedSteps.map((s) => formatStepRejection(s));

  if (validation.reasoning) {
    reasons.push(validation.reasoning);
  }

  return reasons.join('; ');
}

function formatStepRejection(step: StepValidation): string {
  const prefix = step.category ? `[${step.category}] ` : '';
  return `${prefix}Step ${step.stepId}: ${step.reasoning ?? 'Rejected'}`;
}
