// Recent Completions section of Mission Control (Section 5.5.2).
// Shows the last N completed tasks with outcome summaries.

import type { Job } from '@meridian/shared';

import { Badge } from '../../components/badge.js';
import { Card } from '../../components/card.js';
import { getStatusLabel } from '../../lib/vocabulary.js';

interface RecentCompletionsSectionProps {
  jobs: Job[];
}

/**
 * Renders a list of recently completed/failed/cancelled tasks.
 */
export function RecentCompletionsSection({
  jobs,
}: RecentCompletionsSectionProps): React.ReactElement {
  if (jobs.length === 0) {
    return (
      <section aria-label="Recent completions">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Recent Completions
        </h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          No completed tasks yet
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Recent completions">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Recent Completions
      </h2>
      <div className="mt-3 space-y-2">
        {jobs.map((job) => (
          <CompletionCard key={job.id} job={job} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CompletionCard
// ---------------------------------------------------------------------------

function CompletionCard({ job }: { job: Job }): React.ReactElement {
  const statusLabel = getStatusLabel(job.status);
  const taskName = typeof job.metadata?.taskName === 'string'
    ? job.metadata.taskName
    : `Task ${job.id.slice(0, 8)}`;
  const isDone = job.status === 'completed';
  const isFailed = job.status === 'failed';
  const isCancelled = job.status === 'cancelled';

  const completedAt = job.completedAt ?? job.updatedAt;
  const formattedTime = formatCompletionTime(completedAt);

  const summary = isFailed && job.error
    ? job.error.message
    : typeof job.metadata?.summary === 'string'
      ? job.metadata.summary
      : undefined;

  return (
    <Card padding="sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isDone && (
            <svg className="h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          {isFailed && (
            <svg className="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
          )}
          {isCancelled && (
            <svg className="h-4 w-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          )}
          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {taskName}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={isDone ? 'success' : isFailed ? 'danger' : 'default'}>
            {statusLabel}
          </Badge>
          <span className="text-xs text-gray-400 dark:text-gray-500">{formattedTime}</span>
        </div>
      </div>
      {summary && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400 line-clamp-2">
          {summary}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCompletionTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
