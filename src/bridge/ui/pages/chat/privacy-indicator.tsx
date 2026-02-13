// Privacy visual indicator (Section 7.1)
// Shows whether data is being processed locally or transmitted externally.

interface PrivacyIndicatorProps {
  isExternal: boolean;
  providerName?: string;
  className?: string;
}

/**
 * Displays a small indicator showing where data is being processed.
 * Green lock = local processing, amber globe = external API.
 */
export function PrivacyIndicator({
  isExternal,
  providerName,
  className = '',
}: PrivacyIndicatorProps): React.ReactElement {
  if (isExternal) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 ${className}`}
        title={providerName ? `Sent to ${providerName}` : 'Sent to external API'}
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5a17.92 17.92 0 01-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
          />
        </svg>
        {providerName ?? 'External'}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 ${className}`}
      title="Processed locally"
    >
      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
        />
      </svg>
      Local
    </span>
  );
}
