// @meridian/axis — SQLite-backed job queue with atomic state machine transitions
// Architecture Reference: Sections 5.1.2, 5.1.3, 5.1.6

import type {
  Job,
  JobPriority,
  JobSource,
  JobStatus,
  ExecutionPlan,
  ValidationResult,
  DatabaseClient,
} from '@meridian/shared';
import {
  generateId,
  ConflictError,
  NotFoundError,
  ValidationError,
  MAX_REVISION_COUNT,
  MAX_REPLAN_COUNT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_JOB_TIMEOUT_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// State machine definition (Section 5.1.3)
// ---------------------------------------------------------------------------

/**
 * Valid state transitions per the architecture's job state machine.
 * Terminal states (completed, failed, cancelled) have no outgoing transitions.
 * Any non-terminal state can transition to 'cancelled'.
 */
const VALID_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  pending: ['planning', 'cancelled'],
  planning: ['validating', 'completed', 'failed', 'cancelled'],
  validating: ['executing', 'awaiting_approval', 'planning', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'cancelled'],
  executing: ['completed', 'failed', 'planning', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL_STATES: ReadonlySet<JobStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// Job creation options
// ---------------------------------------------------------------------------

export interface CreateJobOptions {
  conversationId?: string;
  parentId?: string;
  priority?: JobPriority;
  source: JobSource;
  sourceMessageId?: string;
  dedupHash?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transition options
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  workerId?: string;
  plan?: ExecutionPlan;
  validation?: ValidationResult;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retriable: boolean };
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Database row shape
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  parent_id: string | null;
  conversation_id: string | null;
  status: string;
  priority: string;
  source_type: string;
  source_message_id: string | null;
  dedup_hash: string | null;
  worker_id: string | null;
  plan_json: string | null;
  validation_json: string | null;
  result_json: string | null;
  error_json: string | null;
  attempts: number;
  max_attempts: number;
  timeout_ms: number;
  revision_count: number;
  replan_count: number;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Row <-> Domain mapping
// ---------------------------------------------------------------------------

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    status: row.status as JobStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conversationId: row.conversation_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    priority: row.priority as JobPriority,
    source: row.source_type as JobSource,
    workerId: row.worker_id ?? undefined,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as ExecutionPlan) : undefined,
    validation: row.validation_json
      ? (JSON.parse(row.validation_json) as ValidationResult)
      : undefined,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : undefined,
    error: row.error_json
      ? (JSON.parse(row.error_json) as { code: string; message: string; retriable: boolean })
      : undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    timeoutMs: row.timeout_ms,
    completedAt: row.completed_at ?? undefined,
    revisionCount: row.revision_count,
    replanCount: row.replan_count,
    dedupHash: row.dedup_hash ?? undefined,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// JobQueue
// ---------------------------------------------------------------------------

/**
 * SQLite-backed job queue with atomic state machine transitions.
 *
 * All state transitions use compare-and-swap (CAS) to prevent race conditions:
 *   `UPDATE jobs SET status = ? WHERE id = ? AND status = ?`
 *
 * The queue uses SQLite as the persistence layer — there is no separate
 * in-memory queue (Section 5.1.6).
 */
export class JobQueue {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // Job creation
  // -------------------------------------------------------------------------

  /**
   * Create a new job in the 'pending' state.
   *
   * @returns The created job
   */
  async createJob(options: CreateJobOptions): Promise<Job> {
    const id = generateId();
    const now = new Date().toISOString();

    const metadataJson = options.metadata ? JSON.stringify(options.metadata) : null;

    let result;
    try {
      result = await this.db.run(
        'meridian',
        `INSERT INTO jobs (
          id, conversation_id, parent_id, status, priority,
          source_type, source_message_id, dedup_hash,
          max_attempts, timeout_ms, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          options.conversationId ?? null,
          options.parentId ?? null,
          options.priority ?? 'normal',
          options.source,
          options.sourceMessageId ?? null,
          options.dedupHash ?? null,
          options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
          metadataJson,
          now,
          now,
        ],
      );
    } catch (error: unknown) {
      // UNIQUE constraint on dedup_hash — a non-terminal job with this hash
      // already exists (race condition between check and insert)
      if (
        options.dedupHash &&
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
        throw new ConflictError(
          `Duplicate request: a job with dedup hash '${options.dedupHash.slice(0, 8)}...' already exists`,
        );
      }
      throw error;
    }

    if (result.changes !== 1) {
      throw new ConflictError(`Failed to create job: no rows inserted`);
    }

    return {
      id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      conversationId: options.conversationId,
      parentId: options.parentId,
      priority: options.priority ?? 'normal',
      source: options.source,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      timeoutMs: options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
      dedupHash: options.dedupHash,
      metadata: options.metadata,
      attempts: 0,
      revisionCount: 0,
      replanCount: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Job retrieval
  // -------------------------------------------------------------------------

  /**
   * Get a job by ID.
   *
   * @returns The job, or undefined if not found
   */
  async getJob(id: string): Promise<Job | undefined> {
    const rows = await this.db.query<JobRow>(
      'meridian',
      'SELECT * FROM jobs WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked above
    return rowToJob(rows[0]!);
  }

  // -------------------------------------------------------------------------
  // Job claiming (pending → planning)
  // -------------------------------------------------------------------------

  /**
   * Claim the next pending job for a worker using atomic CAS.
   *
   * Jobs are claimed in priority order (critical > high > normal > low),
   * then by creation time (FIFO within same priority).
   *
   * @param workerId — The ID of the claiming worker
   * @returns The claimed job, or undefined if no pending jobs
   */
  async claimJob(workerId: string): Promise<Job | undefined> {
    if (!workerId) {
      throw new ValidationError('workerId is required');
    }

    // Use a transaction to atomically find + claim
    return this.db.transaction<Job | undefined>('meridian', async () => {
      // Find the highest-priority pending job
      const candidates = await this.db.query<JobRow>(
        'meridian',
        `SELECT * FROM jobs
         WHERE status = 'pending'
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'normal' THEN 2
             WHEN 'low' THEN 3
           END,
           created_at ASC
         LIMIT 1`,
      );

      if (candidates.length === 0) {
        return undefined;
      }

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked above
      const candidate = candidates[0]!;
      const now = new Date().toISOString();

      // Atomic CAS: only claim if still pending
      const result = await this.db.run(
        'meridian',
        `UPDATE jobs
         SET status = 'planning', worker_id = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        [workerId, now, candidate.id],
      );

      if (result.changes === 0) {
        // Another worker claimed it between SELECT and UPDATE
        return undefined;
      }

      return rowToJob({
        ...candidate,
        status: 'planning',
        worker_id: workerId,
        updated_at: now,
      });
    });
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  /**
   * Transition a job from one state to another using atomic CAS.
   *
   * Validates that the transition is allowed by the state machine and
   * enforces cycle limits (revisionCount, replanCount).
   *
   * @param jobId — The job ID
   * @param from — The expected current state (for CAS)
   * @param to — The target state
   * @param options — Optional updates to apply alongside the transition
   * @returns true if the transition succeeded, false if CAS failed
   * @throws ValidationError if the transition is not allowed by the state machine
   * @throws NotFoundError if the job does not exist
   */
  async transition(
    jobId: string,
    from: JobStatus,
    to: JobStatus,
    options?: TransitionOptions,
  ): Promise<boolean> {
    // Validate the transition is allowed by the state machine
    this.validateTransition(from, to);

    // Check cycle limits for revision transitions (validating → planning)
    if (from === 'validating' && to === 'planning') {
      const job = await this.getJob(jobId);
      if (!job) {
        throw new NotFoundError(`Job '${jobId}' not found`);
      }
      if ((job.revisionCount ?? 0) >= MAX_REVISION_COUNT) {
        throw new ValidationError(
          `Job '${jobId}' has reached the maximum revision count (${MAX_REVISION_COUNT})`,
        );
      }
    }

    // Check cycle limits for replan transitions (executing → planning)
    if (from === 'executing' && to === 'planning') {
      const job = await this.getJob(jobId);
      if (!job) {
        throw new NotFoundError(`Job '${jobId}' not found`);
      }
      if ((job.replanCount ?? 0) >= MAX_REPLAN_COUNT) {
        throw new ValidationError(
          `Job '${jobId}' has reached the maximum replan count (${MAX_REPLAN_COUNT})`,
        );
      }
    }

    // Build the UPDATE query dynamically
    const setClauses: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [to, new Date().toISOString()];

    if (options?.workerId !== undefined) {
      setClauses.push('worker_id = ?');
      params.push(options.workerId);
    }

    if (options?.plan !== undefined) {
      setClauses.push('plan_json = ?');
      params.push(JSON.stringify(options.plan));
    }

    if (options?.validation !== undefined) {
      setClauses.push('validation_json = ?');
      params.push(JSON.stringify(options.validation));
    }

    if (options?.result !== undefined) {
      setClauses.push('result_json = ?');
      params.push(JSON.stringify(options.result));
    }

    if (options?.error !== undefined) {
      setClauses.push('error_json = ?');
      params.push(JSON.stringify(options.error));
    }

    if (options?.metadata !== undefined) {
      setClauses.push('metadata_json = ?');
      params.push(JSON.stringify(options.metadata));
    }

    // Increment cycle counters on the appropriate transitions
    if (from === 'validating' && to === 'planning') {
      setClauses.push('revision_count = revision_count + 1');
    }
    if (from === 'executing' && to === 'planning') {
      setClauses.push('replan_count = replan_count + 1');
    }

    // Set completedAt for terminal states
    if (TERMINAL_STATES.has(to)) {
      setClauses.push('completed_at = ?');
      params.push(new Date().toISOString());
    }

    // CAS WHERE clause
    params.push(jobId, from);

    const result = await this.db.run(
      'meridian',
      `UPDATE jobs SET ${setClauses.join(', ')} WHERE id = ? AND status = ?`,
      params,
    );

    if (result.changes === 0) {
      // Check if the job exists at all
      const job = await this.getJob(jobId);
      if (!job) {
        throw new NotFoundError(`Job '${jobId}' not found`);
      }
      // CAS failed — job is in a different state
      return false;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Cancel (convenience method)
  // -------------------------------------------------------------------------

  /**
   * Cancel a job. Works from any non-terminal state.
   *
   * @returns true if cancelled, false if already in a terminal state
   * @throws NotFoundError if the job does not exist
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new NotFoundError(`Job '${jobId}' not found`);
    }

    if (TERMINAL_STATES.has(job.status)) {
      return false;
    }

    return this.transition(jobId, job.status, 'cancelled');
  }

  // -------------------------------------------------------------------------
  // Queue depth
  // -------------------------------------------------------------------------

  /**
   * Get the number of jobs in the pending state.
   */
  async getQueueDepth(): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      'meridian',
      `SELECT COUNT(*) as count FROM jobs WHERE status = 'pending'`,
    );

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- COUNT always returns one row
    return rows[0]!.count;
  }

  /**
   * Get the count of jobs in non-terminal states.
   */
  async getActiveJobCount(): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      'meridian',
      `SELECT COUNT(*) as count FROM jobs
       WHERE status NOT IN ('completed', 'failed', 'cancelled')`,
    );

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- COUNT always returns one row
    return rows[0]!.count;
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  /**
   * Validate that a state transition is allowed by the state machine.
   *
   * @throws ValidationError if the transition is invalid
   */
  private validateTransition(from: JobStatus, to: JobStatus): void {
    if (TERMINAL_STATES.has(from)) {
      throw new ValidationError(
        `Cannot transition from terminal state '${from}'`,
      );
    }

    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new ValidationError(
        `Invalid transition: '${from}' → '${to}'`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { VALID_TRANSITIONS, TERMINAL_STATES };
