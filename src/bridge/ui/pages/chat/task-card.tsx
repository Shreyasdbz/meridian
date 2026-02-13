// Inline task reference card shown within the conversation.
// Displays task name, progress, and link to Mission Control.

import { Badge } from '../../components/badge.js';
import { getStatusLabel } from '../../lib/vocabulary.js';

interface TaskCardProps {
  jobId: string;
  name: string;
  status: string;
  percent?: number;
  step?: string;
  onViewProgress?: (jobId: string) => void;
}

/**
 * Compact task reference card rendered inline within the conversation.
 * Shows task name, progress percentage, and a "View progress" link.
 * Conversation is NOT blocked by running tasks per the implementation plan.
 */
export function TaskCard({
  jobId,
  name,
  status,
  percent,
  step,
  onViewProgress,
}: TaskCardProps): React.ReactElement {
  const statusLabel = getStatusLabel(status);
  const isRunning = status === 'executing' || status === 'planning' || status === 'validating';
  const isDone = status === 'completed';
  const isFailed = status === 'failed';

  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Status icon */}
          {isRunning && (
            <svg
              className="h-4 w-4 shrink-0 animate-spin text-meridian-500"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          )}
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

          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {name}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={isDone ? 'success' : isFailed ? 'danger' : 'info'}>
            {statusLabel}
          </Badge>
          {onViewProgress && (
            <button
              onClick={() => { onViewProgress(jobId); }}
              className="text-xs text-meridian-600 hover:text-meridian-700 dark:text-meridian-400 dark:hover:text-meridian-300"
            >
              View progress
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isRunning && percent !== undefined && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            {step && <span>{step}</span>}
            <span>{percent}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-full rounded-full bg-meridian-500 transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
