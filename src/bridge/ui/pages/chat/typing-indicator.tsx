// Typing / status indicator shown during planning and execution.

import { getStatusLabel } from '../../lib/vocabulary.js';

interface TypingIndicatorProps {
  status: string;
  className?: string;
}

/**
 * Animated indicator showing current processing status.
 * Uses the vocabulary module to translate internal statuses to user-friendly labels.
 */
export function TypingIndicator({ status, className = '' }: TypingIndicatorProps): React.ReactElement {
  const label = getStatusLabel(status);

  return (
    <div
      className={`flex items-center gap-2 px-4 py-2 ${className}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-meridian-500 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-meridian-500 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-meridian-500 [animation-delay:300ms]" />
      </div>
      <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
    </div>
  );
}
