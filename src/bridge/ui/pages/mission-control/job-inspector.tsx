// Job Inspector — unified detail view for the full lifecycle of a job (Section 12.4).
// Shows: original message, Scout's plan, Sentinel's validation, execution state, and result.

import { useCallback, useEffect, useState } from 'react';

import type { Job } from '@meridian/shared';

import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { Dialog } from '../../components/dialog.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';
import { getStatusLabel } from '../../lib/vocabulary.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SentinelExplain {
  jobId: string;
  verdict: string;
  overallRisk: string | null;
  reasoning: string | null;
  suggestedRevisions: string | null;
  steps: Array<{
    stepId: string;
    verdict: string;
    category: string | null;
    riskLevel: string | null;
    reasoning: string | null;
  }>;
}

interface JobInspectorProps {
  jobId: string | null;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// JobInspector
// ---------------------------------------------------------------------------

/**
 * Job Inspector dialog — shows the complete lifecycle of a job.
 * Fetches job details and Sentinel explain data on open.
 */
export function JobInspector({ jobId, onClose }: JobInspectorProps): React.ReactElement {
  const [job, setJob] = useState<Job | null>(null);
  const [explain, setExplain] = useState<SentinelExplain | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadJob = useCallback(async (id: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const jobData = await api.get<Job>(`/jobs/${id}`);
      setJob(jobData);

      // Try to load Sentinel explain — may 404 if no validation
      try {
        const explainData = await api.get<SentinelExplain>(`/jobs/${id}/explain`);
        setExplain(explainData);
      } catch {
        setExplain(null);
      }
    } catch {
      setError('Failed to load job details');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (jobId) {
      void loadJob(jobId);
    } else {
      setJob(null);
      setExplain(null);
      setError(null);
    }
  }, [jobId, loadJob]);

  const handleReplay = useCallback(async (): Promise<void> => {
    if (!job) return;
    try {
      await api.post(`/jobs/${job.id}/replay`);
      onClose();
    } catch {
      // Replay failed — keep dialog open
    }
  }, [job, onClose]);

  const isTerminal = job?.status === 'completed'
    || job?.status === 'failed'
    || job?.status === 'cancelled';

  return (
    <Dialog
      open={jobId !== null}
      onClose={onClose}
      title="Job Inspector"
      actions={
        isTerminal ? (
          <Button variant="ghost" size="sm" onClick={() => { void handleReplay(); }}>
            Replay
          </Button>
        ) : undefined
      }
    >
      {loading && (
        <div className="flex items-center justify-center py-6">
          <Spinner label="Loading job details..." />
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {job && !loading && (
        <div className="space-y-4">
          {/* Header: status + ID */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusDot status={job.status} />
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {getStatusLabel(job.status)}
              </span>
            </div>
            <span className="text-xs font-mono text-gray-400 dark:text-gray-500">
              {job.id.slice(0, 12)}
            </span>
          </div>

          {/* Timeline */}
          <div className="space-y-3">
            {/* Stage 1: Source */}
            <TimelineStage
              label="Source"
              status={job.source ? 'done' : 'pending'}
            >
              <div className="text-xs text-gray-600 dark:text-gray-400">
                <span className="font-medium">Type:</span> {job.source ?? 'user'}
              </div>
              {job.conversationId && (
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  <span className="font-medium">Conversation:</span>{' '}
                  {job.conversationId.slice(0, 12)}...
                </div>
              )}
            </TimelineStage>

            {/* Stage 2: Plan (Scout) */}
            <TimelineStage
              label="Plan"
              status={job.plan ? 'done' : job.status === 'planning' ? 'active' : 'pending'}
            >
              {job.plan ? (
                <div className="space-y-1">
                  {job.plan.steps.map((step) => (
                    <div
                      key={step.id}
                      className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400"
                    >
                      <Badge
                        variant={
                          step.riskLevel === 'high' || step.riskLevel === 'critical'
                            ? 'danger'
                            : 'default'
                        }
                      >
                        {step.riskLevel}
                      </Badge>
                      <span>{step.description ?? step.action}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {job.status === 'pending' ? 'Waiting to plan' : 'No plan data'}
                </span>
              )}
            </TimelineStage>

            {/* Stage 3: Validation (Sentinel) */}
            <TimelineStage
              label="Safety Check"
              status={
                job.validation
                  ? 'done'
                  : job.status === 'validating'
                    ? 'active'
                    : 'pending'
              }
            >
              {explain ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        explain.verdict === 'approved'
                          ? 'success'
                          : explain.verdict === 'rejected'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {explain.verdict}
                    </Badge>
                    {explain.overallRisk && (
                      <Badge
                        variant={
                          explain.overallRisk === 'high' || explain.overallRisk === 'critical'
                            ? 'danger'
                            : explain.overallRisk === 'medium'
                              ? 'warning'
                              : 'default'
                        }
                      >
                        {explain.overallRisk} risk
                      </Badge>
                    )}
                  </div>
                  {explain.reasoning && (
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      {explain.reasoning}
                    </p>
                  )}
                  {explain.suggestedRevisions && (
                    <p className="text-xs text-yellow-600 dark:text-yellow-400">
                      Suggested: {explain.suggestedRevisions}
                    </p>
                  )}
                  {explain.steps.length > 0 && (
                    <ul className="space-y-1">
                      {explain.steps.map((step) => (
                        <li
                          key={step.stepId}
                          className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400"
                        >
                          <Badge
                            variant={step.verdict === 'approved' ? 'success' : 'danger'}
                            className="shrink-0"
                          >
                            {step.verdict}
                          </Badge>
                          <span>{step.reasoning ?? step.category ?? step.stepId}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : job.validation ? (
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      job.validation.verdict === 'approved' ? 'success' : 'danger'
                    }
                  >
                    {job.validation.verdict}
                  </Badge>
                  {job.validation.reasoning && (
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      {job.validation.reasoning}
                    </span>
                  )}
                </div>
              ) : (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  No safety check data
                </span>
              )}
            </TimelineStage>

            {/* Stage 4: Execution */}
            <TimelineStage
              label="Execution"
              status={
                isTerminal
                  ? 'done'
                  : job.status === 'executing'
                    ? 'active'
                    : 'pending'
              }
            >
              {job.status === 'executing' && (
                <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <Spinner size="sm" />
                  <span>
                    {typeof job.metadata?.currentStep === 'string'
                      ? job.metadata.currentStep
                      : 'Executing...'}
                  </span>
                </div>
              )}
              {typeof job.metadata?.progress === 'number' && (
                <div className="mt-1">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                    <div
                      className="h-full rounded-full bg-meridian-500 transition-all duration-300"
                      style={{ width: `${Math.min(100, Math.max(0, job.metadata.progress))}%` }}
                    />
                  </div>
                </div>
              )}
              {job.attempts !== undefined && job.attempts > 0 && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Attempts: {job.attempts}{job.maxAttempts ? ` / ${job.maxAttempts}` : ''}
                </div>
              )}
            </TimelineStage>

            {/* Stage 5: Result */}
            <TimelineStage
              label="Result"
              status={isTerminal ? 'done' : 'pending'}
            >
              {job.status === 'completed' && job.result && (
                <Card padding="sm" className="bg-green-50 dark:bg-green-900/10">
                  <pre className="whitespace-pre-wrap text-xs text-gray-700 dark:text-gray-300">
                    {JSON.stringify(job.result, null, 2)}
                  </pre>
                </Card>
              )}
              {job.status === 'failed' && job.error && (
                <Card padding="sm" className="bg-red-50 dark:bg-red-900/10">
                  <div className="text-xs">
                    <span className="font-medium text-red-700 dark:text-red-400">
                      {job.error.code}:
                    </span>{' '}
                    <span className="text-red-600 dark:text-red-300">
                      {job.error.message}
                    </span>
                    {job.error.retriable && (
                      <Badge variant="warning" className="ml-2">retriable</Badge>
                    )}
                  </div>
                </Card>
              )}
              {job.status === 'cancelled' && (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  Cancelled by user
                </span>
              )}
              {!isTerminal && (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  Awaiting completion
                </span>
              )}
            </TimelineStage>
          </div>

          {/* Metadata */}
          {job.metadata && Object.keys(job.metadata).length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                Metadata
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-gray-100 p-2 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                {JSON.stringify(job.metadata, null, 2)}
              </pre>
            </details>
          )}

          {/* Timestamps */}
          <div className="border-t border-gray-200 pt-2 dark:border-gray-700">
            <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500">
              <span>Created: {formatTimestamp(job.createdAt)}</span>
              {job.completedAt && <span>Completed: {formatTimestamp(job.completedAt)}</span>}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Timeline helpers
// ---------------------------------------------------------------------------

type StageStatus = 'pending' | 'active' | 'done';

function TimelineStage({
  label,
  status,
  children,
}: {
  label: string;
  status: StageStatus;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex gap-3">
      {/* Timeline dot + line */}
      <div className="flex flex-col items-center">
        <div
          className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${
            status === 'done'
              ? 'bg-green-500'
              : status === 'active'
                ? 'bg-meridian-500 animate-pulse'
                : 'bg-gray-300 dark:bg-gray-600'
          }`}
        />
        <div className="w-px flex-1 bg-gray-200 dark:bg-gray-700" />
      </div>

      {/* Content */}
      <div className="min-w-0 pb-3">
        <div
          className={`text-xs font-semibold ${
            status === 'done'
              ? 'text-gray-900 dark:text-gray-100'
              : status === 'active'
                ? 'text-meridian-600 dark:text-meridian-400'
                : 'text-gray-400 dark:text-gray-500'
          }`}
        >
          {label}
        </div>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }): React.ReactElement {
  const color =
    status === 'completed'
      ? 'bg-green-500'
      : status === 'failed'
        ? 'bg-red-500'
        : status === 'cancelled'
          ? 'bg-gray-400'
          : status === 'executing'
            ? 'bg-meridian-500 animate-pulse'
            : 'bg-yellow-500';

  return <div className={`h-2 w-2 rounded-full ${color}`} />;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
