// @meridian/axis — Metrics collector (Section 12.2)
//
// Collects and exposes internal metrics in Prometheus exposition format.
// Metrics are opt-in via configuration. All values are computed on-demand
// from database queries and runtime state — no in-process counters that
// could drift from the source of truth.

import os from 'node:os';

import type { DatabaseClient } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsCollectorOptions {
  db: DatabaseClient;
}

interface CountRow {
  count: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

interface GearCountRow {
  gear_id: string;
  status: string;
  count: number;
}

interface JobDurationRow {
  duration_seconds: number;
}

// ---------------------------------------------------------------------------
// Prometheus formatting helpers
//
// Per the Prometheus exposition format spec, each metric family has exactly
// one # HELP and one # TYPE line, followed by all samples (label variants).
// ---------------------------------------------------------------------------

interface Sample {
  labels: Record<string, string>;
  value: number;
}

/**
 * Format a counter metric family with one or more label-differentiated samples.
 * Outputs a single HELP/TYPE header followed by all sample lines.
 */
function formatCounterFamily(name: string, help: string, samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
  for (const s of samples) {
    const labelStr = Object.entries(s.labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    const suffix = labelStr ? `{${labelStr}}` : '';
    lines.push(`${name}${suffix} ${s.value}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Format a gauge metric family with one or more label-differentiated samples.
 * Outputs a single HELP/TYPE header followed by all sample lines.
 */
function formatGaugeFamily(name: string, help: string, samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const s of samples) {
    const labelStr = Object.entries(s.labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    const suffix = labelStr ? `{${labelStr}}` : '';
    lines.push(`${name}${suffix} ${s.value}`);
  }
  return lines.join('\n') + '\n';
}

function formatHistogramFromValues(
  name: string,
  help: string,
  values: number[],
  buckets: number[],
): string {
  if (values.length === 0) {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
    for (const b of buckets) {
      lines.push(`${name}_bucket{le="${b}"} 0`);
    }
    lines.push(`${name}_bucket{le="+Inf"} 0`);
    lines.push(`${name}_sum 0`);
    lines.push(`${name}_count 0`);
    return lines.join('\n') + '\n';
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const count = sorted.length;

  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];

  for (const b of buckets) {
    const bucketCount = sorted.filter((v) => v <= b).length;
    lines.push(`${name}_bucket{le="${b}"} ${bucketCount}`);
  }
  lines.push(`${name}_bucket{le="+Inf"} ${count}`);
  lines.push(`${name}_sum ${sum}`);
  lines.push(`${name}_count ${count}`);

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

/**
 * Collects metrics from the database and runtime state.
 * All metrics are computed on-demand (no stale in-memory counters).
 */
export class MetricsCollector {
  private readonly db: DatabaseClient;

  constructor(options: MetricsCollectorOptions) {
    this.db = options.db;
  }

  /**
   * Collect all metrics and return them in Prometheus exposition format.
   */
  async collect(): Promise<string> {
    const sections: string[] = [];

    // --- Job counters (grouped as one metric family) ---
    const jobCounts = await this.getJobCountsByStatus();
    const jobSamples: Sample[] = Object.entries(jobCounts).map(([status, count]) => ({
      labels: { status },
      value: count,
    }));
    if (jobSamples.length > 0) {
      sections.push(formatCounterFamily('meridian_jobs_total', 'Total jobs by status', jobSamples));
    }

    // --- Job duration histogram ---
    const jobDurations = await this.getCompletedJobDurations();
    sections.push(formatHistogramFromValues(
      'meridian_jobs_duration_seconds',
      'Job duration in seconds',
      jobDurations,
      [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    ));

    // --- LLM call counter (architecture: {provider,model} labels) ---
    // Currently counts jobs with plan_json as a proxy. Once Scout/Sentinel
    // are wired, this will be populated per provider/model from an llm_calls table.
    const llmCalls = await this.getLlmCallCount();
    sections.push(formatCounterFamily(
      'meridian_llm_calls_total',
      'Total LLM API calls by provider and model',
      [{ labels: { provider: 'all', model: 'all' }, value: llmCalls }],
    ));

    // --- LLM tokens counter (placeholder — populated when Scout/Sentinel wired) ---
    sections.push(formatCounterFamily(
      'meridian_llm_tokens_total',
      'Total LLM tokens by provider, model, and type',
      [{ labels: { provider: 'none', model: 'none', type: 'input' }, value: 0 }],
    ));

    // --- LLM latency histogram (placeholder — populated when Scout/Sentinel wired) ---
    sections.push(formatHistogramFromValues(
      'meridian_llm_latency_seconds',
      'LLM call latency in seconds',
      [],
      [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    ));

    // --- Gear execution counters (grouped as one metric family) ---
    const gearCounts = await this.getGearExecutionCounts();
    const gearSamples: Sample[] = gearCounts.map(({ gearId, status, count }) => ({
      labels: { gear: gearId, status },
      value: count,
    }));
    if (gearSamples.length > 0) {
      sections.push(formatCounterFamily(
        'meridian_gear_executions_total',
        'Gear execution count by gear and status',
        gearSamples,
      ));
    }

    // --- Sentinel verdict counters (grouped as one metric family) ---
    const verdictCounts = await this.getSentinelVerdictCounts();
    const verdictSamples: Sample[] = Object.entries(verdictCounts).map(([verdict, count]) => ({
      labels: { verdict },
      value: count,
    }));
    if (verdictSamples.length > 0) {
      sections.push(formatCounterFamily(
        'meridian_sentinel_verdicts_total',
        'Sentinel verdict count',
        verdictSamples,
      ));
    }

    // --- System gauges ---
    const memUsage = process.memoryUsage();
    sections.push(formatGaugeFamily(
      'meridian_system_memory_bytes',
      'Process RSS memory usage in bytes',
      [{ labels: {}, value: memUsage.rss }],
    ));

    sections.push(formatGaugeFamily(
      'meridian_system_memory_total_bytes',
      'Total system memory in bytes',
      [{ labels: {}, value: os.totalmem() }],
    ));

    sections.push(formatGaugeFamily(
      'meridian_system_memory_free_bytes',
      'Free system memory in bytes',
      [{ labels: {}, value: os.freemem() }],
    ));

    // --- Memory count gauge (grouped as one metric family) ---
    const memoryCounts = await this.getMemoryCounts();
    const memorySamples: Sample[] = Object.entries(memoryCounts).map(([type, count]) => ({
      labels: { type },
      value: count,
    }));
    if (memorySamples.length > 0) {
      sections.push(formatGaugeFamily(
        'meridian_memory_count',
        'Memory entry count by type',
        memorySamples,
      ));
    }

    return sections.join('\n');
  }

  // -------------------------------------------------------------------------
  // Data collection methods
  // -------------------------------------------------------------------------

  private async getJobCountsByStatus(): Promise<Record<string, number>> {
    const rows = await this.db.query<StatusCountRow>(
      'meridian',
      'SELECT status, COUNT(*) as count FROM jobs GROUP BY status',
    );

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  private async getCompletedJobDurations(): Promise<number[]> {
    const rows = await this.db.query<JobDurationRow>(
      'meridian',
      `SELECT (julianday(completed_at) - julianday(created_at)) * 86400 as duration_seconds
       FROM jobs
       WHERE status = 'completed' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC
       LIMIT 1000`,
    );

    return rows
      .map((r) => r.duration_seconds)
      .filter((d) => d >= 0);
  }

  private async getGearExecutionCounts(): Promise<Array<{ gearId: string; status: string; count: number }>> {
    try {
      const rows = await this.db.query<GearCountRow>(
        'meridian',
        'SELECT gear_id, status, COUNT(*) as count FROM execution_log GROUP BY gear_id, status',
      );

      return rows.map((r) => ({
        gearId: r.gear_id,
        status: r.status,
        count: r.count,
      }));
    } catch {
      // execution_log table may not exist yet
      return [];
    }
  }

  private async getSentinelVerdictCounts(): Promise<Record<string, number>> {
    try {
      const rows = await this.db.query<StatusCountRow>(
        'meridian',
        `SELECT
           CASE
             WHEN validation_json LIKE '%"verdict":"approved"%' THEN 'approved'
             WHEN validation_json LIKE '%"verdict":"needs_revision"%' THEN 'needs_revision'
             WHEN validation_json LIKE '%"verdict":"needs_user_approval"%' THEN 'needs_user_approval'
             WHEN validation_json LIKE '%"verdict":"rejected"%' THEN 'rejected'
             ELSE 'unknown'
           END as status,
           COUNT(*) as count
         FROM jobs
         WHERE validation_json IS NOT NULL
         GROUP BY status`,
      );

      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.status] = row.count;
      }
      return counts;
    } catch {
      return {};
    }
  }

  private async getLlmCallCount(): Promise<number> {
    try {
      const rows = await this.db.query<CountRow>(
        'meridian',
        `SELECT COUNT(*) as count FROM jobs WHERE plan_json IS NOT NULL`,
      );
      return rows[0]?.count ?? 0;
    } catch {
      return 0;
    }
  }

  private async getMemoryCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    try {
      const episodeRows = await this.db.query<CountRow>(
        'journal',
        'SELECT COUNT(*) as count FROM episodes',
      );
      counts['episodic'] = episodeRows[0]?.count ?? 0;

      const factRows = await this.db.query<CountRow>(
        'journal',
        'SELECT COUNT(*) as count FROM facts',
      );
      counts['semantic'] = factRows[0]?.count ?? 0;

      const procedureRows = await this.db.query<CountRow>(
        'journal',
        'SELECT COUNT(*) as count FROM procedures',
      );
      counts['procedural'] = procedureRows[0]?.count ?? 0;
    } catch {
      // journal.db may not be initialized yet
    }
    return counts;
  }
}
