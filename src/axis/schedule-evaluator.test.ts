import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ScheduleEvaluator } from './schedule-evaluator.js';
import type {
  ScheduleEvaluatorLogger,
  ScheduleJobCreator,
} from './schedule-evaluator.js';

// ---------------------------------------------------------------------------
// Mock cron-parser (avoid real cron logic in unit tests)
// ---------------------------------------------------------------------------

vi.mock('@meridian/shared', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@meridian/shared')>();
  return {
    ...actual,
  parseCronExpression: vi.fn().mockReturnValue({
    minutes: new Set([0]),
    hours: new Set([0]),
    daysOfMonth: new Set(Array.from({ length: 31 }, (_, i) => i + 1)),
    months: new Set(Array.from({ length: 12 }, (_, i) => i + 1)),
    daysOfWeek: new Set(Array.from({ length: 7 }, (_, i) => i)),
    expression: '0 0 * * *',
  }),
  getNextRun: vi.fn().mockReturnValue(new Date('2026-02-14T00:00:00.000Z')),
  };
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface MockDatabaseClient {
  query: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockDb(): MockDatabaseClient {
  return {
    query: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
  };
}

function createMockLogger(): ScheduleEvaluatorLogger & {
  messages: Array<{
    level: string;
    message: string;
    data?: Record<string, unknown>;
  }>;
} {
  const messages: Array<{
    level: string;
    message: string;
    data?: Record<string, unknown>;
  }> = [];
  return {
    messages,
    info: (message, data) => {
      messages.push({ level: 'info', message, data });
    },
    warn: (message, data) => {
      messages.push({ level: 'warn', message, data });
    },
    error: (message, data) => {
      messages.push({ level: 'error', message, data });
    },
  };
}

function createMockCreateJob(): ScheduleJobCreator &
  ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ id: 'job-001' });
}

function makeScheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched-001',
    name: 'Daily backup',
    cron_expression: '0 0 * * *',
    job_template_json: JSON.stringify({ task: 'backup', target: 'all' }),
    enabled: 1,
    last_run_at: null,
    next_run_at: '2026-02-13T00:00:00.000Z',
    created_at: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScheduleEvaluator', () => {
  let db: MockDatabaseClient;
  let logger: ReturnType<typeof createMockLogger>;
  let createJob: ScheduleJobCreator & ReturnType<typeof vi.fn>;
  let evaluator: ScheduleEvaluator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-13T12:00:00.000Z'));

    db = createMockDb();
    logger = createMockLogger();
    createJob = createMockCreateJob();

    evaluator = new ScheduleEvaluator({
      db: db as unknown as Parameters<
        typeof ScheduleEvaluator.prototype.evaluate
      > extends never[]
        ? never
        : ConstructorParameters<typeof ScheduleEvaluator>[0]['db'],
      createJob,
      logger,
      intervalMs: 1000, // 1s for fast test cycles
    });
  });

  afterEach(() => {
    evaluator.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // evaluate()
  // -------------------------------------------------------------------------

  describe('evaluate()', () => {
    it('should create a job when a schedule is due', async () => {
      const row = makeScheduleRow();
      db.query.mockResolvedValueOnce([row]);

      const count = await evaluator.evaluate();

      expect(count).toBe(1);
      expect(createJob).toHaveBeenCalledOnce();
      expect(createJob).toHaveBeenCalledWith({
        source: 'schedule',
        metadata: {
          scheduleId: 'sched-001',
          scheduleName: 'Daily backup',
          cronExpression: '0 0 * * *',
          task: 'backup',
          target: 'all',
        },
      });
    });

    it('should query only enabled schedules with next_run_at <= now', async () => {
      db.query.mockResolvedValueOnce([]);

      await evaluator.evaluate();

      expect(db.query).toHaveBeenCalledOnce();
      const [dbName, sql, params] = db.query.mock.calls[0] as [
        string,
        string,
        unknown[],
      ];
      expect(dbName).toBe('meridian');
      expect(sql).toContain('enabled = 1');
      expect(sql).toContain('next_run_at IS NOT NULL');
      expect(sql).toContain('next_run_at <= ?');
      // The param should be the current time in ISO format
      expect(params[0]).toBe('2026-02-13T12:00:00.000Z');
    });

    it('should update last_run_at and next_run_at after creating a job', async () => {
      const row = makeScheduleRow();
      db.query.mockResolvedValueOnce([row]);

      await evaluator.evaluate();

      expect(db.run).toHaveBeenCalledOnce();
      const [dbName, sql, params] = db.run.mock.calls[0] as [
        string,
        string,
        unknown[],
      ];
      expect(dbName).toBe('meridian');
      expect(sql).toContain('UPDATE schedules');
      expect(sql).toContain('last_run_at = ?');
      expect(sql).toContain('next_run_at = ?');
      expect(sql).toContain('WHERE id = ?');
      // last_run_at should be set to now
      expect(params[0]).toBe('2026-02-13T12:00:00.000Z');
      // next_run_at comes from the mocked getNextRun
      expect(params[1]).toBe('2026-02-14T00:00:00.000Z');
      // schedule id
      expect(params[2]).toBe('sched-001');
    });

    it('should handle multiple due schedules in one evaluation', async () => {
      const row1 = makeScheduleRow({
        id: 'sched-001',
        name: 'Daily backup',
      });
      const row2 = makeScheduleRow({
        id: 'sched-002',
        name: 'Hourly sync',
        cron_expression: '0 * * * *',
      });
      const row3 = makeScheduleRow({
        id: 'sched-003',
        name: 'Weekly report',
        cron_expression: '0 0 * * 0',
      });

      db.query.mockResolvedValueOnce([row1, row2, row3]);
      createJob
        .mockResolvedValueOnce({ id: 'job-001' })
        .mockResolvedValueOnce({ id: 'job-002' })
        .mockResolvedValueOnce({ id: 'job-003' });

      const count = await evaluator.evaluate();

      expect(count).toBe(3);
      expect(createJob).toHaveBeenCalledTimes(3);
      expect(db.run).toHaveBeenCalledTimes(3);
    });

    it('should isolate errors per schedule so one failure does not block others', async () => {
      const row1 = makeScheduleRow({
        id: 'sched-001',
        name: 'Will fail',
      });
      const row2 = makeScheduleRow({
        id: 'sched-002',
        name: 'Will succeed',
      });

      db.query.mockResolvedValueOnce([row1, row2]);
      createJob
        .mockRejectedValueOnce(new Error('Provider unavailable'))
        .mockResolvedValueOnce({ id: 'job-002' });

      const count = await evaluator.evaluate();

      // Only the second schedule should have succeeded
      expect(count).toBe(1);
      expect(createJob).toHaveBeenCalledTimes(2);

      // An error should have been logged for the first schedule
      const errorMsg = logger.messages.find(
        (m) =>
          m.level === 'error' &&
          m.message === 'Failed to process schedule',
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg?.data?.scheduleId).toBe('sched-001');
      expect(errorMsg?.data?.error).toBe('Provider unavailable');
    });

    it('should handle invalid job template JSON gracefully', async () => {
      const row = makeScheduleRow({
        job_template_json: '{not valid json!!!',
      });
      db.query.mockResolvedValueOnce([row]);

      const count = await evaluator.evaluate();

      // Invalid JSON should be skipped without throwing
      // The processSchedule returns early, but the outer try/catch increments
      // count only if processSchedule completes without throwing.
      // Since the invalid JSON causes an early return (not a throw),
      // processSchedule resolves successfully, so count is incremented.
      expect(count).toBe(1);
      expect(createJob).not.toHaveBeenCalled();

      // A warning should have been logged
      const warnMsg = logger.messages.find(
        (m) =>
          m.level === 'warn' &&
          m.message === 'Invalid job template JSON for schedule',
      );
      expect(warnMsg).toBeDefined();
      expect(warnMsg?.data?.scheduleId).toBe('sched-001');
    });

    it('should return count of created jobs', async () => {
      const row1 = makeScheduleRow({ id: 'sched-001' });
      const row2 = makeScheduleRow({ id: 'sched-002' });
      db.query.mockResolvedValueOnce([row1, row2]);
      createJob
        .mockResolvedValueOnce({ id: 'job-001' })
        .mockResolvedValueOnce({ id: 'job-002' });

      const count = await evaluator.evaluate();

      expect(count).toBe(2);
    });

    it('should return 0 when no schedules are due', async () => {
      db.query.mockResolvedValueOnce([]);

      const count = await evaluator.evaluate();

      expect(count).toBe(0);
      expect(createJob).not.toHaveBeenCalled();
      expect(db.run).not.toHaveBeenCalled();
    });

    it('should log summary only when jobs are created', async () => {
      // No due schedules
      db.query.mockResolvedValueOnce([]);
      await evaluator.evaluate();

      const summaryBefore = logger.messages.find(
        (m) => m.message === 'Schedules evaluated',
      );
      expect(summaryBefore).toBeUndefined();

      // Now with a due schedule
      db.query.mockResolvedValueOnce([makeScheduleRow()]);
      await evaluator.evaluate();

      const summaryAfter = logger.messages.find(
        (m) => m.message === 'Schedules evaluated',
      );
      expect(summaryAfter).toBeDefined();
      expect(summaryAfter?.data?.createdCount).toBe(1);
    });

    it('should catch and log top-level query errors', async () => {
      db.query.mockRejectedValueOnce(new Error('Database locked'));

      const count = await evaluator.evaluate();

      expect(count).toBe(0);

      const errorMsg = logger.messages.find(
        (m) =>
          m.level === 'error' &&
          m.message === 'Schedule evaluation failed',
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg?.data?.error).toBe('Database locked');
    });

    it('should log created job details', async () => {
      const row = makeScheduleRow();
      db.query.mockResolvedValueOnce([row]);
      createJob.mockResolvedValueOnce({ id: 'job-xyz' });

      await evaluator.evaluate();

      const infoMsg = logger.messages.find(
        (m) => m.message === 'Created scheduled job',
      );
      expect(infoMsg).toBeDefined();
      expect(infoMsg?.data?.jobId).toBe('job-xyz');
      expect(infoMsg?.data?.scheduleId).toBe('sched-001');
      expect(infoMsg?.data?.scheduleName).toBe('Daily backup');
    });

    it('should handle invalid cron expression when computing next run', async () => {
      const { parseCronExpression } = await import('@meridian/shared');
      (
        parseCronExpression as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => {
        throw new Error('Invalid cron: bad field');
      });

      const row = makeScheduleRow();
      db.query.mockResolvedValueOnce([row]);

      await evaluator.evaluate();

      // Should still update the schedule, but next_run_at will be null
      expect(db.run).toHaveBeenCalledOnce();
      const [, , params] = db.run.mock.calls[0] as [
        string,
        string,
        unknown[],
      ];
      // next_run_at should be null when cron parse fails
      expect(params[1]).toBeNull();

      const warnMsg = logger.messages.find(
        (m) =>
          m.level === 'warn' &&
          m.message === 'Invalid cron expression for schedule',
      );
      expect(warnMsg).toBeDefined();
    });

    it('should spread template fields into job metadata', async () => {
      const row = makeScheduleRow({
        job_template_json: JSON.stringify({
          task: 'deploy',
          environment: 'staging',
          version: '2.1.0',
        }),
      });
      db.query.mockResolvedValueOnce([row]);

      await evaluator.evaluate();

      expect(createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            task: 'deploy',
            environment: 'staging',
            version: '2.1.0',
            scheduleId: 'sched-001',
            scheduleName: 'Daily backup',
            cronExpression: '0 0 * * *',
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // start() / stop()
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('should begin polling and run an immediate evaluation', async () => {
      db.query.mockResolvedValue([]);

      evaluator.start();

      // The first evaluate() is called immediately (via void this.evaluate())
      // Allow the microtask to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(db.query).toHaveBeenCalledOnce();

      // Advance by the interval to trigger the next poll
      await vi.advanceTimersByTimeAsync(1000);
      expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('should log when started', () => {
      evaluator.start();

      const startMsg = logger.messages.find(
        (m) => m.message === 'Schedule evaluator started',
      );
      expect(startMsg).toBeDefined();
      expect(startMsg?.data?.intervalMs).toBe(1000);
    });

    it('should be idempotent — calling twice does not create double intervals', async () => {
      db.query.mockResolvedValue([]);

      evaluator.start();
      evaluator.start(); // second call should be a no-op

      // Allow the immediate evaluate() to run
      await vi.advanceTimersByTimeAsync(0);

      // Only one immediate evaluate() should have been called
      expect(db.query).toHaveBeenCalledOnce();

      // Advance one full interval
      await vi.advanceTimersByTimeAsync(1000);

      // Only one interval tick should have fired (not two)
      expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('should continue polling at the configured interval', async () => {
      db.query.mockResolvedValue([]);

      evaluator.start();
      await vi.advanceTimersByTimeAsync(0); // immediate call

      // Advance through multiple intervals
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      // 1 immediate + 3 interval ticks = 4 total
      expect(db.query).toHaveBeenCalledTimes(4);
    });
  });

  describe('stop()', () => {
    it('should clear the interval and stop polling', async () => {
      db.query.mockResolvedValue([]);

      evaluator.start();
      await vi.advanceTimersByTimeAsync(0); // immediate call
      expect(db.query).toHaveBeenCalledOnce();

      evaluator.stop();

      // Advance time — no further polls should happen
      await vi.advanceTimersByTimeAsync(5000);
      expect(db.query).toHaveBeenCalledOnce();
    });

    it('should log when stopped', () => {
      evaluator.start();
      evaluator.stop();

      const stopMsg = logger.messages.find(
        (m) => m.message === 'Schedule evaluator stopped',
      );
      expect(stopMsg).toBeDefined();
    });

    it('should be idempotent — calling twice does not throw', () => {
      evaluator.start();
      evaluator.stop();
      evaluator.stop(); // second call should be a no-op

      // Only one stop message should be logged
      const stopMessages = logger.messages.filter(
        (m) => m.message === 'Schedule evaluator stopped',
      );
      expect(stopMessages).toHaveLength(1);
    });

    it('should be safe to call without ever starting', () => {
      // stop() on a never-started evaluator should not throw
      evaluator.stop();

      const stopMessages = logger.messages.filter(
        (m) => m.message === 'Schedule evaluator stopped',
      );
      expect(stopMessages).toHaveLength(0);
    });

    it('should allow restart after stop', async () => {
      db.query.mockResolvedValue([]);

      evaluator.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(db.query).toHaveBeenCalledOnce();

      evaluator.stop();
      db.query.mockClear();

      evaluator.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(db.query).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1000);
      expect(db.query).toHaveBeenCalledTimes(2);
    });
  });
});
