// @meridian/shared — Cost tracking (Phase 9.5)
// Records LLM calls, calculates costs, tracks daily limits and alerts.

import type { DatabaseClient } from './database/index.js';
import { generateId } from './id.js';
import {
  COST_ALERT_WARN_PERCENT,
  COST_ALERT_CRITICAL_PERCENT,
  DEFAULT_DAILY_COST_LIMIT_USD,
} from './constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for the cost tracker.
 */
export interface CostTrackerLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Record of a single LLM API call.
 */
export interface LLMCallRecord {
  /** Optional job ID this call belongs to. */
  jobId?: string;
  /** Component that made the call ('scout' | 'sentinel'). */
  component: string;
  /** LLM provider (e.g., 'anthropic', 'openai'). */
  provider: string;
  /** Model identifier (e.g., 'claude-sonnet-4-5-20250929'). */
  model: string;
  /** Number of input tokens. */
  inputTokens: number;
  /** Number of output tokens. */
  outputTokens: number;
  /** Number of cached tokens (input). */
  cachedTokens?: number;
  /** Duration of the call in milliseconds. */
  durationMs?: number;
}

/**
 * Daily cost summary.
 */
export interface DailyCostSummary {
  date: string;
  totalCostUsd: number;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  breakdown: Array<{
    component: string;
    provider: string;
    model: string;
    costUsd: number;
    callCount: number;
  }>;
}

/**
 * Cost for a single job.
 */
export interface JobCostSummary {
  jobId: string;
  totalCostUsd: number;
  callCount: number;
  calls: Array<{
    id: string;
    component: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    createdAt: string;
  }>;
}

/**
 * Alert level for cost threshold notifications.
 */
export type CostAlertLevel = 'none' | 'warning' | 'critical' | 'limit_reached';

/**
 * Configuration for the CostTracker.
 */
export interface CostTrackerConfig {
  /** Database client. */
  db: DatabaseClient;
  /** Daily cost limit in USD. */
  dailyLimitUsd?: number;
  /** Optional logger. */
  logger?: CostTrackerLogger;
}

// ---------------------------------------------------------------------------
// Default model pricing (per 1M tokens, USD)
// ---------------------------------------------------------------------------

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
}

/**
 * Default pricing data for common models.
 * Updated as of early 2026. Can be overridden via config.
 */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude
  'claude-opus-4-6': { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  'claude-sonnet-4-5-20250929': { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.8, outputPer1M: 4.0, cachedInputPer1M: 0.08 },
  // OpenAI
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4-turbo': { inputPer1M: 10.0, outputPer1M: 30.0 },
  // Fallback
  'default': { inputPer1M: 3.0, outputPer1M: 15.0 },
};

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface LLMCallRow {
  id: string;
  job_id: string | null;
  component: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  duration_ms: number;
  created_at: string;
}

interface CostDailyRow {
  date: string;
  component: string;
  provider: string;
  model: string;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_cost_usd: number;
}

interface DailySumRow {
  total_cost_usd: number;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

/**
 * Tracks LLM API call costs and enforces daily spending limits.
 *
 * Records each LLM call with token counts and computed costs,
 * maintains daily aggregates, and provides alert levels
 * at 80% (warning), 95% (critical), and 100% (hard stop).
 */
export class CostTracker {
  private readonly db: DatabaseClient;
  private readonly dailyLimitUsd: number;
  private readonly logger: CostTrackerLogger;

  constructor(config: CostTrackerConfig) {
    this.db = config.db;
    this.dailyLimitUsd = config.dailyLimitUsd ?? DEFAULT_DAILY_COST_LIMIT_USD;
    this.logger = config.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  /**
   * Calculate the cost of an LLM call in USD.
   */
  calculateCost(record: LLMCallRecord): number {
    const pricing = DEFAULT_PRICING[record.model] ?? DEFAULT_PRICING['default']!;

    const inputCost = (record.inputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (record.outputTokens / 1_000_000) * pricing.outputPer1M;
    const cachedCost = pricing.cachedInputPer1M
      ? ((record.cachedTokens ?? 0) / 1_000_000) * pricing.cachedInputPer1M
      : 0;

    return inputCost + outputCost + cachedCost;
  }

  /**
   * Record an LLM API call.
   *
   * Inserts into `llm_calls` and updates `cost_daily` aggregate.
   * Returns the computed cost and current alert level.
   */
  async recordCall(record: LLMCallRecord): Promise<{
    costUsd: number;
    alertLevel: CostAlertLevel;
  }> {
    const costUsd = this.calculateCost(record);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Insert individual call record
    await this.db.run(
      'meridian',
      `INSERT INTO llm_calls (id, job_id, component, provider, model,
        input_tokens, output_tokens, cached_tokens, cost_usd, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        record.jobId ?? null,
        record.component,
        record.provider,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cachedTokens ?? 0,
        costUsd,
        record.durationMs ?? 0,
        now.toISOString(),
      ],
    );

    // Upsert daily aggregate
    await this.db.run(
      'meridian',
      `INSERT INTO cost_daily (date, component, provider, model,
        call_count, total_input_tokens, total_output_tokens, total_cached_tokens, total_cost_usd)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(date, component, provider, model) DO UPDATE SET
        call_count = call_count + 1,
        total_input_tokens = total_input_tokens + excluded.total_input_tokens,
        total_output_tokens = total_output_tokens + excluded.total_output_tokens,
        total_cached_tokens = total_cached_tokens + excluded.total_cached_tokens,
        total_cost_usd = total_cost_usd + excluded.total_cost_usd`,
      [
        dateStr,
        record.component,
        record.provider,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cachedTokens ?? 0,
        costUsd,
      ],
    );

    // Check alert level
    const alertLevel = await this.getAlertLevel(dateStr);

    if (alertLevel === 'limit_reached') {
      this.logger.error('Daily cost limit reached', {
        date: dateStr,
        limitUsd: this.dailyLimitUsd,
      });
    } else if (alertLevel === 'critical') {
      this.logger.warn('Daily cost at critical threshold', {
        date: dateStr,
        threshold: COST_ALERT_CRITICAL_PERCENT,
      });
    } else if (alertLevel === 'warning') {
      this.logger.warn('Daily cost at warning threshold', {
        date: dateStr,
        threshold: COST_ALERT_WARN_PERCENT,
      });
    }

    return { costUsd, alertLevel };
  }

  /**
   * Check if the daily cost limit has been reached.
   */
  async isLimitReached(date?: string): Promise<boolean> {
    const dateStr = date ?? new Date().toISOString().slice(0, 10);
    const level = await this.getAlertLevel(dateStr);
    return level === 'limit_reached';
  }

  /**
   * Get the current alert level for a given day.
   */
  async getAlertLevel(date?: string): Promise<CostAlertLevel> {
    const dateStr = date ?? new Date().toISOString().slice(0, 10);
    const dailyCost = await this.getDailyCostTotal(dateStr);
    const percent = (dailyCost / this.dailyLimitUsd) * 100;

    if (percent >= 100) return 'limit_reached';
    if (percent >= COST_ALERT_CRITICAL_PERCENT) return 'critical';
    if (percent >= COST_ALERT_WARN_PERCENT) return 'warning';
    return 'none';
  }

  /**
   * Get the total cost for a specific day.
   */
  async getDailyCostTotal(date: string): Promise<number> {
    const rows = await this.db.query<{ total: number }>(
      'meridian',
      `SELECT COALESCE(SUM(total_cost_usd), 0) as total
       FROM cost_daily WHERE date = ?`,
      [date],
    );
    return rows[0]?.total ?? 0;
  }

  /**
   * Get daily cost summary with breakdown by component/provider/model.
   */
  async getDailyCost(date: string): Promise<DailyCostSummary> {
    // Get aggregated totals
    const sumRows = await this.db.query<DailySumRow>(
      'meridian',
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(call_count), 0) as call_count,
        COALESCE(SUM(total_input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(total_output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(total_cached_tokens), 0) as total_cached_tokens
       FROM cost_daily WHERE date = ?`,
      [date],
    );

    // Get breakdown
    const breakdownRows = await this.db.query<CostDailyRow>(
      'meridian',
      `SELECT * FROM cost_daily WHERE date = ? ORDER BY total_cost_usd DESC`,
      [date],
    );

    const sum = sumRows[0];

    return {
      date,
      totalCostUsd: sum?.total_cost_usd ?? 0,
      callCount: sum?.call_count ?? 0,
      totalInputTokens: sum?.total_input_tokens ?? 0,
      totalOutputTokens: sum?.total_output_tokens ?? 0,
      totalCachedTokens: sum?.total_cached_tokens ?? 0,
      breakdown: breakdownRows.map((r) => ({
        component: r.component,
        provider: r.provider,
        model: r.model,
        costUsd: r.total_cost_usd,
        callCount: r.call_count,
      })),
    };
  }

  /**
   * Get cost summaries for a date range.
   */
  async getCostRange(startDate: string, endDate: string): Promise<DailyCostSummary[]> {
    // Get unique dates in range
    const dateRows = await this.db.query<{ date: string }>(
      'meridian',
      `SELECT DISTINCT date FROM cost_daily
       WHERE date >= ? AND date <= ?
       ORDER BY date ASC`,
      [startDate, endDate],
    );

    const results: DailyCostSummary[] = [];
    for (const row of dateRows) {
      results.push(await this.getDailyCost(row.date));
    }

    return results;
  }

  /**
   * Get cost summary for a specific job.
   */
  async getJobCost(jobId: string): Promise<JobCostSummary> {
    const rows = await this.db.query<LLMCallRow>(
      'meridian',
      `SELECT * FROM llm_calls WHERE job_id = ? ORDER BY created_at ASC`,
      [jobId],
    );

    const totalCostUsd = rows.reduce((sum, r) => sum + r.cost_usd, 0);

    return {
      jobId,
      totalCostUsd,
      callCount: rows.length,
      calls: rows.map((r) => ({
        id: r.id,
        component: r.component,
        provider: r.provider,
        model: r.model,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUsd: r.cost_usd,
        durationMs: r.duration_ms,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * Get the configured daily cost limit.
   */
  getDailyLimit(): number {
    return this.dailyLimitUsd;
  }
}
