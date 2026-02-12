import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DatabaseClient, migrate } from '@meridian/shared';

import { recoverJobs } from './recovery.js';

// ---------------------------------------------------------------------------
// Test setup — temp file SQLite via direct mode
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-recovery');
let dbPath: string;
let db: DatabaseClient;

beforeEach(async () => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  dbPath = join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new DatabaseClient({ dataDir: TEST_DIR, direct: true });
  await db.start();
  await db.open('meridian', dbPath);
  await migrate(db, 'meridian', process.cwd());
});

afterEach(async () => {
  await db.close();
  try {
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(dbPath + '-wal')) unlinkSync(dbPath + '-wal');
    if (existsSync(dbPath + '-shm')) unlinkSync(dbPath + '-shm');
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertJob(
  id: string,
  status: string,
  workerId: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    'meridian',
    `INSERT INTO jobs (id, status, priority, source_type, worker_id, created_at, updated_at)
     VALUES (?, ?, 'normal', 'user', ?, ?, ?)`,
    [id, status, workerId, now, now],
  );
}

async function insertExecutionLogEntry(
  executionId: string,
  jobId: string,
  stepId: string,
  status: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    'meridian',
    `INSERT INTO execution_log (execution_id, job_id, step_id, status, started_at)
     VALUES (?, ?, ?, ?, ?)`,
    [executionId, jobId, stepId, status, now],
  );
}

async function getJobStatus(id: string): Promise<string | undefined> {
  const rows = await db.query<{ status: string }>('meridian', 'SELECT status FROM jobs WHERE id = ?', [id]);
  return rows[0]?.status;
}

async function getJobWorkerId(id: string): Promise<string | null | undefined> {
  const rows = await db.query<{ worker_id: string | null }>(
    'meridian',
    'SELECT worker_id FROM jobs WHERE id = ?',
    [id],
  );
  return rows[0]?.worker_id;
}

async function getExecutionEntryStatus(executionId: string): Promise<string | undefined> {
  const rows = await db.query<{ status: string }>(
    'meridian',
    'SELECT status FROM execution_log WHERE execution_id = ?',
    [executionId],
  );
  return rows[0]?.status;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverJobs', () => {
  describe('no jobs', () => {
    it('should return zero counts when no jobs exist', async () => {
      const result = await recoverJobs(db);

      expect(result.nonTerminalJobCount).toBe(0);
      expect(result.resetJobIds).toHaveLength(0);
      expect(result.stalePipelineJobIds).toHaveLength(0);
      expect(result.failedExecutionEntries).toBe(0);
    });
  });

  describe('terminal jobs only', () => {
    it('should not touch completed, failed, or cancelled jobs', async () => {
      await insertJob('job-completed', 'completed');
      await insertJob('job-failed', 'failed');
      await insertJob('job-cancelled', 'cancelled');

      const result = await recoverJobs(db);

      expect(result.nonTerminalJobCount).toBe(0);
      expect(result.resetJobIds).toHaveLength(0);
      expect(result.stalePipelineJobIds).toHaveLength(0);
    });
  });

  describe('executing jobs', () => {
    it('should reset executing jobs to pending', async () => {
      await insertJob('job-exec', 'executing', 'worker-1');

      const result = await recoverJobs(db);

      expect(result.nonTerminalJobCount).toBe(1);
      expect(result.resetJobIds).toEqual(['job-exec']);
      expect(await getJobStatus('job-exec')).toBe('pending');
      expect(await getJobWorkerId('job-exec')).toBeNull();
    });

    it('should mark stale started execution entries as failed', async () => {
      await insertJob('job-exec', 'executing', 'worker-1');
      await insertExecutionLogEntry('exec-1', 'job-exec', 'step-1', 'started');
      await insertExecutionLogEntry('exec-2', 'job-exec', 'step-2', 'started');

      const result = await recoverJobs(db);

      expect(result.failedExecutionEntries).toBe(2);
      expect(await getExecutionEntryStatus('exec-1')).toBe('failed');
      expect(await getExecutionEntryStatus('exec-2')).toBe('failed');
    });

    it('should not touch completed execution entries', async () => {
      await insertJob('job-exec', 'executing', 'worker-1');
      await insertExecutionLogEntry('exec-1', 'job-exec', 'step-1', 'completed');
      await insertExecutionLogEntry('exec-2', 'job-exec', 'step-2', 'started');

      const result = await recoverJobs(db);

      expect(result.failedExecutionEntries).toBe(1);
      expect(await getExecutionEntryStatus('exec-1')).toBe('completed');
      expect(await getExecutionEntryStatus('exec-2')).toBe('failed');
    });
  });

  describe('pipeline jobs', () => {
    it('should reset planning jobs to pending', async () => {
      await insertJob('job-plan', 'planning', 'worker-2');

      const result = await recoverJobs(db);

      expect(result.stalePipelineJobIds).toEqual(['job-plan']);
      expect(await getJobStatus('job-plan')).toBe('pending');
      expect(await getJobWorkerId('job-plan')).toBeNull();
    });

    it('should reset validating jobs to pending', async () => {
      await insertJob('job-val', 'validating', 'worker-3');

      const result = await recoverJobs(db);

      expect(result.stalePipelineJobIds).toEqual(['job-val']);
      expect(await getJobStatus('job-val')).toBe('pending');
    });
  });

  describe('awaiting_approval jobs', () => {
    it('should leave awaiting_approval jobs as-is', async () => {
      await insertJob('job-approval', 'awaiting_approval');

      const result = await recoverJobs(db);

      expect(result.nonTerminalJobCount).toBe(1);
      expect(result.resetJobIds).toHaveLength(0);
      expect(result.stalePipelineJobIds).toHaveLength(0);
      expect(await getJobStatus('job-approval')).toBe('awaiting_approval');
    });
  });

  describe('pending jobs', () => {
    it('should leave pending jobs as-is', async () => {
      await insertJob('job-pending', 'pending');

      const result = await recoverJobs(db);

      expect(result.nonTerminalJobCount).toBe(1);
      expect(result.resetJobIds).toHaveLength(0);
      expect(result.stalePipelineJobIds).toHaveLength(0);
      expect(await getJobStatus('job-pending')).toBe('pending');
    });
  });

  describe('mixed jobs', () => {
    it('should correctly handle a mix of terminal and non-terminal jobs', async () => {
      await insertJob('job-completed', 'completed');
      await insertJob('job-failed', 'failed');
      await insertJob('job-pending', 'pending');
      await insertJob('job-planning', 'planning', 'worker-1');
      await insertJob('job-executing', 'executing', 'worker-2');
      await insertJob('job-approval', 'awaiting_approval');

      await insertExecutionLogEntry('exec-1', 'job-executing', 'step-1', 'started');

      const result = await recoverJobs(db);

      expect(result.nonTerminalJobCount).toBe(4);
      expect(result.resetJobIds).toEqual(['job-executing']);
      expect(result.stalePipelineJobIds).toEqual(['job-planning']);
      expect(result.failedExecutionEntries).toBe(1);

      expect(await getJobStatus('job-completed')).toBe('completed');
      expect(await getJobStatus('job-failed')).toBe('failed');
      expect(await getJobStatus('job-pending')).toBe('pending');
      expect(await getJobStatus('job-planning')).toBe('pending');
      expect(await getJobStatus('job-executing')).toBe('pending');
      expect(await getJobStatus('job-approval')).toBe('awaiting_approval');
    });
  });

  describe('idempotency', () => {
    it('should be idempotent — running twice produces the same result', async () => {
      await insertJob('job-exec', 'executing', 'worker-1');
      await insertExecutionLogEntry('exec-1', 'job-exec', 'step-1', 'started');

      const result1 = await recoverJobs(db);
      expect(result1.resetJobIds).toEqual(['job-exec']);
      expect(result1.failedExecutionEntries).toBe(1);

      // Run again — job is now pending, nothing should change
      const result2 = await recoverJobs(db);
      expect(result2.nonTerminalJobCount).toBe(1);
      expect(result2.resetJobIds).toHaveLength(0);
      expect(result2.stalePipelineJobIds).toHaveLength(0);
      expect(result2.failedExecutionEntries).toBe(0);

      expect(await getJobStatus('job-exec')).toBe('pending');
    });
  });
});
