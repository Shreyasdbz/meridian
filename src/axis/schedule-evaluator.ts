// @meridian/axis — Schedule evaluator (Phase 9.4)
// Polls for due schedules and creates jobs through the job queue.

import type { DatabaseClient } from '@meridian/shared';
import {
  SCHEDULE_EVAL_INTERVAL_MS,
  getNextRun,
  parseCronExpression,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for the schedule evaluator.
 */
export interface ScheduleEvaluatorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Callback to create a job from a schedule.
 * Returns the created job ID.
 */
export type ScheduleJobCreator = (options: {
  source: 'schedule';
  metadata: Record<string, unknown>;
}) => Promise<{ id: string }>;

/**
 * Configuration for the schedule evaluator.
 */
export interface ScheduleEvaluatorConfig {
  /** Database client for reading schedules. */
  db: DatabaseClient;
  /** Callback to create jobs. */
  createJob: ScheduleJobCreator;
  /** Optional logger. */
  logger?: ScheduleEvaluatorLogger;
  /** Override polling interval for testing (ms). */
  intervalMs?: number;
}

/**
 * Row from the schedules table.
 */
interface ScheduleRow {
  id: string;
  name: string;
  cron_expression: string;
  job_template_json: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// ScheduleEvaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates cron schedules and creates jobs when due.
 *
 * Polls the `schedules` table on a configurable interval (default 60s),
 * finds enabled schedules whose `next_run_at` has passed, creates a job
 * for each, and updates `last_run_at` / `next_run_at`.
 */
export class ScheduleEvaluator {
  private readonly db: DatabaseClient;
  private readonly createJob: ScheduleJobCreator;
  private readonly logger: ScheduleEvaluatorLogger;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(config: ScheduleEvaluatorConfig) {
    this.db = config.db;
    this.createJob = config.createJob;
    this.logger = config.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.intervalMs = config.intervalMs ?? SCHEDULE_EVAL_INTERVAL_MS;
  }

  /**
   * Start polling for due schedules.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Run immediately on start, then on interval
    void this.evaluate();
    this.timer = setInterval(() => {
      void this.evaluate();
    }, this.intervalMs);

    this.logger.info('Schedule evaluator started', {
      intervalMs: this.intervalMs,
    });
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.logger.info('Schedule evaluator stopped');
  }

  /**
   * Evaluate all due schedules and create jobs.
   * Can be called manually for testing.
   *
   * @returns Number of jobs created
   */
  async evaluate(): Promise<number> {
    const now = new Date();
    const nowIso = now.toISOString();

    let created = 0;

    try {
      // Find enabled schedules that are due (next_run_at <= now)
      const dueSchedules = await this.db.query<ScheduleRow>(
        'meridian',
        `SELECT * FROM schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
        [nowIso],
      );

      for (const schedule of dueSchedules) {
        try {
          await this.processSchedule(schedule, now);
          created++;
        } catch (error) {
          // Isolate errors per schedule — one failure shouldn't block others
          this.logger.error('Failed to process schedule', {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (created > 0) {
        this.logger.info('Schedules evaluated', {
          dueCount: dueSchedules.length,
          createdCount: created,
        });
      }
    } catch (error) {
      this.logger.error('Schedule evaluation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return created;
  }

  /**
   * Process a single due schedule: create job and update next_run_at.
   */
  private async processSchedule(
    schedule: ScheduleRow,
    now: Date,
  ): Promise<void> {
    // Parse the job template
    let template: Record<string, unknown>;
    try {
      template = JSON.parse(schedule.job_template_json) as Record<string, unknown>;
    } catch {
      this.logger.warn('Invalid job template JSON for schedule', {
        scheduleId: schedule.id,
      });
      return;
    }

    // Create a job
    const job = await this.createJob({
      source: 'schedule',
      metadata: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        cronExpression: schedule.cron_expression,
        ...template,
      },
    });

    this.logger.info('Created scheduled job', {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      jobId: job.id,
    });

    // Calculate next run
    let nextRunAt: string | null = null;
    try {
      const cron = parseCronExpression(schedule.cron_expression);
      const nextRun = getNextRun(cron, now);
      nextRunAt = nextRun?.toISOString() ?? null;
    } catch {
      this.logger.warn('Invalid cron expression for schedule', {
        scheduleId: schedule.id,
        expression: schedule.cron_expression,
      });
    }

    // Update last_run_at and next_run_at
    await this.db.run(
      'meridian',
      `UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?`,
      [now.toISOString(), nextRunAt, schedule.id],
    );
  }
}
