// Same-provider warning banner (Section 6.1.2).
// Displayed when Scout and Sentinel use the same LLM provider.

import { useState } from 'react';

import { useSettingsStore } from '../../stores/settings-store.js';

export function SameProviderWarning(): React.ReactElement | null {
  const scoutProvider = useSettingsStore((s) => s.scoutProvider);
  const sentinelProvider = useSettingsStore((s) => s.sentinelProvider);
  const [dismissed, setDismissed] = useState(false);

  // Only show when both are configured and identical
  const shouldShow =
    scoutProvider &&
    sentinelProvider &&
    scoutProvider === sentinelProvider &&
    !dismissed;

  if (!shouldShow) return null;

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30"
      role="alert"
    >
      <svg
        className="mt-0.5 h-5 w-5 shrink-0 text-amber-500 dark:text-amber-400"
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
      <div className="flex-1">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
          Same AI provider for planning and safety
        </p>
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          Using the same provider for both planning and safety checking reduces the independence
          of the safety review. Different providers have different failure modes, making attacks
          harder. Consider using a different provider for one of these roles.
        </p>
      </div>
      <button
        onClick={() => { setDismissed(true); }}
        className="shrink-0 text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
        aria-label="Dismiss warning"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
