import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DatabaseClient } from '@meridian/shared';

import { MetricsCollector } from './metrics.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let db: DatabaseClient;
let collector: MetricsCollector;

const PROJECT_ROOT = process.cwd();

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  db = new DatabaseClient({ dataDir: testDir, direct: true });
  await db.start();
  await db.open('meridian');

  // Run migrations to create the jobs table
  const { migrate } = await import('@meridian/shared');
  await migrate(db, 'meridian', PROJECT_ROOT);

  collector = new MetricsCollector({ db });
});

afterEach(async () => {
  await db.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertJob(status: string): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const completedAt = ['completed', 'failed', 'cancelled'].includes(status)
    ? now
    : null;
  await db.run(
    'meridian',
    `INSERT INTO jobs (id, status, priority, source_type, created_at, updated_at, completed_at)
     VALUES (?, ?, 'normal', 'user', ?, ?, ?)`,
    [id, status, now, now, completedAt],
  );
}

/** Count occurrences of a line in the output (for HELP/TYPE dedup checks). */
function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetricsCollector', () => {
  describe('collect', () => {
    it('should return valid Prometheus exposition format', async () => {
      const output = await collector.collect();

      expect(typeof output).toBe('string');
      // Should contain at least system memory gauge
      expect(output).toContain('meridian_system_memory_bytes');
      expect(output).toContain('# HELP');
      expect(output).toContain('# TYPE');
    });

    it('should include job counters by status with single HELP/TYPE header', async () => {
      await insertJob('completed');
      await insertJob('completed');
      await insertJob('failed');
      await insertJob('pending');

      const output = await collector.collect();

      expect(output).toContain('meridian_jobs_total{status="completed"} 2');
      expect(output).toContain('meridian_jobs_total{status="failed"} 1');
      expect(output).toContain('meridian_jobs_total{status="pending"} 1');

      // Prometheus spec: only one HELP and TYPE per metric family
      expect(countOccurrences(output, '# HELP meridian_jobs_total')).toBe(1);
      expect(countOccurrences(output, '# TYPE meridian_jobs_total')).toBe(1);
    });

    it('should include job duration histogram', async () => {
      await insertJob('completed');

      const output = await collector.collect();

      expect(output).toContain('meridian_jobs_duration_seconds');
      expect(output).toContain('# TYPE meridian_jobs_duration_seconds histogram');
      expect(output).toContain('meridian_jobs_duration_seconds_count');
      expect(output).toContain('meridian_jobs_duration_seconds_sum');
      expect(output).toContain('meridian_jobs_duration_seconds_bucket');
    });

    it('should include system memory gauge', async () => {
      const output = await collector.collect();

      expect(output).toContain('# TYPE meridian_system_memory_bytes gauge');
      // Value should be a positive number
      const match = output.match(/meridian_system_memory_bytes (\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThan(0);
    });

    it('should include LLM call counter with provider/model labels', async () => {
      const output = await collector.collect();

      expect(output).toContain('# HELP meridian_llm_calls_total');
      expect(output).toContain('meridian_llm_calls_total{provider="all",model="all"}');
    });

    it('should include sentinel verdict counters when validation data exists', async () => {
      // Insert a job with validation_json
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.run(
        'meridian',
        `INSERT INTO jobs (id, status, priority, source_type, created_at, updated_at, validation_json)
         VALUES (?, 'completed', 'normal', 'user', ?, ?, ?)`,
        [id, now, now, JSON.stringify({ verdict: 'approved', stepResults: [] })],
      );

      const output = await collector.collect();

      expect(output).toContain('meridian_sentinel_verdicts_total');
      // Only one HELP/TYPE even with multiple verdicts
      expect(countOccurrences(output, '# HELP meridian_sentinel_verdicts_total')).toBe(1);
    });

    it('should handle empty database gracefully', async () => {
      const output = await collector.collect();

      // Should not throw and should still have system gauges
      expect(output).toContain('meridian_system_memory_bytes');
      // Job histogram should show zero count
      expect(output).toContain('meridian_jobs_duration_seconds_count 0');
    });

    it('should format counters with labels correctly', async () => {
      await insertJob('completed');

      const output = await collector.collect();

      // Prometheus label format: metric_name{label="value"} number
      expect(output).toMatch(/meridian_jobs_total\{status="completed"\} \d+/);
    });

    it('should include LLM token placeholder counter', async () => {
      const output = await collector.collect();

      expect(output).toContain('# HELP meridian_llm_tokens_total');
      expect(output).toContain('# TYPE meridian_llm_tokens_total counter');
      expect(output).toContain('meridian_llm_tokens_total{provider="none",model="none",type="input"} 0');
    });

    it('should include LLM latency placeholder histogram', async () => {
      const output = await collector.collect();

      expect(output).toContain('# HELP meridian_llm_latency_seconds');
      expect(output).toContain('# TYPE meridian_llm_latency_seconds histogram');
      expect(output).toContain('meridian_llm_latency_seconds_count 0');
      expect(output).toContain('meridian_llm_latency_seconds_sum 0');
    });
  });
});
