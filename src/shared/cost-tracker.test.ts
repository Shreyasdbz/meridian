import { describe, it, expect, vi, beforeEach } from 'vitest';

import { CostTracker } from './cost-tracker.js';
import type { CostTrackerLogger, LLMCallRecord } from './cost-tracker.js';

vi.mock('./id.js', () => ({ generateId: () => 'test-id' }));

// ---------------------------------------------------------------------------
// Mock DatabaseClient
// ---------------------------------------------------------------------------

interface MockDb {
  query: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  return {
    query: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 1 }),
  };
}

function createMockLogger(): CostTrackerLogger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<LLMCallRecord> = {}): LLMCallRecord {
  return {
    component: 'scout',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    inputTokens: 1000,
    outputTokens: 500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CostTracker', () => {
  let db: MockDb;
  let logger: ReturnType<typeof createMockLogger>;
  let tracker: CostTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    logger = createMockLogger();
    tracker = new CostTracker({
      db: db as unknown as ConstructorParameters<typeof CostTracker>[0]['db'],
      dailyLimitUsd: 5.0,
      logger,
    });
  });

  // -------------------------------------------------------------------------
  // calculateCost
  // -------------------------------------------------------------------------

  describe('calculateCost', () => {
    it('should calculate cost for claude-sonnet-4-5-20250929', () => {
      // claude-sonnet-4-5-20250929: input $3.0/1M, output $15.0/1M
      const cost = tracker.calculateCost(makeRecord({
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }));

      // 3.0 + 15.0 = 18.0
      expect(cost).toBeCloseTo(18.0, 6);
    });

    it('should calculate cost for gpt-4o', () => {
      // gpt-4o: input $2.5/1M, output $10.0/1M
      const cost = tracker.calculateCost(makeRecord({
        model: 'gpt-4o',
        provider: 'openai',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }));

      // 2.5 + 10.0 = 12.5
      expect(cost).toBeCloseTo(12.5, 6);
    });

    it('should fall back to default pricing for unknown models', () => {
      // default: input $3.0/1M, output $15.0/1M
      const cost = tracker.calculateCost(makeRecord({
        model: 'some-unknown-model-v99',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }));

      // 3.0 + 15.0 = 18.0 (same as default)
      expect(cost).toBeCloseTo(18.0, 6);
    });

    it('should include cached token cost when model supports it', () => {
      // claude-sonnet-4-5-20250929: cachedInputPer1M = $0.3/1M
      const cost = tracker.calculateCost(makeRecord({
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedTokens: 1_000_000,
      }));

      // input: 3.0 + output: 0 + cached: 0.3 = 3.3
      expect(cost).toBeCloseTo(3.3, 6);
    });

    it('should not add cached cost when model has no cachedInputPer1M', () => {
      // gpt-4o has no cachedInputPer1M defined
      const cost = tracker.calculateCost(makeRecord({
        model: 'gpt-4o',
        provider: 'openai',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedTokens: 1_000_000,
      }));

      // input: 2.5 + output: 0 + cached: 0 (no cachedInputPer1M) = 2.5
      expect(cost).toBeCloseTo(2.5, 6);
    });

    it('should return zero cost for zero tokens', () => {
      const cost = tracker.calculateCost(makeRecord({
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      }));

      expect(cost).toBe(0);
    });

    it('should handle fractional token counts correctly', () => {
      // claude-sonnet-4-5-20250929: input $3.0/1M, output $15.0/1M
      const cost = tracker.calculateCost(makeRecord({
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 500,
        outputTokens: 100,
      }));

      // (500 / 1M) * 3.0 + (100 / 1M) * 15.0
      // = 0.0015 + 0.0015 = 0.003
      expect(cost).toBeCloseTo(0.003, 6);
    });
  });

  // -------------------------------------------------------------------------
  // recordCall
  // -------------------------------------------------------------------------

  describe('recordCall', () => {
    it('should insert into llm_calls table', async () => {
      // getAlertLevel -> getDailyCostTotal returns 0
      db.query.mockResolvedValue([{ total: 0 }]);

      await tracker.recordCall(makeRecord());

      // First db.run call is the INSERT INTO llm_calls
      expect(db.run).toHaveBeenCalledTimes(2);
      const [firstCallDb, firstCallSql, firstCallParams] = db.run.mock.calls[0]!;
      expect(firstCallDb).toBe('meridian');
      expect(firstCallSql).toContain('INSERT INTO llm_calls');
      expect(firstCallParams[0]).toBe('test-id'); // from mocked generateId
      expect(firstCallParams[2]).toBe('scout');
      expect(firstCallParams[3]).toBe('anthropic');
      expect(firstCallParams[4]).toBe('claude-sonnet-4-5-20250929');
      expect(firstCallParams[5]).toBe(1000); // inputTokens
      expect(firstCallParams[6]).toBe(500); // outputTokens
    });

    it('should upsert into cost_daily table', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      await tracker.recordCall(makeRecord());

      // Second db.run call is the INSERT INTO cost_daily (upsert)
      const [secondCallDb, secondCallSql] = db.run.mock.calls[1]!;
      expect(secondCallDb).toBe('meridian');
      expect(secondCallSql).toContain('INSERT INTO cost_daily');
      expect(secondCallSql).toContain('ON CONFLICT');
    });

    it('should return computed cost', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      // claude-sonnet-4-5-20250929: input $3.0/1M, output $15.0/1M
      const result = await tracker.recordCall(makeRecord({
        inputTokens: 1000,
        outputTokens: 500,
      }));

      // (1000 / 1M) * 3.0 + (500 / 1M) * 15.0 = 0.003 + 0.0075 = 0.0105
      expect(result.costUsd).toBeCloseTo(0.0105, 6);
    });

    it('should return alert level "none" when daily cost is low', async () => {
      // Total daily cost is well under 80% of $5.0
      db.query.mockResolvedValue([{ total: 0.5 }]);

      const result = await tracker.recordCall(makeRecord());

      expect(result.alertLevel).toBe('none');
    });

    it('should return alert level "warning" at 80% threshold', async () => {
      // 80% of $5.0 = $4.0
      db.query.mockResolvedValue([{ total: 4.0 }]);

      const result = await tracker.recordCall(makeRecord());

      expect(result.alertLevel).toBe('warning');
    });

    it('should return alert level "critical" at 95% threshold', async () => {
      // 95% of $5.0 = $4.75
      db.query.mockResolvedValue([{ total: 4.75 }]);

      const result = await tracker.recordCall(makeRecord());

      expect(result.alertLevel).toBe('critical');
    });

    it('should return alert level "limit_reached" at 100% limit', async () => {
      // 100% of $5.0 = $5.0
      db.query.mockResolvedValue([{ total: 5.0 }]);

      const result = await tracker.recordCall(makeRecord());

      expect(result.alertLevel).toBe('limit_reached');
    });

    it('should log warning at 80% threshold', async () => {
      db.query.mockResolvedValue([{ total: 4.0 }]);

      await tracker.recordCall(makeRecord());

      expect(logger.warn).toHaveBeenCalledWith(
        'Daily cost at warning threshold',
        expect.objectContaining({ threshold: 80 }),
      );
    });

    it('should log warning at critical (95%) threshold', async () => {
      db.query.mockResolvedValue([{ total: 4.75 }]);

      await tracker.recordCall(makeRecord());

      expect(logger.warn).toHaveBeenCalledWith(
        'Daily cost at critical threshold',
        expect.objectContaining({ threshold: 95 }),
      );
    });

    it('should log error at 100% limit', async () => {
      db.query.mockResolvedValue([{ total: 5.0 }]);

      await tracker.recordCall(makeRecord());

      expect(logger.error).toHaveBeenCalledWith(
        'Daily cost limit reached',
        expect.objectContaining({ limitUsd: 5.0 }),
      );
    });

    it('should pass null for jobId when not provided', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      await tracker.recordCall(makeRecord({ jobId: undefined }));

      const [, , params] = db.run.mock.calls[0]!;
      expect(params[1]).toBeNull(); // job_id
    });

    it('should pass jobId when provided', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      await tracker.recordCall(makeRecord({ jobId: 'job-123' }));

      const [, , params] = db.run.mock.calls[0]!;
      expect(params[1]).toBe('job-123');
    });

    it('should default cachedTokens to 0 when not provided', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      await tracker.recordCall(makeRecord({ cachedTokens: undefined }));

      const [, , insertParams] = db.run.mock.calls[0]!;
      expect(insertParams[7]).toBe(0); // cached_tokens in llm_calls
    });

    it('should default durationMs to 0 when not provided', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      await tracker.recordCall(makeRecord({ durationMs: undefined }));

      const [, , insertParams] = db.run.mock.calls[0]!;
      expect(insertParams[9]).toBe(0); // duration_ms in llm_calls
    });
  });

  // -------------------------------------------------------------------------
  // isLimitReached
  // -------------------------------------------------------------------------

  describe('isLimitReached', () => {
    it('should return false when under the limit', async () => {
      db.query.mockResolvedValue([{ total: 3.0 }]);

      const reached = await tracker.isLimitReached('2026-02-13');

      expect(reached).toBe(false);
    });

    it('should return true when at the limit', async () => {
      db.query.mockResolvedValue([{ total: 5.0 }]);

      const reached = await tracker.isLimitReached('2026-02-13');

      expect(reached).toBe(true);
    });

    it('should return true when over the limit', async () => {
      db.query.mockResolvedValue([{ total: 6.5 }]);

      const reached = await tracker.isLimitReached('2026-02-13');

      expect(reached).toBe(true);
    });

    it('should use current date when no date is provided', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      await tracker.isLimitReached();

      expect(db.query).toHaveBeenCalledWith(
        'meridian',
        expect.stringContaining('FROM cost_daily WHERE date = ?'),
        expect.arrayContaining([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getAlertLevel
  // -------------------------------------------------------------------------

  describe('getAlertLevel', () => {
    it('should return "none" when under 80%', async () => {
      // 79% of $5.0 = $3.95
      db.query.mockResolvedValue([{ total: 3.95 }]);

      const level = await tracker.getAlertLevel('2026-02-13');

      expect(level).toBe('none');
    });

    it('should return "warning" at exactly 80%', async () => {
      // 80% of $5.0 = $4.0
      db.query.mockResolvedValue([{ total: 4.0 }]);

      const level = await tracker.getAlertLevel('2026-02-13');

      expect(level).toBe('warning');
    });

    it('should return "warning" between 80% and 95%', async () => {
      // 90% of $5.0 = $4.5
      db.query.mockResolvedValue([{ total: 4.5 }]);

      const level = await tracker.getAlertLevel('2026-02-13');

      expect(level).toBe('warning');
    });

    it('should return "critical" at exactly 95%', async () => {
      // 95% of $5.0 = $4.75
      db.query.mockResolvedValue([{ total: 4.75 }]);

      const level = await tracker.getAlertLevel('2026-02-13');

      expect(level).toBe('critical');
    });

    it('should return "critical" between 95% and 100%', async () => {
      // 99% of $5.0 = $4.95
      db.query.mockResolvedValue([{ total: 4.95 }]);

      const level = await tracker.getAlertLevel('2026-02-13');

      expect(level).toBe('critical');
    });

    it('should return "limit_reached" at exactly 100%', async () => {
      // 100% of $5.0 = $5.0
      db.query.mockResolvedValue([{ total: 5.0 }]);

      const level = await tracker.getAlertLevel('2026-02-13');

      expect(level).toBe('limit_reached');
    });

    it('should return "limit_reached" when over 100%', async () => {
      db.query.mockResolvedValue([{ total: 7.5 }]);

      const level = await tracker.getAlertLevel('2026-02-13');

      expect(level).toBe('limit_reached');
    });

    it('should return "none" when cost is zero', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      const level = await tracker.getAlertLevel('2026-02-13');

      expect(level).toBe('none');
    });

    it('should use current date when no date is provided', async () => {
      db.query.mockResolvedValue([{ total: 0 }]);

      await tracker.getAlertLevel();

      expect(db.query).toHaveBeenCalledWith(
        'meridian',
        expect.any(String),
        expect.arrayContaining([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getDailyCost
  // -------------------------------------------------------------------------

  describe('getDailyCost', () => {
    it('should return summary with breakdown', async () => {
      // First query: aggregated totals
      db.query.mockResolvedValueOnce([{
        total_cost_usd: 1.5,
        call_count: 10,
        total_input_tokens: 50000,
        total_output_tokens: 20000,
        total_cached_tokens: 5000,
      }]);

      // Second query: breakdown rows
      db.query.mockResolvedValueOnce([
        {
          date: '2026-02-13',
          component: 'scout',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250929',
          call_count: 7,
          total_input_tokens: 35000,
          total_output_tokens: 15000,
          total_cached_tokens: 3000,
          total_cost_usd: 1.2,
        },
        {
          date: '2026-02-13',
          component: 'sentinel',
          provider: 'openai',
          model: 'gpt-4o-mini',
          call_count: 3,
          total_input_tokens: 15000,
          total_output_tokens: 5000,
          total_cached_tokens: 2000,
          total_cost_usd: 0.3,
        },
      ]);

      const summary = await tracker.getDailyCost('2026-02-13');

      expect(summary.date).toBe('2026-02-13');
      expect(summary.totalCostUsd).toBe(1.5);
      expect(summary.callCount).toBe(10);
      expect(summary.totalInputTokens).toBe(50000);
      expect(summary.totalOutputTokens).toBe(20000);
      expect(summary.totalCachedTokens).toBe(5000);
      expect(summary.breakdown).toHaveLength(2);
      expect(summary.breakdown[0]).toEqual({
        component: 'scout',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        costUsd: 1.2,
        callCount: 7,
      });
      expect(summary.breakdown[1]).toEqual({
        component: 'sentinel',
        provider: 'openai',
        model: 'gpt-4o-mini',
        costUsd: 0.3,
        callCount: 3,
      });
    });

    it('should return zeros for dates with no data', async () => {
      // Both queries return empty / zero aggregates
      db.query.mockResolvedValueOnce([{
        total_cost_usd: 0,
        call_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cached_tokens: 0,
      }]);
      db.query.mockResolvedValueOnce([]);

      const summary = await tracker.getDailyCost('2026-01-01');

      expect(summary.date).toBe('2026-01-01');
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.callCount).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.totalCachedTokens).toBe(0);
      expect(summary.breakdown).toEqual([]);
    });

    it('should handle missing sum row gracefully', async () => {
      // Sum query returns empty array
      db.query.mockResolvedValueOnce([]);
      db.query.mockResolvedValueOnce([]);

      const summary = await tracker.getDailyCost('2026-01-01');

      expect(summary.totalCostUsd).toBe(0);
      expect(summary.callCount).toBe(0);
      expect(summary.breakdown).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getCostRange
  // -------------------------------------------------------------------------

  describe('getCostRange', () => {
    it('should return summaries for each date in the range', async () => {
      // First call: distinct dates query
      db.query.mockResolvedValueOnce([
        { date: '2026-02-10' },
        { date: '2026-02-11' },
      ]);

      // getDailyCost for 2026-02-10 — sum query
      db.query.mockResolvedValueOnce([{
        total_cost_usd: 1.0,
        call_count: 5,
        total_input_tokens: 10000,
        total_output_tokens: 5000,
        total_cached_tokens: 0,
      }]);
      // getDailyCost for 2026-02-10 — breakdown query
      db.query.mockResolvedValueOnce([{
        date: '2026-02-10',
        component: 'scout',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        call_count: 5,
        total_input_tokens: 10000,
        total_output_tokens: 5000,
        total_cached_tokens: 0,
        total_cost_usd: 1.0,
      }]);

      // getDailyCost for 2026-02-11 — sum query
      db.query.mockResolvedValueOnce([{
        total_cost_usd: 2.0,
        call_count: 8,
        total_input_tokens: 20000,
        total_output_tokens: 10000,
        total_cached_tokens: 1000,
      }]);
      // getDailyCost for 2026-02-11 — breakdown query
      db.query.mockResolvedValueOnce([{
        date: '2026-02-11',
        component: 'scout',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        call_count: 8,
        total_input_tokens: 20000,
        total_output_tokens: 10000,
        total_cached_tokens: 1000,
        total_cost_usd: 2.0,
      }]);

      const results = await tracker.getCostRange('2026-02-10', '2026-02-11');

      expect(results).toHaveLength(2);
      expect(results[0]!.date).toBe('2026-02-10');
      expect(results[0]!.totalCostUsd).toBe(1.0);
      expect(results[1]!.date).toBe('2026-02-11');
      expect(results[1]!.totalCostUsd).toBe(2.0);
    });

    it('should return an empty array when no dates exist in range', async () => {
      db.query.mockResolvedValueOnce([]);

      const results = await tracker.getCostRange('2025-01-01', '2025-01-31');

      expect(results).toEqual([]);
    });

    it('should pass correct start and end dates to the query', async () => {
      db.query.mockResolvedValueOnce([]);

      await tracker.getCostRange('2026-02-01', '2026-02-28');

      expect(db.query).toHaveBeenCalledWith(
        'meridian',
        expect.stringContaining('WHERE date >= ? AND date <= ?'),
        ['2026-02-01', '2026-02-28'],
      );
    });
  });

  // -------------------------------------------------------------------------
  // getJobCost
  // -------------------------------------------------------------------------

  describe('getJobCost', () => {
    it('should return job cost summary with call details', async () => {
      db.query.mockResolvedValueOnce([
        {
          id: 'call-1',
          job_id: 'job-abc',
          component: 'scout',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250929',
          input_tokens: 2000,
          output_tokens: 800,
          cached_tokens: 100,
          cost_usd: 0.018,
          duration_ms: 1200,
          created_at: '2026-02-13T10:00:00.000Z',
        },
        {
          id: 'call-2',
          job_id: 'job-abc',
          component: 'sentinel',
          provider: 'openai',
          model: 'gpt-4o',
          input_tokens: 1500,
          output_tokens: 300,
          cached_tokens: 0,
          cost_usd: 0.00675,
          duration_ms: 800,
          created_at: '2026-02-13T10:00:01.000Z',
        },
      ]);

      const summary = await tracker.getJobCost('job-abc');

      expect(summary.jobId).toBe('job-abc');
      expect(summary.callCount).toBe(2);
      expect(summary.totalCostUsd).toBeCloseTo(0.02475, 6);
      expect(summary.calls).toHaveLength(2);
      expect(summary.calls[0]).toEqual({
        id: 'call-1',
        component: 'scout',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 2000,
        outputTokens: 800,
        costUsd: 0.018,
        durationMs: 1200,
        createdAt: '2026-02-13T10:00:00.000Z',
      });
      expect(summary.calls[1]).toEqual({
        id: 'call-2',
        component: 'sentinel',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 1500,
        outputTokens: 300,
        costUsd: 0.00675,
        durationMs: 800,
        createdAt: '2026-02-13T10:00:01.000Z',
      });
    });

    it('should return zero for jobs with no calls', async () => {
      db.query.mockResolvedValueOnce([]);

      const summary = await tracker.getJobCost('job-nonexistent');

      expect(summary.jobId).toBe('job-nonexistent');
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.callCount).toBe(0);
      expect(summary.calls).toEqual([]);
    });

    it('should query with the correct job ID', async () => {
      db.query.mockResolvedValueOnce([]);

      await tracker.getJobCost('job-xyz');

      expect(db.query).toHaveBeenCalledWith(
        'meridian',
        expect.stringContaining('WHERE job_id = ?'),
        ['job-xyz'],
      );
    });
  });

  // -------------------------------------------------------------------------
  // getDailyLimit
  // -------------------------------------------------------------------------

  describe('getDailyLimit', () => {
    it('should return configured limit', () => {
      const limit = tracker.getDailyLimit();

      expect(limit).toBe(5.0);
    });

    it('should return default when not configured', () => {
      const defaultTracker = new CostTracker({
        db: db as unknown as ConstructorParameters<typeof CostTracker>[0]['db'],
      });

      // DEFAULT_DAILY_COST_LIMIT_USD = 5.0
      expect(defaultTracker.getDailyLimit()).toBe(5.0);
    });

    it('should return custom limit when explicitly set', () => {
      const customTracker = new CostTracker({
        db: db as unknown as ConstructorParameters<typeof CostTracker>[0]['db'],
        dailyLimitUsd: 10.0,
      });

      expect(customTracker.getDailyLimit()).toBe(10.0);
    });
  });

  // -------------------------------------------------------------------------
  // getDailyCostTotal
  // -------------------------------------------------------------------------

  describe('getDailyCostTotal', () => {
    it('should return the total cost for a given date', async () => {
      db.query.mockResolvedValueOnce([{ total: 3.14 }]);

      const total = await tracker.getDailyCostTotal('2026-02-13');

      expect(total).toBe(3.14);
      expect(db.query).toHaveBeenCalledWith(
        'meridian',
        expect.stringContaining('SUM(total_cost_usd)'),
        ['2026-02-13'],
      );
    });

    it('should return 0 when no rows exist', async () => {
      db.query.mockResolvedValueOnce([]);

      const total = await tracker.getDailyCostTotal('2026-01-01');

      expect(total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Constructor defaults
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('should use default logger (no-op) when none provided', async () => {
      const silentTracker = new CostTracker({
        db: db as unknown as ConstructorParameters<typeof CostTracker>[0]['db'],
        dailyLimitUsd: 1.0,
      });

      // Should not throw when recordCall triggers logging
      db.query.mockResolvedValue([{ total: 1.0 }]);
      const result = await silentTracker.recordCall(makeRecord());
      expect(result.alertLevel).toBe('limit_reached');
    });
  });
});
