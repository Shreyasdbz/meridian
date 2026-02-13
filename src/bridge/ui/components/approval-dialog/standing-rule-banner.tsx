import { Button } from '../button.js';

interface StandingRuleBannerProps {
  category: string;
  onDismiss: () => void;
}

/**
 * Standing rule suggestion banner (Section 5.5.3).
 * Shown after the user approves the same action category N times (default: 5).
 * Suggests creating a standing approval rule that feeds into trust settings
 * (Sentinel Memory).
 */
export function StandingRuleBanner({
  category,
  onDismiss,
}: StandingRuleBannerProps): React.ReactElement {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-meridian-300 bg-meridian-50 p-3 dark:border-meridian-700 dark:bg-meridian-900/20"
      role="status"
      data-testid="standing-rule-banner"
    >
      {/* Info icon */}
      <svg
        className="h-5 w-5 shrink-0 text-meridian-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-meridian-800 dark:text-meridian-200">
          You&apos;ve approved &quot;{category}&quot; actions several times
        </p>
        <p className="mt-0.5 text-xs text-meridian-600 dark:text-meridian-400">
          You can create a standing rule in Trust settings to auto-approve these in the future.
        </p>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        aria-label="Dismiss suggestion"
      >
        Dismiss
      </Button>
    </div>
  );
}
