// Active Tasks section of Mission Control (Section 5.5.2).
// Displays real-time progress with step trackers, elapsed time, progress percentage, and Cancel button.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Job } from '@meridian/shared';

import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';
import { getStatusLabel } from '../../lib/vocabulary.js';

interface ActiveTasksSectionProps {
  jobs: Job[];
}

/**
 * Renders active task cards with progress tracking and cancel functionality.
 */
export function ActiveTasksSection({ jobs }: ActiveTasksSectionProps): React.ReactElement {
  if (jobs.length === 0) {
    return (
      <section aria-label="Active tasks">
        <SectionHeader title="Active Tasks" count={0} />
        <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-6 text-center dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">No active tasks</p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Send a message to start something
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Active tasks">
      <SectionHeader title="Active Tasks" count={jobs.length} />
      <div className="mt-3 space-y-3">
        {jobs.map((job) => (
          <ActiveTaskCard key={job.id} job={job} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ActiveTaskCard
// ---------------------------------------------------------------------------

interface ActiveTaskCardProps {
  job: Job;
}

function ActiveTaskCard({ job }: ActiveTaskCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const elapsed = useElapsedTime(job.createdAt);

  const statusLabel = getStatusLabel(job.status);
  const progress = typeof job.metadata?.progress === 'number' ? job.metadata.progress : undefined;
  const currentStep = typeof job.metadata?.currentStep === 'string' ? job.metadata.currentStep : undefined;
  const steps = Array.isArray(job.plan?.steps) ? job.plan.steps : [];
  const taskName = typeof job.metadata?.taskName === 'string'
    ? job.metadata.taskName
    : `Task ${job.id.slice(0, 8)}`;

  const handleCancel = useCallback(async (): Promise<void> => {
    setCancelling(true);
    try {
      await api.post(`/jobs/${job.id}/cancel`);
    } catch {
      // Cancel failed — UI will update via WebSocket when server processes
    } finally {
      setCancelling(false);
    }
  }, [job.id]);

  return (
    <Card padding="sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Spinner size="sm" />
          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {taskName}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="info">{statusLabel}</Badge>
          <span className="text-xs text-gray-400 dark:text-gray-500">{elapsed}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void handleCancel(); }}
            disabled={cancelling}
            aria-label={`Cancel task ${taskName}`}
          >
            {cancelling ? 'Cancelling...' : 'Cancel'}
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      {progress !== undefined && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            {currentStep && <span>{currentStep}</span>}
            <span>{progress}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-full rounded-full bg-meridian-500 transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        </div>
      )}

      {/* Step tracker (collapsible) */}
      {steps.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => { setExpanded(!expanded); }}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide steps' : `Show steps (${steps.length})`}
          </button>
          {expanded && (
            <ul className="mt-1 space-y-1">
              {steps.map((step) => {
                const stepStatus = typeof step.metadata?.status === 'string'
                  ? step.metadata.status
                  : 'pending';
                return (
                  <li
                    key={step.id}
                    className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400"
                  >
                    <StepIcon status={stepStatus} />
                    <span>{step.description ?? step.action}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionHeader({ title, count }: { title: string; count: number }): React.ReactElement {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {count > 0 && (
        <Badge variant="info">{count}</Badge>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: string }): React.ReactElement {
  if (status === 'completed') {
    return (
      <svg className="h-3 w-3 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg className="h-3 w-3 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  if (status === 'running' || status === 'started') {
    return <Spinner size="sm" className="h-3 w-3" />;
  }
  // pending
  return (
    <svg className="h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

/**
 * Hook that returns a human-readable elapsed time string, updating every second.
 */
function useElapsedTime(isoTimestamp: string): string {
  const [elapsed, setElapsed] = useState(() => formatElapsed(isoTimestamp));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setElapsed(formatElapsed(isoTimestamp));
    intervalRef.current = setInterval(() => {
      setElapsed(formatElapsed(isoTimestamp));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isoTimestamp]);

  return elapsed;
}

function formatElapsed(isoTimestamp: string): string {
  const start = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - start) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
