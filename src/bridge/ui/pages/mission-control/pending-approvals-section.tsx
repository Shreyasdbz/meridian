// Pending Approvals section of Mission Control (Section 5.5.2).
// Always-visible, prominent placement for actions waiting on user confirmation.

import { useCallback, useState } from 'react';

import type { ExecutionStep, Job } from '@meridian/shared';

import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { api } from '../../hooks/use-api.js';

interface PendingApprovalsSectionProps {
  jobs: Job[];
  onSelectJob?: (jobId: string) => void;
}

/**
 * Renders pending approval cards with Approve/Reject actions.
 * Per architecture 5.5.2, this section has "always-visible, prominent placement".
 */
export function PendingApprovalsSection({ jobs, onSelectJob }: PendingApprovalsSectionProps): React.ReactElement {
  if (jobs.length === 0) {
    return (
      <section aria-label="Pending approvals">
        <SectionHeader count={0} />
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          No pending approvals
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Pending approvals">
      <SectionHeader count={jobs.length} />
      <div className="mt-3 space-y-3">
        {jobs.map((job) => (
          <ApprovalCard key={job.id} job={job} onSelect={onSelectJob} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ApprovalCard
// ---------------------------------------------------------------------------

interface ApprovalCardProps {
  job: Job;
  onSelect?: (jobId: string) => void;
}

function ApprovalCard({ job, onSelect }: ApprovalCardProps): React.ReactElement {
  const [responding, setResponding] = useState(false);

  const steps = job.plan?.steps ?? [];
  const overallRisk = job.validation?.overallRisk;

  // Build a meaningful task name from available data
  const taskName = deriveTaskName(job, steps);

  // Show validation reasoning, or fall back to plan reasoning
  const reason = job.validation?.reasoning ?? job.plan?.reasoning;

  const handleApprove = useCallback(async (): Promise<void> => {
    setResponding(true);
    try {
      // Fetch a one-time nonce first, then approve with it
      const { nonce } = await api.post<{ nonce: string }>(`/jobs/${job.id}/nonce`);
      await api.post(`/jobs/${job.id}/approve`, { nonce });
    } catch {
      // Server will send updated status via WebSocket
    } finally {
      setResponding(false);
    }
  }, [job.id]);

  const handleReject = useCallback(async (): Promise<void> => {
    setResponding(true);
    try {
      await api.post(`/jobs/${job.id}/reject`, {});
    } catch {
      // Server will send updated status via WebSocket
    } finally {
      setResponding(false);
    }
  }, [job.id]);

  return (
    <Card padding="sm" className="border-yellow-300 dark:border-yellow-600">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <svg
              className="h-4 w-4 shrink-0 text-yellow-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
            <button
              className="text-sm font-medium text-gray-900 hover:text-meridian-600 dark:text-gray-100 dark:hover:text-meridian-400"
              onClick={() => onSelect?.(job.id)}
            >
              {taskName}
            </button>
          </div>
          {reason && (
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              {reason}
            </p>
          )}
        </div>
        {overallRisk && (
          <Badge variant={overallRisk === 'high' || overallRisk === 'critical' ? 'danger' : 'warning'}>
            {overallRisk} risk
          </Badge>
        )}
      </div>

      {/* Steps summary */}
      {steps.length > 0 && (
        <ul className="mt-2 space-y-1">
          {steps.map((step) => (
            <li
              key={step.id}
              className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400"
            >
              <Badge
                variant={
                  step.riskLevel === 'high' || step.riskLevel === 'critical' ? 'danger' : 'default'
                }
              >
                {step.riskLevel}
              </Badge>
              <span>{step.description ?? step.action}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Action buttons */}
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => { void handleApprove(); }}
          disabled={responding}
        >
          Approve
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { void handleReject(); }}
          disabled={responding}
        >
          Reject
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a human-readable task name from job data, with sensible fallbacks. */
function deriveTaskName(job: Job, steps: ExecutionStep[]): string {
  // Explicit task name from metadata
  if (typeof job.metadata?.taskName === 'string' && job.metadata.taskName) {
    return job.metadata.taskName;
  }

  // Derive from plan reasoning (truncated)
  if (job.plan?.reasoning) {
    const reasoning = job.plan.reasoning;
    return reasoning.length > 60 ? `${reasoning.slice(0, 57)}...` : reasoning;
  }

  // Derive from single step description
  if (steps.length === 1 && steps[0]?.description) {
    return steps[0].description;
  }

  // Derive from step actions
  if (steps.length > 0) {
    const first = steps[0];
    if (first) {
      const action = first.description ?? `${first.gear}: ${first.action}`;
      if (steps.length === 1) return action;
      return `${action} (+${String(steps.length - 1)} more)`;
    }
  }

  return `Task ${job.id.slice(0, 8)}`;
}

function SectionHeader({ count }: { count: number }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Pending Approvals
      </h2>
      {count > 0 && (
        <Badge variant="warning">{count}</Badge>
      )}
    </div>
  );
}
