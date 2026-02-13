// Error display component (Section 5.5.6).
// Shows: non-technical explanation, expandable details, side-effect disclosure,
// rollback option, and next-steps suggestions.

import { useState } from 'react';

import { Button } from '../button.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A side-effect that occurred before the error (e.g. files created). */
export interface SideEffect {
  description: string;
  rollbackAvailable: boolean;
}

export interface ErrorDisplayProps {
  /** Brief, non-technical explanation of what went wrong. */
  message: string;

  /** Technical details (error code, stack trace, etc.). */
  details?: string;

  /** Error code for reference. */
  code?: string;

  /** Actions that completed before the error occurred. */
  sideEffects?: SideEffect[];

  /** Called when user requests rollback of completed side-effects. */
  onRollback?: () => void;

  /** Called when user wants to retry or try a different approach. */
  onRetry?: () => void;

  /** Called when user dismisses the error. */
  onDismiss?: () => void;

  /** Whether a rollback is currently in progress. */
  isRollingBack?: boolean;

  /** Suggested next step text. */
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ErrorDisplay({
  message,
  details,
  code,
  sideEffects,
  onRollback,
  onRetry,
  onDismiss,
  isRollingBack = false,
  suggestion,
}: ErrorDisplayProps): React.ReactElement {
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const hasSideEffects = sideEffects && sideEffects.length > 0;
  const hasRollback = hasSideEffects && sideEffects.some((se) => se.rollbackAvailable);

  return (
    <div
      className="my-2 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30"
      role="alert"
    >
      {/* Error header */}
      <div className="flex items-start gap-3">
        <svg
          className="mt-0.5 h-5 w-5 shrink-0 text-red-500 dark:text-red-400"
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

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            Something went wrong
          </p>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{message}</p>

          {code && (
            <p className="mt-1 text-xs text-red-500 dark:text-red-400">
              Error code: {code}
            </p>
          )}
        </div>
      </div>

      {/* Side-effect disclosure (Section 5.5.6) */}
      {hasSideEffects && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
            Before this error, the following actions were completed:
          </p>
          <ul className="mt-1.5 space-y-1">
            {sideEffects.map((effect, i) => (
              <li
                key={i}
                className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300"
              >
                <svg
                  className="h-3 w-3 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4.5 12.75l6 6 9-13.5"
                  />
                </svg>
                <span>{effect.description}</span>
                {effect.rollbackAvailable && (
                  <span className="rounded bg-amber-200 px-1 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-800 dark:text-amber-200">
                    Can undo
                  </span>
                )}
              </li>
            ))}
          </ul>

          {hasRollback && onRollback && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={onRollback}
              disabled={isRollingBack}
            >
              {isRollingBack ? 'Rolling back...' : 'Undo completed actions'}
            </Button>
          )}
        </div>
      )}

      {/* Expandable technical details */}
      {details && (
        <div className="mt-3">
          <button
            onClick={() => { setDetailsExpanded(!detailsExpanded); }}
            className="flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            aria-expanded={detailsExpanded}
          >
            <svg
              className={`h-3 w-3 transition-transform ${detailsExpanded ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
            See Details
          </button>

          {detailsExpanded && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-red-100 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
              {details}
            </pre>
          )}
        </div>
      )}

      {/* Suggestion / next steps */}
      {suggestion && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">
          {suggestion}
        </p>
      )}

      {/* Action buttons */}
      <div className="mt-3 flex items-center gap-2">
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try a different approach
          </Button>
        )}
        {onDismiss && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
