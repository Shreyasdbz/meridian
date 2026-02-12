// @meridian/axis — Idempotency framework (Section 5.1.7)
//
// Prevents duplicate side effects when steps are dispatched more than once
// (e.g., after a crash during execution). Each dispatch is tracked in the
// execution_log table with a stable executionId derived from jobId + stepId.
//
// The execution ID is deterministic: the same (jobId, stepId) pair always
// maps to the same execution ID. This ensures that retries hit the same
// idempotency key regardless of how many times the step is dispatched.

import { createHash } from 'node:crypto';

import type { DatabaseClient, ExecutionStepStatus } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of an idempotency check before dispatching a step.
 *
 * - `cached`: A previous execution completed successfully — use the cached result.
 * - `execute`: No completed execution exists — proceed with dispatch.
 */
export type IdempotencyCheck =
  | { outcome: 'cached'; executionId: string; result: Record<string, unknown> }
  | { outcome: 'execute'; executionId: string };

/**
 * Domain representation of an execution_log row.
 */
export interface ExecutionLogEntry {
  executionId: string;
  jobId: string;
  stepId: string;
  status: ExecutionStepStatus;
  result?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface ExecutionLogRow {
  execution_id: string;
  job_id: string;
  step_id: string;
  status: string;
  result_json: string | null;
  started_at: string;
  completed_at: string | null;
}

function rowToEntry(row: ExecutionLogRow): ExecutionLogEntry {
  return {
    executionId: row.execution_id,
    jobId: row.job_id,
    stepId: row.step_id,
    status: row.status as ExecutionStepStatus,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Execution ID computation
// ---------------------------------------------------------------------------

/**
 * Compute a stable execution ID from a job ID and step ID.
 *
 * The same (jobId, stepId) pair always produces the same execution ID,
 * ensuring retries of the same step hit the same idempotency key.
 *
 * @returns SHA-256 hex digest of `jobId:stepId`
 */
export function computeExecutionId(jobId: string, stepId: string): string {
  return createHash('sha256').update(`${jobId}:${stepId}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Idempotency check (before dispatch)
// ---------------------------------------------------------------------------

/**
 * Check the execution log before dispatching a step.
 *
 * Handles three cases atomically within a transaction:
 * 1. **completed**: Return the cached result — skip execution.
 * 2. **started/failed** (stale from crash or prior failure): Reset to started — re-execute.
 * 3. **not found**: Insert a new started entry — proceed with execution.
 *
 * The execution ID is always deterministic (derived from jobId + stepId),
 * so retries of the same step always use the same key. This ensures that
 * once a step completes successfully, all subsequent checks return the
 * cached result.
 *
 * @param db - Database client
 * @param jobId - The job ID
 * @param stepId - The step ID within the plan
 * @returns An IdempotencyCheck indicating whether to execute or use a cached result
 */
export async function checkIdempotency(
  db: DatabaseClient,
  jobId: string,
  stepId: string,
): Promise<IdempotencyCheck> {
  const executionId = computeExecutionId(jobId, stepId);

  return db.transaction<IdempotencyCheck>('meridian', async () => {
    const rows = await db.query<ExecutionLogRow>(
      'meridian',
      'SELECT * FROM execution_log WHERE execution_id = ?',
      [executionId],
    );

    if (rows.length === 0) {
      // Case 3: Not found — insert started entry and proceed
      const now = new Date().toISOString();
      await db.run(
        'meridian',
        `INSERT INTO execution_log (execution_id, job_id, step_id, status, started_at)
         VALUES (?, ?, ?, 'started', ?)`,
        [executionId, jobId, stepId, now],
      );
      return { outcome: 'execute', executionId };
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked above
    const existing = rows[0]!;

    if (existing.status === 'completed') {
      // Case 1: Completed — return cached result
      const result = existing.result_json
        ? (JSON.parse(existing.result_json) as Record<string, unknown>)
        : {};
      return { outcome: 'cached', executionId, result };
    }

    // Case 2: Started (stale from crash) or failed — reset and re-execute.
    // We reset the entry to 'started' with a fresh timestamp, clearing any
    // previous result. The execution ID stays the same so that a successful
    // completion will be found by future idempotency checks.
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `UPDATE execution_log
       SET status = 'started', started_at = ?, result_json = NULL, completed_at = NULL
       WHERE execution_id = ?`,
      [now, executionId],
    );

    return { outcome: 'execute', executionId };
  });
}

// ---------------------------------------------------------------------------
// Completion recording (after successful execution)
// ---------------------------------------------------------------------------

/**
 * Mark an execution as completed with its result.
 *
 * @param db - Database client
 * @param executionId - The execution ID returned by checkIdempotency
 * @param result - The execution result to cache
 */
export async function recordCompletion(
  db: DatabaseClient,
  executionId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    'meridian',
    `UPDATE execution_log
     SET status = 'completed', result_json = ?, completed_at = ?
     WHERE execution_id = ?`,
    [JSON.stringify(result), now, executionId],
  );
}

// ---------------------------------------------------------------------------
// Failure recording (after failed execution)
// ---------------------------------------------------------------------------

/**
 * Mark an execution as failed.
 *
 * A failed execution can be retried by calling checkIdempotency again,
 * which will reset the entry to 'started'.
 *
 * @param db - Database client
 * @param executionId - The execution ID returned by checkIdempotency
 */
export async function recordFailure(
  db: DatabaseClient,
  executionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    'meridian',
    `UPDATE execution_log
     SET status = 'failed', completed_at = ?
     WHERE execution_id = ?`,
    [now, executionId],
  );
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Get all execution log entries for a job.
 *
 * @param db - Database client
 * @param jobId - The job ID
 * @returns All execution log entries for the job, ordered by started_at
 */
export async function getExecutionLog(
  db: DatabaseClient,
  jobId: string,
): Promise<ExecutionLogEntry[]> {
  const rows = await db.query<ExecutionLogRow>(
    'meridian',
    'SELECT * FROM execution_log WHERE job_id = ? ORDER BY started_at ASC',
    [jobId],
  );

  return rows.map(rowToEntry);
}

/**
 * Get a single execution log entry by ID.
 *
 * @param db - Database client
 * @param executionId - The execution ID
 * @returns The entry, or undefined if not found
 */
export async function getExecutionEntry(
  db: DatabaseClient,
  executionId: string,
): Promise<ExecutionLogEntry | undefined> {
  const rows = await db.query<ExecutionLogRow>(
    'meridian',
    'SELECT * FROM execution_log WHERE execution_id = ?',
    [executionId],
  );

  const first = rows[0];
  return first !== undefined ? rowToEntry(first) : undefined;
}
