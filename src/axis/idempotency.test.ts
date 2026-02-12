import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DatabaseClient, migrate } from '@meridian/shared';

import {
  computeExecutionId,
  checkIdempotency,
  recordCompletion,
  recordFailure,
  getExecutionLog,
  getExecutionEntry,
} from './idempotency.js';
import { JobQueue } from './job-queue.js';

// ---------------------------------------------------------------------------
// Test setup — temp file SQLite via direct mode
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test');
let dbPath: string;
let db: DatabaseClient;
let queue: JobQueue;

beforeEach(async () => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  dbPath = join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new DatabaseClient({ dataDir: TEST_DIR, direct: true });
  await db.start();
  await db.open('meridian', dbPath);
  await migrate(db, 'meridian', process.cwd());
  queue = new JobQueue(db);
});

afterEach(async () => {
  await db.close();
  try {
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
    if (existsSync(dbPath + '-wal')) {
      unlinkSync(dbPath + '-wal');
    }
    if (existsSync(dbPath + '-shm')) {
      unlinkSync(dbPath + '-shm');
    }
  } catch {
    // Ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestJob(): Promise<string> {
  const job = await queue.createJob({ source: 'user' });
  return job.id;
}

// ---------------------------------------------------------------------------
// Execution ID computation
// ---------------------------------------------------------------------------

describe('computeExecutionId', () => {
  it('should produce a 64-character hex SHA-256 hash', () => {
    const id = computeExecutionId('job-1', 'step-1');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce identical IDs for the same job + step', () => {
    const id1 = computeExecutionId('job-1', 'step-1');
    const id2 = computeExecutionId('job-1', 'step-1');
    expect(id1).toBe(id2);
  });

  it('should produce different IDs for different steps', () => {
    const id1 = computeExecutionId('job-1', 'step-1');
    const id2 = computeExecutionId('job-1', 'step-2');
    expect(id1).not.toBe(id2);
  });

  it('should produce different IDs for different jobs', () => {
    const id1 = computeExecutionId('job-1', 'step-1');
    const id2 = computeExecutionId('job-2', 'step-1');
    expect(id1).not.toBe(id2);
  });

  it('should be stable across invocations', () => {
    const ids = Array.from({ length: 10 }, () =>
      computeExecutionId('job-abc', 'step-xyz'),
    );
    expect(new Set(ids).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency check — new execution path
// ---------------------------------------------------------------------------

describe('checkIdempotency — new execution', () => {
  it('should return execute outcome for a never-seen step', async () => {
    const jobId = await createTestJob();
    const result = await checkIdempotency(db, jobId, 'step-1');

    expect(result.outcome).toBe('execute');
    expect(result.executionId).toBeDefined();
  });

  it('should insert a started entry in the execution log', async () => {
    const jobId = await createTestJob();
    const result = await checkIdempotency(db, jobId, 'step-1');

    const entry = await getExecutionEntry(db, result.executionId);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('started');
    expect(entry?.jobId).toBe(jobId);
    expect(entry?.stepId).toBe('step-1');
    expect(entry?.startedAt).toBeDefined();
  });

  it('should use the computed execution ID', async () => {
    const jobId = await createTestJob();
    const expectedId = computeExecutionId(jobId, 'step-1');

    const result = await checkIdempotency(db, jobId, 'step-1');
    expect(result.executionId).toBe(expectedId);
  });
});

// ---------------------------------------------------------------------------
// Idempotency check — cached result path
// ---------------------------------------------------------------------------

describe('checkIdempotency — cached result', () => {
  it('should return cached outcome for a completed execution', async () => {
    const jobId = await createTestJob();

    // First: start and complete
    const first = await checkIdempotency(db, jobId, 'step-1');
    expect(first.outcome).toBe('execute');
    await recordCompletion(db, first.executionId, { output: 'success' });

    // Second: should return cached result
    const second = await checkIdempotency(db, jobId, 'step-1');
    expect(second.outcome).toBe('cached');
    if (second.outcome === 'cached') {
      expect(second.result).toEqual({ output: 'success' });
    }
  });

  it('should preserve the same execution ID across cache hits', async () => {
    const jobId = await createTestJob();
    const expectedId = computeExecutionId(jobId, 'step-1');

    const first = await checkIdempotency(db, jobId, 'step-1');
    await recordCompletion(db, first.executionId, { ok: true });

    const second = await checkIdempotency(db, jobId, 'step-1');
    expect(second.executionId).toBe(expectedId);
  });

  it('should preserve complex result objects in cache', async () => {
    const jobId = await createTestJob();

    const first = await checkIdempotency(db, jobId, 'step-1');
    const complexResult = {
      output: 'email sent',
      recipients: ['alice@example.com', 'bob@example.com'],
      metadata: { messageId: 'msg-123', timestamp: 1700000000 },
    };
    await recordCompletion(db, first.executionId, complexResult);

    const second = await checkIdempotency(db, jobId, 'step-1');
    expect(second.outcome).toBe('cached');
    if (second.outcome === 'cached') {
      expect(second.result).toEqual(complexResult);
    }
  });

  it('should return empty object when completed without result', async () => {
    const jobId = await createTestJob();

    // Manually insert a completed entry with no result_json
    const execId = computeExecutionId(jobId, 'step-1');
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO execution_log (execution_id, job_id, step_id, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', ?, ?)`,
      [execId, jobId, 'step-1', now, now],
    );

    const result = await checkIdempotency(db, jobId, 'step-1');
    expect(result.outcome).toBe('cached');
    if (result.outcome === 'cached') {
      expect(result.result).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency check — crash recovery path (stale 'started' entries)
// ---------------------------------------------------------------------------

describe('checkIdempotency — crash recovery', () => {
  it('should reset a stale started entry and return execute', async () => {
    const jobId = await createTestJob();

    // Simulate a crashed first attempt: insert a started entry directly
    const execId = computeExecutionId(jobId, 'step-1');
    await db.run(
      'meridian',
      `INSERT INTO execution_log (execution_id, job_id, step_id, status, started_at)
       VALUES (?, ?, ?, 'started', ?)`,
      [execId, jobId, 'step-1', '2026-01-01T00:00:00.000Z'],
    );

    // Check idempotency — should detect stale and reset
    const result = await checkIdempotency(db, jobId, 'step-1');
    expect(result.outcome).toBe('execute');
    expect(result.executionId).toBe(execId); // same execution ID

    // The entry should be reset to 'started' with a fresh timestamp
    const entry = await getExecutionEntry(db, execId);
    expect(entry?.status).toBe('started');
    expect(entry?.startedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(entry?.completedAt).toBeUndefined();
  });

  it('should use the same execution ID for the retry', async () => {
    const jobId = await createTestJob();

    const execId = computeExecutionId(jobId, 'step-1');
    await db.run(
      'meridian',
      `INSERT INTO execution_log (execution_id, job_id, step_id, status, started_at)
       VALUES (?, ?, ?, 'started', ?)`,
      [execId, jobId, 'step-1', '2026-01-01T00:00:00.000Z'],
    );

    const result = await checkIdempotency(db, jobId, 'step-1');
    expect(result.executionId).toBe(execId);
  });

  it('should allow the retry to complete and then cache', async () => {
    const jobId = await createTestJob();

    // Simulate crashed attempt
    const execId = computeExecutionId(jobId, 'step-1');
    await db.run(
      'meridian',
      `INSERT INTO execution_log (execution_id, job_id, step_id, status, started_at)
       VALUES (?, ?, ?, 'started', ?)`,
      [execId, jobId, 'step-1', '2026-01-01T00:00:00.000Z'],
    );

    // Recover
    const recover = await checkIdempotency(db, jobId, 'step-1');
    expect(recover.outcome).toBe('execute');

    // Complete the retry
    await recordCompletion(db, recover.executionId, { recovered: true });

    // Subsequent check should hit cache
    const cached = await checkIdempotency(db, jobId, 'step-1');
    expect(cached.outcome).toBe('cached');
    if (cached.outcome === 'cached') {
      expect(cached.result).toEqual({ recovered: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency check — failed execution retry
// ---------------------------------------------------------------------------

describe('checkIdempotency — after failure', () => {
  it('should allow re-execution after a recorded failure', async () => {
    const jobId = await createTestJob();

    // First attempt: start
    const first = await checkIdempotency(db, jobId, 'step-1');
    expect(first.outcome).toBe('execute');

    // Mark as failed
    await recordFailure(db, first.executionId);

    // Check again — should reset and allow re-execution
    const second = await checkIdempotency(db, jobId, 'step-1');
    expect(second.outcome).toBe('execute');
    expect(second.executionId).toBe(first.executionId);

    // The entry should be reset to 'started'
    const entry = await getExecutionEntry(db, second.executionId);
    expect(entry?.status).toBe('started');
    expect(entry?.result).toBeUndefined();
    expect(entry?.completedAt).toBeUndefined();
  });

  it('should cache after a successful retry following failure', async () => {
    const jobId = await createTestJob();

    // First attempt: fail
    const first = await checkIdempotency(db, jobId, 'step-1');
    await recordFailure(db, first.executionId);

    // Second attempt: retry and succeed
    const second = await checkIdempotency(db, jobId, 'step-1');
    await recordCompletion(db, second.executionId, { retried: true });

    // Third check: should hit cache
    const third = await checkIdempotency(db, jobId, 'step-1');
    expect(third.outcome).toBe('cached');
    if (third.outcome === 'cached') {
      expect(third.result).toEqual({ retried: true });
    }
  });
});

// ---------------------------------------------------------------------------
// recordCompletion
// ---------------------------------------------------------------------------

describe('recordCompletion', () => {
  it('should mark a started entry as completed', async () => {
    const jobId = await createTestJob();
    const result = await checkIdempotency(db, jobId, 'step-1');

    await recordCompletion(db, result.executionId, { output: 'done' });

    const entry = await getExecutionEntry(db, result.executionId);
    expect(entry?.status).toBe('completed');
    expect(entry?.result).toEqual({ output: 'done' });
    expect(entry?.completedAt).toBeDefined();
  });

  it('should store empty result object', async () => {
    const jobId = await createTestJob();
    const result = await checkIdempotency(db, jobId, 'step-1');

    await recordCompletion(db, result.executionId, {});

    const entry = await getExecutionEntry(db, result.executionId);
    expect(entry?.status).toBe('completed');
    expect(entry?.result).toEqual({});
  });

  it('should set completedAt timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

    const jobId = await createTestJob();
    const result = await checkIdempotency(db, jobId, 'step-1');

    vi.advanceTimersByTime(5000);
    await recordCompletion(db, result.executionId, { output: 'done' });

    const entry = await getExecutionEntry(db, result.executionId);
    expect(entry?.completedAt).toBe('2026-03-01T12:00:05.000Z');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// recordFailure
// ---------------------------------------------------------------------------

describe('recordFailure', () => {
  it('should mark a started entry as failed', async () => {
    const jobId = await createTestJob();
    const result = await checkIdempotency(db, jobId, 'step-1');

    await recordFailure(db, result.executionId);

    const entry = await getExecutionEntry(db, result.executionId);
    expect(entry?.status).toBe('failed');
    expect(entry?.completedAt).toBeDefined();
  });

  it('should not store a result for failed entries', async () => {
    const jobId = await createTestJob();
    const result = await checkIdempotency(db, jobId, 'step-1');

    await recordFailure(db, result.executionId);

    const entry = await getExecutionEntry(db, result.executionId);
    expect(entry?.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getExecutionLog
// ---------------------------------------------------------------------------

describe('getExecutionLog', () => {
  it('should return empty array for a job with no executions', async () => {
    const jobId = await createTestJob();
    const log = await getExecutionLog(db, jobId);
    expect(log).toEqual([]);
  });

  it('should return all entries for a job', async () => {
    const jobId = await createTestJob();

    await checkIdempotency(db, jobId, 'step-1');
    await checkIdempotency(db, jobId, 'step-2');

    const log = await getExecutionLog(db, jobId);
    expect(log).toHaveLength(2);
  });

  it('should return entries ordered by started_at', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

    const jobId = await createTestJob();

    await checkIdempotency(db, jobId, 'step-1');

    vi.advanceTimersByTime(1000);
    await checkIdempotency(db, jobId, 'step-2');

    const log = await getExecutionLog(db, jobId);
    expect(log[0]?.stepId).toBe('step-1');
    expect(log[1]?.stepId).toBe('step-2');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted via stepId checks above
    expect(log[0]!.startedAt < log[1]!.startedAt).toBe(true);

    vi.useRealTimers();
  });

  it('should not include entries from other jobs', async () => {
    const jobId1 = await createTestJob();
    const jobId2 = await createTestJob();

    await checkIdempotency(db, jobId1, 'step-1');
    await checkIdempotency(db, jobId2, 'step-1');

    const log1 = await getExecutionLog(db, jobId1);
    expect(log1).toHaveLength(1);
    expect(log1[0]?.jobId).toBe(jobId1);
  });
});

// ---------------------------------------------------------------------------
// getExecutionEntry
// ---------------------------------------------------------------------------

describe('getExecutionEntry', () => {
  it('should return undefined for non-existent entry', async () => {
    const entry = await getExecutionEntry(db, 'nonexistent');
    expect(entry).toBeUndefined();
  });

  it('should return the full entry', async () => {
    const jobId = await createTestJob();
    const result = await checkIdempotency(db, jobId, 'step-1');

    const entry = await getExecutionEntry(db, result.executionId);
    expect(entry).toBeDefined();
    expect(entry?.executionId).toBe(result.executionId);
    expect(entry?.jobId).toBe(jobId);
    expect(entry?.stepId).toBe('step-1');
    expect(entry?.status).toBe('started');
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle integration
// ---------------------------------------------------------------------------

describe('idempotency lifecycle', () => {
  it('should support: check → execute → complete → cache hit', async () => {
    const jobId = await createTestJob();

    // Check → execute
    const check1 = await checkIdempotency(db, jobId, 'step-1');
    expect(check1.outcome).toBe('execute');

    // Complete
    await recordCompletion(db, check1.executionId, { sent: true });

    // Re-check → cache hit
    const check2 = await checkIdempotency(db, jobId, 'step-1');
    expect(check2.outcome).toBe('cached');
    if (check2.outcome === 'cached') {
      expect(check2.result).toEqual({ sent: true });
    }
  });

  it('should support: start → crash → recover → complete → cache hit', async () => {
    const jobId = await createTestJob();

    // Start execution
    const check1 = await checkIdempotency(db, jobId, 'step-1');
    expect(check1.outcome).toBe('execute');

    // Simulate crash (entry left as 'started')
    // Recovery check
    const check2 = await checkIdempotency(db, jobId, 'step-1');
    expect(check2.outcome).toBe('execute');
    expect(check2.executionId).toBe(check1.executionId); // same ID

    // Complete the retry
    await recordCompletion(db, check2.executionId, { recovered: true });

    // Subsequent check should hit cache
    const check3 = await checkIdempotency(db, jobId, 'step-1');
    expect(check3.outcome).toBe('cached');
    if (check3.outcome === 'cached') {
      expect(check3.result).toEqual({ recovered: true });
    }
  });

  it('should support: start → fail → retry → complete → cache hit', async () => {
    const jobId = await createTestJob();

    // First attempt: fail
    const check1 = await checkIdempotency(db, jobId, 'step-1');
    await recordFailure(db, check1.executionId);

    // Retry: succeed
    const check2 = await checkIdempotency(db, jobId, 'step-1');
    expect(check2.executionId).toBe(check1.executionId);
    await recordCompletion(db, check2.executionId, { output: 'retried' });

    // Cache hit
    const check3 = await checkIdempotency(db, jobId, 'step-1');
    expect(check3.outcome).toBe('cached');
    if (check3.outcome === 'cached') {
      expect(check3.result).toEqual({ output: 'retried' });
    }
  });

  it('should support multiple steps in the same job independently', async () => {
    const jobId = await createTestJob();

    const step1 = await checkIdempotency(db, jobId, 'step-1');
    const step2 = await checkIdempotency(db, jobId, 'step-2');
    const step3 = await checkIdempotency(db, jobId, 'step-3');

    expect(step1.outcome).toBe('execute');
    expect(step2.outcome).toBe('execute');
    expect(step3.outcome).toBe('execute');

    // Different execution IDs for different steps
    expect(step1.executionId).not.toBe(step2.executionId);
    expect(step2.executionId).not.toBe(step3.executionId);

    // Complete step 1, fail step 2, leave step 3 as started
    await recordCompletion(db, step1.executionId, { output: 'a' });
    await recordFailure(db, step2.executionId);

    // Check all three again
    const recheck1 = await checkIdempotency(db, jobId, 'step-1');
    const recheck2 = await checkIdempotency(db, jobId, 'step-2');
    const recheck3 = await checkIdempotency(db, jobId, 'step-3');

    expect(recheck1.outcome).toBe('cached'); // completed → cached
    expect(recheck2.outcome).toBe('execute'); // failed → retry
    expect(recheck3.outcome).toBe('execute'); // stale started → retry

    const log = await getExecutionLog(db, jobId);
    expect(log).toHaveLength(3);
  });
});
