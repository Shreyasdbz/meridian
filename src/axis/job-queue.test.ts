import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { JobStatus } from '@meridian/shared';
import {
  DatabaseClient,
  migrate,
  NotFoundError,
  ValidationError,
  MAX_REVISION_COUNT,
  MAX_REPLAN_COUNT,
} from '@meridian/shared';

import { JobQueue, VALID_TRANSITIONS, TERMINAL_STATES } from './job-queue.js';
import type { CreateJobOptions } from './job-queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CREATE_OPTIONS: CreateJobOptions = {
  source: 'user',
};

function createOptions(overrides?: Partial<CreateJobOptions>): CreateJobOptions {
  return { ...DEFAULT_CREATE_OPTIONS, ...overrides };
}

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
  // Clean up temp file
  try {
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
    // Also clean up WAL and SHM files
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
// Job creation
// ---------------------------------------------------------------------------

describe('JobQueue', () => {
  describe('createJob', () => {
    it('should create a job in pending state with UUID v7 ID', async () => {
      const job = await queue.createJob(createOptions());

      expect(job.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(job.status).toBe('pending');
      expect(job.source).toBe('user');
      expect(job.priority).toBe('normal');
      expect(job.attempts).toBe(0);
      expect(job.revisionCount).toBe(0);
      expect(job.replanCount).toBe(0);
    });

    it('should persist the job to the database', async () => {
      const created = await queue.createJob(createOptions());
      const fetched = await queue.getJob(created.id);

      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.status).toBe('pending');
    });

    it('should apply default values for optional fields', async () => {
      const job = await queue.createJob(createOptions());

      expect(job.maxAttempts).toBe(3);
      expect(job.timeoutMs).toBe(300_000);
      expect(job.priority).toBe('normal');
    });

    it('should accept custom values for optional fields', async () => {
      // Create a conversation first to satisfy FK constraint
      const convId = 'conv-1';
      const now = new Date().toISOString();
      await db.run(
        'meridian',
        `INSERT INTO conversations (id, title, status, created_at, updated_at)
         VALUES (?, 'test', 'active', ?, ?)`,
        [convId, now, now],
      );

      const job = await queue.createJob(
        createOptions({
          priority: 'critical',
          maxAttempts: 5,
          timeoutMs: 60_000,
          conversationId: convId,
          parentId: undefined,
        }),
      );

      expect(job.priority).toBe('critical');
      expect(job.maxAttempts).toBe(5);
      expect(job.timeoutMs).toBe(60_000);
      expect(job.conversationId).toBe(convId);
    });

    it('should generate unique IDs for each job', async () => {
      const job1 = await queue.createJob(createOptions());
      const job2 = await queue.createJob(createOptions());

      expect(job1.id).not.toBe(job2.id);
    });

    it('should persist and retrieve metadata', async () => {
      const meta = { requestId: 'req-abc', tags: ['urgent'] };
      const created = await queue.createJob(createOptions({ metadata: meta }));
      expect(created.metadata).toEqual(meta);

      const fetched = await queue.getJob(created.id);
      expect(fetched?.metadata).toEqual(meta);
    });

    it('should handle undefined metadata gracefully', async () => {
      const created = await queue.createJob(createOptions());
      expect(created.metadata).toBeUndefined();

      const fetched = await queue.getJob(created.id);
      expect(fetched?.metadata).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Job retrieval
  // ---------------------------------------------------------------------------

  describe('getJob', () => {
    it('should return undefined for non-existent job', async () => {
      const job = await queue.getJob('non-existent-id');
      expect(job).toBeUndefined();
    });

    it('should return the full job with all fields', async () => {
      // Create a conversation first to satisfy FK constraint
      const convId = 'conv-123';
      const now = new Date().toISOString();
      await db.run(
        'meridian',
        `INSERT INTO conversations (id, title, status, created_at, updated_at)
         VALUES (?, 'test', 'active', ?, ?)`,
        [convId, now, now],
      );

      const created = await queue.createJob(
        createOptions({
          priority: 'high',
          source: 'schedule',
          conversationId: convId,
        }),
      );

      const job = await queue.getJob(created.id);
      expect(job).toBeDefined();
      expect(job?.priority).toBe('high');
      expect(job?.source).toBe('schedule');
      expect(job?.conversationId).toBe(convId);
    });
  });

  // ---------------------------------------------------------------------------
  // Job claiming (pending → planning)
  // ---------------------------------------------------------------------------

  describe('claimJob', () => {
    it('should claim the next pending job', async () => {
      await queue.createJob(createOptions());
      const claimed = await queue.claimJob('worker-1');

      expect(claimed).toBeDefined();
      expect(claimed?.status).toBe('planning');
      expect(claimed?.workerId).toBe('worker-1');
    });

    it('should claim jobs in priority order', async () => {
      const low = await queue.createJob(createOptions({ priority: 'low' }));
      const critical = await queue.createJob(createOptions({ priority: 'critical' }));
      const normal = await queue.createJob(createOptions({ priority: 'normal' }));
      const high = await queue.createJob(createOptions({ priority: 'high' }));

      const first = await queue.claimJob('w-1');
      const second = await queue.claimJob('w-2');
      const third = await queue.claimJob('w-3');
      const fourth = await queue.claimJob('w-4');

      expect(first?.id).toBe(critical.id);
      expect(second?.id).toBe(high.id);
      expect(third?.id).toBe(normal.id);
      expect(fourth?.id).toBe(low.id);
    });

    it('should claim jobs FIFO within same priority', async () => {
      const first = await queue.createJob(createOptions());
      const second = await queue.createJob(createOptions());

      const claimed = await queue.claimJob('worker-1');
      expect(claimed?.id).toBe(first.id);

      const claimed2 = await queue.claimJob('worker-2');
      expect(claimed2?.id).toBe(second.id);
    });

    it('should return undefined when no pending jobs exist', async () => {
      const claimed = await queue.claimJob('worker-1');
      expect(claimed).toBeUndefined();
    });

    it('should prevent double-claim via CAS', async () => {
      await queue.createJob(createOptions());

      // Both workers try to claim at the same time
      const [claim1, claim2] = await Promise.all([
        queue.claimJob('worker-1'),
        queue.claimJob('worker-2'),
      ]);

      // Exactly one should succeed, the other should get undefined
      const claims = [claim1, claim2].filter(Boolean);
      expect(claims).toHaveLength(1);
    });

    it('should not claim non-pending jobs', async () => {
      await queue.createJob(createOptions());

      // Claim it once
      await queue.claimJob('worker-1');

      // Try to claim again — should return undefined since no pending jobs
      const secondClaim = await queue.claimJob('worker-2');
      expect(secondClaim).toBeUndefined();
    });

    it('should reject empty workerId', async () => {
      await queue.createJob(createOptions());
      await expect(queue.claimJob('')).rejects.toThrow(ValidationError);
    });

    it('should update the job in the database after claiming', async () => {
      const created = await queue.createJob(createOptions());
      await queue.claimJob('worker-1');

      const fetched = await queue.getJob(created.id);
      expect(fetched?.status).toBe('planning');
      expect(fetched?.workerId).toBe('worker-1');
    });
  });

  // ---------------------------------------------------------------------------
  // State transitions — valid transitions
  // ---------------------------------------------------------------------------

  describe('transition — valid transitions', () => {
    it('should transition pending → planning', async () => {
      const job = await queue.createJob(createOptions());
      const ok = await queue.transition(job.id, 'pending', 'planning');
      expect(ok).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated?.status).toBe('planning');
    });

    it('should transition planning → validating', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      const ok = await queue.transition(job.id, 'planning', 'validating');
      expect(ok).toBe(true);
    });

    it('should transition planning → completed (fast path)', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      const ok = await queue.transition(job.id, 'planning', 'completed');
      expect(ok).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.completedAt).toBeDefined();
    });

    it('should transition planning → failed', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      const ok = await queue.transition(job.id, 'planning', 'failed', {
        error: { code: 'LLM_UNREACHABLE', message: 'Scout API down', retriable: true },
      });
      expect(ok).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated?.status).toBe('failed');
      expect(updated?.error).toEqual({
        code: 'LLM_UNREACHABLE',
        message: 'Scout API down',
        retriable: true,
      });
    });

    it('should transition validating → executing', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      const ok = await queue.transition(job.id, 'validating', 'executing');
      expect(ok).toBe(true);
    });

    it('should transition validating → awaiting_approval', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      const ok = await queue.transition(job.id, 'validating', 'awaiting_approval');
      expect(ok).toBe(true);
    });

    it('should transition validating → planning (revision)', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      const ok = await queue.transition(job.id, 'validating', 'planning');
      expect(ok).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated?.revisionCount).toBe(1);
    });

    it('should transition validating → failed', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      const ok = await queue.transition(job.id, 'validating', 'failed');
      expect(ok).toBe(true);
    });

    it('should transition awaiting_approval → executing', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'awaiting_approval');
      const ok = await queue.transition(job.id, 'awaiting_approval', 'executing');
      expect(ok).toBe(true);
    });

    it('should transition awaiting_approval → cancelled', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'awaiting_approval');
      const ok = await queue.transition(job.id, 'awaiting_approval', 'cancelled');
      expect(ok).toBe(true);
    });

    it('should transition executing → completed', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      const ok = await queue.transition(job.id, 'executing', 'completed', {
        result: { output: 'done' },
      });
      expect(ok).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.result).toEqual({ output: 'done' });
      expect(updated?.completedAt).toBeDefined();
    });

    it('should transition executing → failed', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      const ok = await queue.transition(job.id, 'executing', 'failed');
      expect(ok).toBe(true);
    });

    it('should transition executing → planning (replan)', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      const ok = await queue.transition(job.id, 'executing', 'planning');
      expect(ok).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated?.replanCount).toBe(1);
    });

    it('should allow cancellation from any non-terminal state', async () => {
      const states: JobStatus[] = [
        'pending',
        'planning',
        'validating',
        'awaiting_approval',
        'executing',
      ];

      for (const state of states) {
        const job = await queue.createJob(createOptions());

        // Walk the job to the target state
        if (state !== 'pending') {
          await queue.transition(job.id, 'pending', 'planning');
        }
        if (state === 'validating' || state === 'awaiting_approval' || state === 'executing') {
          await queue.transition(job.id, 'planning', 'validating');
        }
        if (state === 'awaiting_approval') {
          await queue.transition(job.id, 'validating', 'awaiting_approval');
        }
        if (state === 'executing') {
          await queue.transition(job.id, 'validating', 'executing');
        }

        const ok = await queue.transition(job.id, state, 'cancelled');
        expect(ok).toBe(true);

        const updated = await queue.getJob(job.id);
        expect(updated?.status).toBe('cancelled');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // State transitions — invalid transitions
  // ---------------------------------------------------------------------------

  describe('transition — invalid transitions', () => {
    it('should reject invalid transitions', async () => {
      const job = await queue.createJob(createOptions());

      // pending → executing is not valid (must go through planning first)
      await expect(
        queue.transition(job.id, 'pending', 'executing'),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject pending → validating', async () => {
      const job = await queue.createJob(createOptions());
      await expect(
        queue.transition(job.id, 'pending', 'validating'),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject pending → awaiting_approval', async () => {
      const job = await queue.createJob(createOptions());
      await expect(
        queue.transition(job.id, 'pending', 'awaiting_approval'),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject planning → executing (must go through validating)', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await expect(
        queue.transition(job.id, 'planning', 'executing'),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject planning → awaiting_approval', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await expect(
        queue.transition(job.id, 'planning', 'awaiting_approval'),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject executing → validating', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      await expect(
        queue.transition(job.id, 'executing', 'validating'),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject executing → awaiting_approval', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      await expect(
        queue.transition(job.id, 'executing', 'awaiting_approval'),
      ).rejects.toThrow(ValidationError);
    });

    it('should return false when CAS fails (state mismatch)', async () => {
      const job = await queue.createJob(createOptions());
      // Job is pending, but we try to transition from planning
      const ok = await queue.transition(job.id, 'planning', 'validating');
      expect(ok).toBe(false);
    });

    it('should throw NotFoundError for non-existent job', async () => {
      await expect(
        queue.transition('non-existent', 'pending', 'planning'),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal states
  // ---------------------------------------------------------------------------

  describe('terminal states', () => {
    it('should not allow transitions from completed', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'completed');

      await expect(
        queue.transition(job.id, 'completed', 'pending'),
      ).rejects.toThrow(ValidationError);
      await expect(
        queue.transition(job.id, 'completed', 'planning'),
      ).rejects.toThrow(ValidationError);
      await expect(
        queue.transition(job.id, 'completed', 'cancelled'),
      ).rejects.toThrow(ValidationError);
    });

    it('should not allow transitions from failed', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'failed');

      await expect(
        queue.transition(job.id, 'failed', 'pending'),
      ).rejects.toThrow(ValidationError);
      await expect(
        queue.transition(job.id, 'failed', 'planning'),
      ).rejects.toThrow(ValidationError);
    });

    it('should not allow transitions from cancelled', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'cancelled');

      await expect(
        queue.transition(job.id, 'cancelled', 'pending'),
      ).rejects.toThrow(ValidationError);
      await expect(
        queue.transition(job.id, 'cancelled', 'planning'),
      ).rejects.toThrow(ValidationError);
    });

    it('should set completedAt for all terminal states', async () => {
      // completed
      const job1 = await queue.createJob(createOptions());
      await queue.transition(job1.id, 'pending', 'planning');
      await queue.transition(job1.id, 'planning', 'completed');
      const completed = await queue.getJob(job1.id);
      expect(completed?.completedAt).toBeDefined();

      // failed
      const job2 = await queue.createJob(createOptions());
      await queue.transition(job2.id, 'pending', 'planning');
      await queue.transition(job2.id, 'planning', 'failed');
      const failed = await queue.getJob(job2.id);
      expect(failed?.completedAt).toBeDefined();

      // cancelled
      const job3 = await queue.createJob(createOptions());
      await queue.transition(job3.id, 'pending', 'cancelled');
      const cancelled = await queue.getJob(job3.id);
      expect(cancelled?.completedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Cycle limits
  // ---------------------------------------------------------------------------

  describe('cycle limits', () => {
    it('should enforce revision count limit (max 3)', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');

      // 3 revision cycles
      for (let i = 0; i < MAX_REVISION_COUNT; i++) {
        await queue.transition(job.id, 'planning', 'validating');
        await queue.transition(job.id, 'validating', 'planning');
      }

      // 4th attempt should fail
      await queue.transition(job.id, 'planning', 'validating');
      await expect(
        queue.transition(job.id, 'validating', 'planning'),
      ).rejects.toThrow(/maximum revision count/);
    });

    it('should increment revision count on validating → planning', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'planning');

      const updated = await queue.getJob(job.id);
      expect(updated?.revisionCount).toBe(1);
    });

    it('should enforce replan count limit (max 2)', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');

      // 2 replan cycles
      for (let i = 0; i < MAX_REPLAN_COUNT; i++) {
        await queue.transition(job.id, 'planning', 'validating');
        await queue.transition(job.id, 'validating', 'executing');
        await queue.transition(job.id, 'executing', 'planning');
      }

      // 3rd replan attempt should fail
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      await expect(
        queue.transition(job.id, 'executing', 'planning'),
      ).rejects.toThrow(/maximum replan count/);
    });

    it('should increment replan count on executing → planning', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      await queue.transition(job.id, 'executing', 'planning');

      const updated = await queue.getJob(job.id);
      expect(updated?.replanCount).toBe(1);
    });

    it('should track revision and replan counts independently', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');

      // One revision cycle
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'planning');

      // Then one replan cycle
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      await queue.transition(job.id, 'executing', 'planning');

      const updated = await queue.getJob(job.id);
      expect(updated?.revisionCount).toBe(1);
      expect(updated?.replanCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Transition options (data updates)
  // ---------------------------------------------------------------------------

  describe('transition options', () => {
    it('should store plan on transition', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');

      const plan = {
        id: 'plan-1',
        jobId: job.id,
        steps: [
          {
            id: 'step-1',
            gear: 'web-search',
            action: 'search',
            parameters: { query: 'test' },
            riskLevel: 'low' as const,
          },
        ],
      };

      await queue.transition(job.id, 'planning', 'validating', { plan });

      const updated = await queue.getJob(job.id);
      expect(updated?.plan).toEqual(plan);
    });

    it('should store validation result on transition', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');

      const validation = {
        id: 'val-1',
        planId: 'plan-1',
        verdict: 'approved' as const,
        stepResults: [{ stepId: 'step-1', verdict: 'approved' as const }],
      };

      await queue.transition(job.id, 'validating', 'executing', { validation });

      const updated = await queue.getJob(job.id);
      expect(updated?.validation).toEqual(validation);
    });

    it('should store error on failure transition', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');

      const error = { code: 'ERR_TIMEOUT', message: 'Timed out', retriable: true };
      await queue.transition(job.id, 'planning', 'failed', { error });

      const updated = await queue.getJob(job.id);
      expect(updated?.error).toEqual(error);
    });

    it('should store result on completion', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');

      const result = { output: 'Email sent successfully', recipients: 3 };
      await queue.transition(job.id, 'executing', 'completed', { result });

      const updated = await queue.getJob(job.id);
      expect(updated?.result).toEqual(result);
    });

    it('should update workerId on transition', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning', { workerId: 'w-5' });

      const updated = await queue.getJob(job.id);
      expect(updated?.workerId).toBe('w-5');
    });

    it('should update metadata on transition', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning', {
        metadata: { diagnosticId: 'diag-123', attempt: 1 },
      });

      const updated = await queue.getJob(job.id);
      expect(updated?.metadata).toEqual({ diagnosticId: 'diag-123', attempt: 1 });
    });

    it('should overwrite existing metadata on transition', async () => {
      const job = await queue.createJob(
        createOptions({ metadata: { original: true } }),
      );
      expect((await queue.getJob(job.id))?.metadata).toEqual({ original: true });

      await queue.transition(job.id, 'pending', 'planning', {
        metadata: { replaced: true },
      });

      const updated = await queue.getJob(job.id);
      expect(updated?.metadata).toEqual({ replaced: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Cancel job
  // ---------------------------------------------------------------------------

  describe('cancelJob', () => {
    it('should cancel a pending job', async () => {
      const job = await queue.createJob(createOptions());
      const ok = await queue.cancelJob(job.id);
      expect(ok).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated?.status).toBe('cancelled');
    });

    it('should return false for already terminal jobs', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'completed');

      const ok = await queue.cancelJob(job.id);
      expect(ok).toBe(false);
    });

    it('should throw NotFoundError for non-existent job', async () => {
      await expect(queue.cancelJob('non-existent')).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Queue depth
  // ---------------------------------------------------------------------------

  describe('getQueueDepth', () => {
    it('should return 0 for empty queue', async () => {
      const depth = await queue.getQueueDepth();
      expect(depth).toBe(0);
    });

    it('should count pending jobs only', async () => {
      const job1 = await queue.createJob(createOptions());
      await queue.createJob(createOptions());
      await queue.createJob(createOptions());

      // Move one job out of pending
      await queue.transition(job1.id, 'pending', 'planning');

      const depth = await queue.getQueueDepth();
      expect(depth).toBe(2);
    });
  });

  describe('getActiveJobCount', () => {
    it('should count all non-terminal jobs', async () => {
      const job1 = await queue.createJob(createOptions());
      const job2 = await queue.createJob(createOptions());
      await queue.createJob(createOptions());

      // Complete one, leave others in non-terminal states
      await queue.transition(job1.id, 'pending', 'planning');
      await queue.transition(job1.id, 'planning', 'completed');
      await queue.transition(job2.id, 'pending', 'planning');

      const count = await queue.getActiveJobCount();
      expect(count).toBe(2); // job2 (planning) + job3 (pending)
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent CAS (double-claim prevention)
  // ---------------------------------------------------------------------------

  describe('concurrent CAS', () => {
    it('should prevent double-claim of the same job', async () => {
      // Create a single job
      await queue.createJob(createOptions());

      // Simulate 5 concurrent workers trying to claim
      const claims = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          queue.claimJob(`worker-${i}`),
        ),
      );

      const successful = claims.filter(Boolean);
      expect(successful).toHaveLength(1);
    });

    it('should prevent CAS race on transition', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');

      // Two concurrent transitions from the same state
      const [result1, result2] = await Promise.all([
        queue.transition(job.id, 'planning', 'validating'),
        queue.transition(job.id, 'planning', 'completed'),
      ]);

      // Exactly one should succeed
      const successes = [result1, result2].filter(Boolean);
      expect(successes).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // State machine completeness
  // ---------------------------------------------------------------------------

  describe('state machine completeness', () => {
    it('should define transitions for all job statuses', () => {
      const allStatuses: JobStatus[] = [
        'pending',
        'planning',
        'validating',
        'awaiting_approval',
        'executing',
        'completed',
        'failed',
        'cancelled',
      ];

      for (const status of allStatuses) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
      }
    });

    it('should have no outgoing transitions from terminal states', () => {
      for (const terminal of TERMINAL_STATES) {
        expect(VALID_TRANSITIONS[terminal]).toEqual([]);
      }
    });

    it('should include cancelled as valid target from all non-terminal states', () => {
      const nonTerminal: JobStatus[] = [
        'pending',
        'planning',
        'validating',
        'awaiting_approval',
        'executing',
      ];

      for (const state of nonTerminal) {
        expect(VALID_TRANSITIONS[state]).toContain('cancelled');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Time-dependent behavior with mock clocks
  // ---------------------------------------------------------------------------

  describe('time-dependent behavior', () => {
    it('should use deterministic timestamps with mock clocks', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

      const job = await queue.createJob(createOptions());
      expect(job.createdAt).toBe('2026-03-01T12:00:00.000Z');
      expect(job.updatedAt).toBe('2026-03-01T12:00:00.000Z');

      vi.advanceTimersByTime(5000);

      await queue.transition(job.id, 'pending', 'planning');
      const updated = await queue.getJob(job.id);
      expect(updated?.updatedAt).toBe('2026-03-01T12:00:05.000Z');

      vi.useRealTimers();
    });

    it('should set completedAt timestamp when reaching terminal state', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');

      vi.advanceTimersByTime(10_000);
      await queue.transition(job.id, 'planning', 'completed');

      const updated = await queue.getJob(job.id);
      expect(updated?.completedAt).toBe('2026-03-01T12:00:10.000Z');

      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('should support the complete fast path: pending → planning → completed', async () => {
      const job = await queue.createJob(createOptions());
      const claimed = await queue.claimJob('worker-1');
      expect(claimed?.status).toBe('planning');

      await queue.transition(job.id, 'planning', 'completed', {
        result: { message: 'Hello!' },
      });

      const final = await queue.getJob(job.id);
      expect(final?.status).toBe('completed');
      expect(final?.result).toEqual({ message: 'Hello!' });
    });

    it('should support the full path: pending → planning → validating → executing → completed', async () => {
      const job = await queue.createJob(createOptions());
      await queue.claimJob('worker-1');
      await queue.transition(job.id, 'planning', 'validating', {
        plan: {
          id: 'plan-1',
          jobId: job.id,
          steps: [{
            id: 'step-1',
            gear: 'notification',
            action: 'send',
            parameters: { message: 'test' },
            riskLevel: 'low',
          }],
        },
      });
      await queue.transition(job.id, 'validating', 'executing', {
        validation: {
          id: 'val-1',
          planId: 'plan-1',
          verdict: 'approved',
          stepResults: [{ stepId: 'step-1', verdict: 'approved' }],
        },
      });
      await queue.transition(job.id, 'executing', 'completed', {
        result: { sent: true },
      });

      const final = await queue.getJob(job.id);
      expect(final?.status).toBe('completed');
      expect(final?.plan).toBeDefined();
      expect(final?.validation).toBeDefined();
      expect(final?.result).toEqual({ sent: true });
    });

    it('should support revision cycle: validating → planning → validating', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'planning'); // revision
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'executing');
      await queue.transition(job.id, 'executing', 'completed');

      const final = await queue.getJob(job.id);
      expect(final?.status).toBe('completed');
      expect(final?.revisionCount).toBe(1);
    });

    it('should support approval path: validating → awaiting_approval → executing', async () => {
      const job = await queue.createJob(createOptions());
      await queue.transition(job.id, 'pending', 'planning');
      await queue.transition(job.id, 'planning', 'validating');
      await queue.transition(job.id, 'validating', 'awaiting_approval');
      await queue.transition(job.id, 'awaiting_approval', 'executing');
      await queue.transition(job.id, 'executing', 'completed');

      const final = await queue.getJob(job.id);
      expect(final?.status).toBe('completed');
    });
  });
});
