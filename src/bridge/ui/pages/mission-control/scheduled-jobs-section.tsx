// Scheduled Jobs section of Mission Control (Phase 9.4).
// Displays cron schedules with name, expression, next run, toggle, and delete.

import { useEffect } from 'react';

import { api } from '../../hooks/use-api.js';
import { useScheduleStore } from '../../stores/schedule-store.js';
import type { Schedule } from '../../stores/schedule-store.js';

interface SchedulesResponse {
  items: Schedule[];
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) return 'Not scheduled';
  const date = new Date(nextRunAt);
  const now = new Date();
  const diff = date.getTime() - now.getTime();

  if (diff < 0) return 'Overdue';
  if (diff < 60_000) return 'Less than a minute';
  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000);
    return `${mins}m`;
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    return `${hours}h`;
  }
  const days = Math.floor(diff / 86_400_000);
  return `${days}d`;
}

// ---------------------------------------------------------------------------
// ScheduleRow component
// ---------------------------------------------------------------------------

function ScheduleRow({
  schedule,
  onToggle,
  onDelete,
}: {
  schedule: Schedule;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  return (
    <div
      className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700"
      data-testid={`schedule-row-${schedule.id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
          {schedule.name}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">
            {schedule.cronExpression}
          </code>
          {' — next: '}
          {schedule.enabled ? formatNextRun(schedule.nextRunAt) : 'Disabled'}
        </p>
      </div>

      <div className="ml-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => { onToggle(schedule.id); }}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
            schedule.enabled
              ? 'bg-blue-600'
              : 'bg-gray-200 dark:bg-gray-600'
          }`}
          role="switch"
          aria-checked={schedule.enabled}
          aria-label={`Toggle schedule ${schedule.name}`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              schedule.enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>

        <button
          type="button"
          onClick={() => { onDelete(schedule.id); }}
          className="text-gray-400 hover:text-red-500 dark:hover:text-red-400"
          aria-label={`Delete schedule ${schedule.name}`}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Scheduled jobs section showing cron schedules with toggle and delete controls.
 */
export function ScheduledJobsSection(): React.ReactElement {
  const schedules = useScheduleStore((s) => s.schedules);
  const isLoading = useScheduleStore((s) => s.isLoading);
  const setSchedules = useScheduleStore((s) => s.setSchedules);
  const setLoading = useScheduleStore((s) => s.setLoading);

  // --- Load schedules on mount ---
  useEffect(() => {
    const loadSchedules = async (): Promise<void> => {
      setLoading(true);
      try {
        const data = await api.get<SchedulesResponse>('/schedules');
        setSchedules(data.items);
      } catch {
        // Failed to load — section will show empty state
      } finally {
        setLoading(false);
      }
    };

    void loadSchedules();
  }, [setSchedules, setLoading]);

  const handleToggle = async (id: string): Promise<void> => {
    try {
      const response = await fetch(`/api/schedules/${id}/toggle`, {
        method: 'POST',
        credentials: 'include',
      });
      if (response.ok) {
        const data = (await response.json()) as { enabled: boolean; nextRunAt: string | null };
        useScheduleStore.getState().updateSchedule(id, {
          enabled: data.enabled,
          nextRunAt: data.nextRunAt,
        });
      }
    } catch {
      // Silently fail — user can retry
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    try {
      const response = await fetch(`/api/schedules/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (response.ok) {
        useScheduleStore.getState().removeSchedule(id);
      }
    } catch {
      // Silently fail — user can retry
    }
  };

  return (
    <section aria-label="Scheduled jobs">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Scheduled Jobs
      </h2>

      {isLoading && (
        <div className="mt-3 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Loading schedules...</p>
        </div>
      )}

      {!isLoading && schedules.length === 0 && (
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
            No scheduled jobs configured
          </p>
        </div>
      )}

      {!isLoading && schedules.length > 0 && (
        <div className="mt-3 space-y-2">
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              onToggle={(id) => { void handleToggle(id); }}
              onDelete={(id) => { void handleDelete(id); }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
