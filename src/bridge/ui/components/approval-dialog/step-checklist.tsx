import type { ExecutionStep, RiskLevel, StepValidation, StepValidationVerdict } from '@meridian/shared';

import type { StepDecision } from '../../stores/approval-store.js';
import { Button } from '../button.js';

import { RiskIndicator } from './risk-indicator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepChecklistProps {
  steps: ExecutionStep[];
  risks: StepValidation[];
  reviewIndividually: boolean;
  stepDecisions: StepDecision[];
  onStepVerdict?: (stepId: string, verdict: StepValidationVerdict) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the StepValidation for a given step, if one exists. */
function findRisk(risks: StepValidation[], stepId: string): StepValidation | undefined {
  return risks.find((r) => r.stepId === stepId);
}

/** Get a plain-language description of what this step does. */
function getStepSummary(step: ExecutionStep): string {
  if (step.description) return step.description;
  return `Use ${step.gear} to ${step.action}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Step checklist with color-coded risk indicators (Section 5.5.3).
 * Each step shows its risk level and, in individual review mode, approve/reject buttons.
 */
export function StepChecklist({
  steps,
  risks,
  reviewIndividually,
  stepDecisions,
  onStepVerdict,
}: StepChecklistProps): React.ReactElement {
  return (
    <ol className="space-y-2" aria-label="Plan steps">
      {steps.map((step, index) => {
        const risk = findRisk(risks, step.id);
        const riskLevel: RiskLevel = risk?.riskLevel ?? step.riskLevel;
        const decision = stepDecisions.find((d) => d.stepId === step.id);
        const verdict = decision?.verdict ?? 'pending';

        return (
          <li
            key={step.id}
            className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
            data-testid={`step-${step.id}`}
          >
            {/* Step number */}
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              {index + 1}
            </span>

            {/* Step details */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {getStepSummary(step)}
                </span>
                <RiskIndicator level={riskLevel} />
              </div>

              {/* Sentinel reasoning for this step */}
              {risk?.reasoning && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {risk.reasoning}
                </p>
              )}

              {/* Tool info */}
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Tool: {step.gear} &middot; Action: {step.action}
              </p>

              {/* Individual review mode: per-step approve/reject */}
              {reviewIndividually && (
                <div className="mt-2 flex items-center gap-2">
                  {verdict === 'pending' ? (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => onStepVerdict?.(step.id, 'approved')}
                        data-testid={`step-approve-${step.id}`}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onStepVerdict?.(step.id, 'rejected')}
                        data-testid={`step-reject-${step.id}`}
                      >
                        Reject
                      </Button>
                    </>
                  ) : (
                    <span
                      className={`text-xs font-medium ${
                        verdict === 'approved'
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                      data-testid={`step-verdict-${step.id}`}
                    >
                      {verdict === 'approved' ? 'Approved' : 'Rejected'}
                    </span>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
