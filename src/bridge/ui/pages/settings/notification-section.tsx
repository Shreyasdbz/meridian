// Notification settings section (Section 5.5.12).
// Push notification opt-in and webhook placeholder.

import { PushNotificationBanner, WebhookPlaceholder } from '../../components/notifications/index.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NotificationSection(): React.ReactElement {
  return (
    <section aria-labelledby="notification-heading">
      <h3
        id="notification-heading"
        className="text-sm font-semibold text-gray-900 dark:text-gray-100"
      >
        Notifications
      </h3>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Configure how Meridian notifies you about task progress and events.
      </p>

      <div className="mt-4 space-y-3">
        {/* In-app toast info */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900/50">
          <div className="flex items-center gap-2">
            <svg
              className="h-4 w-4 text-green-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              In-app notifications
            </p>
            <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              Always on
            </span>
          </div>
          <p className="mt-1 ml-6 text-xs text-gray-500 dark:text-gray-400">
            Toast notifications appear within Meridian for task completions, errors, and approvals.
          </p>
        </div>

        {/* Browser push opt-in */}
        <PushNotificationBanner />

        {/* Webhook placeholder */}
        <WebhookPlaceholder />
      </div>
    </section>
  );
}
