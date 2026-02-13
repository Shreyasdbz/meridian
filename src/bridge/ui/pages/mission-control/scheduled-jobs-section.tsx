// Scheduled Jobs section of Mission Control (Section 5.5.2).
// Placeholder for v0.2 — upcoming and recurring tasks.

/**
 * Placeholder section for scheduled/recurring jobs.
 * Cron scheduling is a v0.2 feature; this renders a placeholder.
 */
export function ScheduledJobsSection(): React.ReactElement {
  return (
    <section aria-label="Scheduled jobs">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Scheduled Jobs
      </h2>
      <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-4 text-center dark:border-gray-700">
        <svg
          className="mx-auto h-6 w-6 text-gray-400 dark:text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Scheduled tasks will be available in a future update
        </p>
      </div>
    </section>
  );
}
