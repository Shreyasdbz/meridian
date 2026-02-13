/**
 * Placeholder for external webhook notification configuration.
 * Section 5.5.12 — external notifications via webhook (v0.2).
 *
 * In v0.2, this will allow users to configure webhook URLs for forwarding
 * notifications to email, Slack, Discord, or messaging apps (via Gear).
 */
export function WebhookPlaceholder(): React.ReactElement {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900/50">
      <div className="flex items-center gap-2">
        <svg
          className="h-5 w-5 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          Webhook notifications
        </p>
        <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400">
          v0.2
        </span>
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Forward notifications to Slack, Discord, email, or other services via webhook.
        This feature will be available in v0.2 and delivered via Gear.
      </p>
    </div>
  );
}
