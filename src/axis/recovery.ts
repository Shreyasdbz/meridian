// @meridian/axis — Crash recovery (Section 5.1.12)
//
// On restart, loads all non-terminal jobs from SQLite. Jobs that were
// `executing` at crash time have their stale execution_log entries
// (status = 'started') marked as 'failed', and the job is returned
// to 'pending' for re-evaluation by the worker pool.

import type { DatabaseClient } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for recovery events.
 */
export interface RecoveryLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Result of the crash recovery process.
 */
export interface RecoveryResult {
  /** Total non-terminal jobs found at startup. */
  nonTerminalJobCount: number;
  /** Jobs that were in `executing` state and were reset to `pending`. */
  resetJobIds: string[];
  /** Jobs in `planning` or `validating` that were reset to `pending`. */
  stalePipelineJobIds: string[];
  /** Stale execution_log entries marked as `failed`. */
  failedExecutionEntries: number;
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  status: string;
  worker_id: string | null;
}

interface ExecutionLogRow {
  execution_id: string;
  job_id: string;
  step_id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: RecoveryLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * In-flight job states that indicate a job was actively being processed
 * when the crash occurred. These are reset to `pending`.
 */
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set([
  'planning',
  'validating',
  'executing',
]);

/**
 * Perform crash recovery on startup.
 *
 * 1. Find all non-terminal jobs.
 * 2. For jobs in `executing` state: find stale `started` entries in the
 *    execution_log and mark them as `failed`.
 * 3. Reset all in-flight jobs (`planning`, `validating`, `executing`)
 *    back to `pending` with their worker_id cleared.
 * 4. Jobs in `awaiting_approval` are left as-is (they require user action).
 *
 * This function is idempotent — running it multiple times produces the
 * same result.
 */
export async function recoverJobs(
  db: DatabaseClient,
  logger: RecoveryLogger = noopLogger,
): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    nonTerminalJobCount: 0,
    resetJobIds: [],
    stalePipelineJobIds: [],
    failedExecutionEntries: 0,
  };

  // 1. Load all non-terminal jobs
  const nonTerminalJobs = await db.query<JobRow>(
    'meridian',
    `SELECT id, status, worker_id FROM jobs
     WHERE status NOT IN ('completed', 'failed', 'cancelled')`,
  );

  result.nonTerminalJobCount = nonTerminalJobs.length;

  if (nonTerminalJobs.length === 0) {
    logger.info('Crash recovery: no non-terminal jobs found');
    return result;
  }

  logger.info('Crash recovery: found non-terminal jobs', {
    count: nonTerminalJobs.length,
    statuses: summarizeStatuses(nonTerminalJobs),
  });

  // 2. For executing jobs, mark stale execution_log entries as failed
  const executingJobs = nonTerminalJobs.filter((j) => j.status === 'executing');

  for (const job of executingJobs) {
    const staleEntries = await db.query<ExecutionLogRow>(
      'meridian',
      `SELECT execution_id, job_id, step_id, status FROM execution_log
       WHERE job_id = ? AND status = 'started'`,
      [job.id],
    );

    if (staleEntries.length > 0) {
      const now = new Date().toISOString();

      for (const entry of staleEntries) {
        await db.run(
          'meridian',
          `UPDATE execution_log
           SET status = 'failed', completed_at = ?
           WHERE execution_id = ? AND status = 'started'`,
          [now, entry.execution_id],
        );
        result.failedExecutionEntries++;
      }

      logger.warn('Crash recovery: marked stale execution entries as failed', {
        jobId: job.id,
        staleEntryCount: staleEntries.length,
      });
    }
  }

  // 3. Reset in-flight jobs to pending
  const now = new Date().toISOString();

  for (const job of nonTerminalJobs) {
    if (!IN_FLIGHT_STATES.has(job.status)) {
      continue;
    }

    const updateResult = await db.run(
      'meridian',
      `UPDATE jobs
       SET status = 'pending', worker_id = NULL, updated_at = ?
       WHERE id = ? AND status = ?`,
      [now, job.id, job.status],
    );

    if (updateResult.changes > 0) {
      if (job.status === 'executing') {
        result.resetJobIds.push(job.id);
      } else {
        result.stalePipelineJobIds.push(job.id);
      }

      logger.info('Crash recovery: reset job to pending', {
        jobId: job.id,
        previousStatus: job.status,
      });
    }
  }

  logger.info('Crash recovery complete', {
    nonTerminalJobs: result.nonTerminalJobCount,
    executingReset: result.resetJobIds.length,
    pipelineReset: result.stalePipelineJobIds.length,
    staleEntriesFailed: result.failedExecutionEntries,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeStatuses(jobs: JobRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }
  return counts;
}
