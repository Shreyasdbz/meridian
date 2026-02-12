import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  DatabaseClient,
  migrate,
  ConflictError,
  DEDUP_WINDOW_MS,
} from '@meridian/shared';

import { computeDedupHash, findDuplicateJobId } from './dedup.js';
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
// Hash generation
// ---------------------------------------------------------------------------

describe('computeDedupHash', () => {
  it('should produce a 64-character hex SHA-256 hash', () => {
    const hash = computeDedupHash('user-1', 'send email to alice');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce identical hashes for same inputs within the same time window', () => {
    const ts = 1700000000000; // fixed timestamp
    const hash1 = computeDedupHash('user-1', 'send email', ts);
    const hash2 = computeDedupHash('user-1', 'send email', ts + 1000); // 1s later, same window

    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes across time window boundaries', () => {
    const ts = 1700000000000;
    const hash1 = computeDedupHash('user-1', 'send email', ts);
    const hash2 = computeDedupHash('user-1', 'send email', ts + DEDUP_WINDOW_MS);

    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different users with same content', () => {
    const ts = 1700000000000;
    const hash1 = computeDedupHash('user-1', 'send email', ts);
    const hash2 = computeDedupHash('user-2', 'send email', ts);

    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for same user with different content', () => {
    const ts = 1700000000000;
    const hash1 = computeDedupHash('user-1', 'send email to alice', ts);
    const hash2 = computeDedupHash('user-1', 'send email to bob', ts);

    expect(hash1).not.toBe(hash2);
  });

  it('should use Date.now() when no timestamp is provided', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

    const hash1 = computeDedupHash('user-1', 'test');
    const hash2 = computeDedupHash('user-1', 'test');

    expect(hash1).toBe(hash2);

    vi.useRealTimers();
  });

  it('should handle edge case at exact window boundary', () => {
    // timestamp exactly at a window boundary
    const boundary = DEDUP_WINDOW_MS * 340000; // exact multiple
    const hash1 = computeDedupHash('user-1', 'test', boundary - 1);
    const hash2 = computeDedupHash('user-1', 'test', boundary);

    // boundary - 1 is in the previous window, boundary is in the next
    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty content', () => {
    const hash = computeDedupHash('user-1', '');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should handle empty userId', () => {
    const hash = computeDedupHash('', 'content');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should not produce collisions for ambiguous concatenations', () => {
    // Without a delimiter, "abc" + "def" and "ab" + "cdef" would collide
    const ts = 1700000000000;
    const hash1 = computeDedupHash('abc', 'def', ts);
    const hash2 = computeDedupHash('ab', 'cdef', ts);

    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

describe('findDuplicateJobId', () => {
  it('should return undefined when no matching job exists', async () => {
    const result = await findDuplicateJobId(db, 'nonexistent-hash');
    expect(result).toBeUndefined();
  });

  it('should find an existing non-terminal job with matching hash', async () => {
    const hash = computeDedupHash('user-1', 'send email', 1700000000000);
    const job = await queue.createJob({ source: 'user', dedupHash: hash });

    const result = await findDuplicateJobId(db, hash);
    expect(result).toBe(job.id);
  });

  it('should not match completed jobs', async () => {
    const hash = computeDedupHash('user-1', 'send email', 1700000000000);
    const job = await queue.createJob({ source: 'user', dedupHash: hash });
    await queue.transition(job.id, 'pending', 'planning');
    await queue.transition(job.id, 'planning', 'completed');

    const result = await findDuplicateJobId(db, hash);
    expect(result).toBeUndefined();
  });

  it('should not match failed jobs', async () => {
    const hash = computeDedupHash('user-1', 'send email', 1700000000000);
    const job = await queue.createJob({ source: 'user', dedupHash: hash });
    await queue.transition(job.id, 'pending', 'planning');
    await queue.transition(job.id, 'planning', 'failed');

    const result = await findDuplicateJobId(db, hash);
    expect(result).toBeUndefined();
  });

  it('should not match cancelled jobs', async () => {
    const hash = computeDedupHash('user-1', 'send email', 1700000000000);
    const job = await queue.createJob({ source: 'user', dedupHash: hash });
    await queue.transition(job.id, 'pending', 'cancelled');

    const result = await findDuplicateJobId(db, hash);
    expect(result).toBeUndefined();
  });

  it('should match jobs in any non-terminal state', async () => {
    // Test planning state
    const hash1 = 'hash-planning';
    const job1 = await queue.createJob({ source: 'user', dedupHash: hash1 });
    await queue.transition(job1.id, 'pending', 'planning');

    expect(await findDuplicateJobId(db, hash1)).toBe(job1.id);

    // Test validating state
    const hash2 = 'hash-validating';
    const job2 = await queue.createJob({ source: 'user', dedupHash: hash2 });
    await queue.transition(job2.id, 'pending', 'planning');
    await queue.transition(job2.id, 'planning', 'validating');

    expect(await findDuplicateJobId(db, hash2)).toBe(job2.id);

    // Test executing state
    const hash3 = 'hash-executing';
    const job3 = await queue.createJob({ source: 'user', dedupHash: hash3 });
    await queue.transition(job3.id, 'pending', 'planning');
    await queue.transition(job3.id, 'planning', 'validating');
    await queue.transition(job3.id, 'validating', 'executing');

    expect(await findDuplicateJobId(db, hash3)).toBe(job3.id);
  });

  it('should allow resubmission after a job completes', async () => {
    const hash = computeDedupHash('user-1', 'send email', 1700000000000);

    // First submission → complete it
    const job1 = await queue.createJob({ source: 'user', dedupHash: hash });
    await queue.transition(job1.id, 'pending', 'planning');
    await queue.transition(job1.id, 'planning', 'completed');

    // No duplicate found → new job can be created
    expect(await findDuplicateJobId(db, hash)).toBeUndefined();

    // Second submission with same hash
    const job2 = await queue.createJob({ source: 'user', dedupHash: hash });
    expect(job2.id).not.toBe(job1.id);
    expect(await findDuplicateJobId(db, hash)).toBe(job2.id);
  });

  it('should enforce uniqueness via the UNIQUE partial index', async () => {
    const hash = computeDedupHash('user-1', 'send email', 1700000000000);

    // First job with this hash
    await queue.createJob({ source: 'user', dedupHash: hash });

    // Second job with same hash while first is still non-terminal — should throw ConflictError
    await expect(
      queue.createJob({ source: 'user', dedupHash: hash }),
    ).rejects.toThrow(ConflictError);
  });

  it('should return undefined for null dedup hashes', async () => {
    // Create a job without dedup hash
    await queue.createJob({ source: 'user' });

    // Searching for any specific hash shouldn't match
    const result = await findDuplicateJobId(db, 'any-hash');
    expect(result).toBeUndefined();
  });

  it('should allow multiple jobs with null dedup hash', async () => {
    // NULL values are excluded from UNIQUE partial index — multiple NULLs are OK
    const job1 = await queue.createJob({ source: 'user' });
    const job2 = await queue.createJob({ source: 'user' });
    const job3 = await queue.createJob({ source: 'user' });

    expect(job1.id).not.toBe(job2.id);
    expect(job2.id).not.toBe(job3.id);
  });
});

// ---------------------------------------------------------------------------
// Integration: full dedup flow
// ---------------------------------------------------------------------------

describe('dedup flow integration', () => {
  it('should detect duplicate within time window and prevent creation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

    const userId = 'user-1';
    const content = 'send email to alice';
    const hash = computeDedupHash(userId, content);

    // First submission
    const job = await queue.createJob({ source: 'user', dedupHash: hash });
    expect(job.id).toBeDefined();

    // Same request 2 seconds later (same window)
    vi.advanceTimersByTime(2000);
    const hash2 = computeDedupHash(userId, content);
    expect(hash2).toBe(hash); // same window → same hash

    const duplicate = await findDuplicateJobId(db, hash2);
    expect(duplicate).toBe(job.id);

    vi.useRealTimers();
  });

  it('should allow new submission after time window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

    const userId = 'user-1';
    const content = 'send email to alice';
    const hash1 = computeDedupHash(userId, content);

    // First submission
    const job1 = await queue.createJob({ source: 'user', dedupHash: hash1 });

    // Complete the first job
    await queue.transition(job1.id, 'pending', 'planning');
    await queue.transition(job1.id, 'planning', 'completed');

    // Move to next window
    vi.advanceTimersByTime(DEDUP_WINDOW_MS);

    const hash2 = computeDedupHash(userId, content);
    expect(hash2).not.toBe(hash1); // different window → different hash

    // New submission should succeed
    const job2 = await queue.createJob({ source: 'user', dedupHash: hash2 });
    expect(job2.id).not.toBe(job1.id);

    vi.useRealTimers();
  });
});
