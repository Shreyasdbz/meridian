// Approval Dialog — Phase 7.5 (Section 5.5.3)
// Presents Sentinel escalations to the user in plain language.
// Supports single-action and multi-step plan approval.

import { useCallback, useRef } from 'react';

import type { RiskLevel } from '@meridian/shared';

import { api } from '../../hooks/use-api.js';
import { getComponentLabel } from '../../lib/vocabulary.js';
import { useApprovalStore } from '../../stores/approval-store.js';
import { Badge } from '../badge.js';
import { Button } from '../button.js';

import { RiskIndicator } from './risk-indicator.js';
import { StandingRuleBanner } from './standing-rule-banner.js';
import { StepChecklist } from './step-checklist.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a plain-language summary from the plan (Section 5.5.5). */
function buildSummary(
  plan: { steps: Array<{ gear: string; action: string; description?: string }> },
  reasoning?: string,
): string {
  if (reasoning) return reasoning;

  if (plan.steps.length === 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const step = plan.steps[0]!;
    return step.description ?? `Use ${getComponentLabel('gear').toLowerCase()} "${step.gear}" to ${step.action}`;
  }

  return `Perform ${String(plan.steps.length)} actions to complete this task`;
}

/** Compute the highest risk level across steps. */
function highestRisk(
  risks: Array<{ riskLevel?: RiskLevel }>,
  steps: Array<{ riskLevel: RiskLevel }>,
): RiskLevel {
  const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  let max = 0;

  for (const r of risks) {
    const idx = levels.indexOf(r.riskLevel ?? 'low');
    if (idx > max) max = idx;
  }
  for (const s of steps) {
    const idx = levels.indexOf(s.riskLevel);
    if (idx > max) max = idx;
  }

  return levels[max] ?? 'low';
}

/** Collect unique risk categories from step validations. */
function collectCategories(risks: Array<{ category?: string }>): string[] {
  const cats = new Set<string>();
  for (const r of risks) {
    if (r.category) cats.add(r.category);
  }
  return [...cats];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Approval dialog for Sentinel escalations (Section 5.5.3).
 *
 * Shows a plain-language summary, color-coded step checklist, and
 * Approve / Details / Reject actions. For multi-step plans, offers
 * a "Review individually" option for per-step approve/deny.
 *
 * Calls POST /api/jobs/:id/approve with per-job nonce.
 */
export function ApprovalDialog(): React.ReactElement | null {
  const current = useApprovalStore((s) => s.current);
  const detailsExpanded = useApprovalStore((s) => s.detailsExpanded);
  const reviewIndividually = useApprovalStore((s) => s.reviewIndividually);
  const stepDecisions = useApprovalStore((s) => s.stepDecisions);
  const rejectReason = useApprovalStore((s) => s.rejectReason);
  const isSubmitting = useApprovalStore((s) => s.isSubmitting);
  const standingRuleSuggestion = useApprovalStore((s) => s.standingRuleSuggestion);

  const toggleDetails = useApprovalStore((s) => s.toggleDetails);
  const setReviewIndividually = useApprovalStore((s) => s.setReviewIndividually);
  const setStepVerdict = useApprovalStore((s) => s.setStepVerdict);
  const setRejectReason = useApprovalStore((s) => s.setRejectReason);
  const setSubmitting = useApprovalStore((s) => s.setSubmitting);
  const dequeue = useApprovalStore((s) => s.dequeue);
  const recordApproval = useApprovalStore((s) => s.recordApproval);
  const dismissStandingRuleSuggestion = useApprovalStore((s) => s.dismissStandingRuleSuggestion);

  const dialogRef = useRef<HTMLDialogElement>(null);

  // Sync dialog open state with current request
  const isOpen = current !== null;
  if (dialogRef.current) {
    if (isOpen && !dialogRef.current.open) {
      dialogRef.current.showModal();
    } else if (!isOpen && dialogRef.current.open) {
      dialogRef.current.close();
    }
  }

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const handleApprove = useCallback(async (): Promise<void> => {
    if (!current) return;
    setSubmitting(true);

    try {
      await api.post(`/jobs/${current.jobId}/approve`, { nonce: current.nonce });

      // Track approval categories for standing rule suggestion
      const categories = collectCategories(current.risks);
      if (categories.length > 0) {
        recordApproval(categories);
      }

      dequeue();
    } catch {
      // Server will send updated status via WebSocket; dialog remains open
      setSubmitting(false);
    }
  }, [current, setSubmitting, dequeue, recordApproval]);

  const handleReject = useCallback(async (): Promise<void> => {
    if (!current) return;
    setSubmitting(true);

    try {
      await api.post(`/jobs/${current.jobId}/reject`, {
        reason: rejectReason || undefined,
      });
      dequeue();
    } catch {
      setSubmitting(false);
    }
  }, [current, rejectReason, setSubmitting, dequeue]);

  const handleApproveIndividual = useCallback(async (): Promise<void> => {
    if (!current) return;

    // If any step is rejected, reject the whole job
    const hasRejected = stepDecisions.some((d) => d.verdict === 'rejected');
    if (hasRejected) {
      await handleReject();
      return;
    }

    // If all steps approved, approve the job
    const allApproved = stepDecisions.every((d) => d.verdict === 'approved');
    if (allApproved) {
      await handleApprove();
    }
  }, [current, stepDecisions, handleApprove, handleReject]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDialogElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Don't close on Escape — user must explicitly approve or reject
    }
  }, []);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (!current) return null;

  const { plan, risks } = current;
  const steps = plan.steps;
  const overallRisk = highestRisk(risks, steps);
  const summary = buildSummary(plan, plan.reasoning);
  const isMultiStep = steps.length > 1;

  const allStepsDecided = reviewIndividually && stepDecisions.every((d) => d.verdict !== 'pending');
  const hasRejectedStep = reviewIndividually && stepDecisions.some((d) => d.verdict === 'rejected');

  const taskName = typeof current.plan.metadata?.taskName === 'string'
    ? current.plan.metadata.taskName
    : undefined;

  return (
    <dialog
      ref={dialogRef}
      onKeyDown={handleKeyDown}
      className="m-auto max-w-xl rounded-xl border border-gray-200 bg-white p-0 shadow-xl backdrop:bg-black/50 dark:border-gray-700 dark:bg-gray-900"
      aria-label="Approval required"
      aria-modal="true"
      data-testid="approval-dialog"
    >
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Shield icon */}
              <svg
                className="h-5 w-5 shrink-0 text-yellow-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                />
              </svg>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                I need your OK before proceeding
              </h2>
            </div>
            {taskName && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {taskName}
              </p>
            )}
          </div>
          <RiskIndicator level={overallRisk} />
        </div>

        {/* Plain-language summary */}
        <div className="mt-4 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
          <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="approval-summary">
            {summary}
          </p>
        </div>

        {/* Standing rule suggestion */}
        {standingRuleSuggestion && (
          <div className="mt-3">
            <StandingRuleBanner
              category={standingRuleSuggestion}
              onDismiss={dismissStandingRuleSuggestion}
            />
          </div>
        )}

        {/* Step checklist */}
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {steps.length === 1 ? '1 step' : `${String(steps.length)} steps`}
            </h3>
            {isMultiStep && !reviewIndividually && (
              <button
                className="text-xs font-medium text-meridian-600 hover:text-meridian-700 dark:text-meridian-400 dark:hover:text-meridian-300"
                onClick={() => { setReviewIndividually(true); }}
                data-testid="review-individually-button"
              >
                Review individually
              </button>
            )}
            {isMultiStep && reviewIndividually && (
              <button
                className="text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                onClick={() => { setReviewIndividually(false); }}
                data-testid="review-all-button"
              >
                Review all at once
              </button>
            )}
          </div>

          <div className="mt-2">
            <StepChecklist
              steps={steps}
              risks={risks}
              reviewIndividually={reviewIndividually}
              stepDecisions={stepDecisions}
              onStepVerdict={setStepVerdict}
            />
          </div>
        </div>

        {/* Details expansion (raw plan JSON) */}
        {detailsExpanded && (
          <div className="mt-4" data-testid="plan-details">
            <h3 className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
              Plan Details
            </h3>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
              {JSON.stringify(plan, null, 2)}
            </pre>
          </div>
        )}

        {/* Reject reason (shown when not in individual review mode) */}
        {!reviewIndividually && (
          <div className="mt-4">
            <label
              htmlFor="reject-reason"
              className="block text-xs font-medium text-gray-500 dark:text-gray-400"
            >
              Reason for rejection (optional)
            </label>
            <input
              id="reject-reason"
              type="text"
              value={rejectReason}
              onChange={(e) => { setRejectReason(e.target.value); }}
              placeholder="Why are you rejecting this?"
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-meridian-500 focus:outline-none focus:ring-1 focus:ring-meridian-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
              data-testid="reject-reason-input"
            />
          </div>
        )}

        {/* Safety check attribution (Section 5.5.5) */}
        <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
          This {getComponentLabel('sentinel').toLowerCase()} flagged this action for your review.
        </p>

        {/* Action buttons */}
        <div className="mt-4 flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleDetails}
            data-testid="details-button"
          >
            {detailsExpanded ? 'Hide details' : 'Details'}
          </Button>

          <div className="flex items-center gap-2">
            {/* Queue indicator */}
            {useApprovalStore.getState().queue.length > 1 && (
              <Badge variant="default">
                {String(useApprovalStore.getState().queue.length)} pending
              </Badge>
            )}

            {reviewIndividually ? (
              <Button
                variant="primary"
                size="md"
                onClick={() => { void handleApproveIndividual(); }}
                disabled={isSubmitting || !allStepsDecided}
                data-testid="submit-individual-button"
              >
                {hasRejectedStep ? 'Reject' : 'Approve'}
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => { void handleReject(); }}
                  disabled={isSubmitting}
                  data-testid="reject-button"
                >
                  Reject
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => { void handleApprove(); }}
                  disabled={isSubmitting}
                  data-testid="approve-button"
                >
                  Approve
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
