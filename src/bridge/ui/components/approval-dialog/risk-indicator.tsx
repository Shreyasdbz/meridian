import type { RiskLevel } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Risk level → color mapping (Section 5.5.3)
// green = low, yellow = medium, orange = high, red = critical
// ---------------------------------------------------------------------------

const RISK_COLORS: Record<RiskLevel, { bg: string; text: string; dot: string; label: string }> = {
  low: {
    bg: 'bg-green-100 dark:bg-green-900/30',
    text: 'text-green-700 dark:text-green-400',
    dot: 'bg-green-500',
    label: 'Low risk',
  },
  medium: {
    bg: 'bg-yellow-100 dark:bg-yellow-900/30',
    text: 'text-yellow-700 dark:text-yellow-400',
    dot: 'bg-yellow-500',
    label: 'Medium risk',
  },
  high: {
    bg: 'bg-orange-100 dark:bg-orange-900/30',
    text: 'text-orange-700 dark:text-orange-400',
    dot: 'bg-orange-500',
    label: 'High risk',
  },
  critical: {
    bg: 'bg-red-100 dark:bg-red-900/30',
    text: 'text-red-700 dark:text-red-400',
    dot: 'bg-red-500',
    label: 'Critical risk',
  },
};

interface RiskIndicatorProps {
  level: RiskLevel;
  className?: string;
}

/**
 * Color-coded risk indicator badge per Section 5.5.3.
 */
export function RiskIndicator({ level, className = '' }: RiskIndicatorProps): React.ReactElement {
  const colors = RISK_COLORS[level];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${colors.bg} ${colors.text} ${className}`}
      data-testid={`risk-${level}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} aria-hidden="true" />
      {colors.label}
    </span>
  );
}

/** Returns the CSS class for a risk level's dot color. */
export function getRiskDotClass(level: RiskLevel): string {
  return RISK_COLORS[level].dot;
}

/** Returns the user-facing label for a risk level. */
export function getRiskLabel(level: RiskLevel): string {
  return RISK_COLORS[level].label;
}
