import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DatabaseClient, migrate } from '@meridian/shared';

import { JobQueue } from './job-queue.js';
import { WorkerPool } from './worker-pool.js';
import type { JobProcessor, WorkerPoolLogger, WorkerPoolOptions } from './worker-pool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collect log calls for assertions. */
function createSpyLogger(): WorkerPoolLogger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- keys initialized above
    debug: (...args: unknown[]) => { calls['debug']!.push(args); },
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- keys initialized above
    info: (...args: unknown[]) => { calls['info']!.push(args); },
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- keys initialized above
    warn: (...args: unknown[]) => { calls['warn']!.push(args); },
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- keys initialized above
    error: (...args: unknown[]) => { calls['error']!.push(args); },
  };
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
// Helper to create a pool with test defaults
// ---------------------------------------------------------------------------

function createPool(overrides?: Partial<WorkerPoolOptions>): WorkerPool {
  const processor: JobProcessor = () => Promise.resolve();
  return new WorkerPool({
    maxWorkers: 2,
    queue,
    processor,
    pollIntervalMs: 50,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('WorkerPool', () => {
  describe('constructor', () => {
    it('should throw if maxWorkers is less than 1', () => {
      expect(
        () => createPool({ maxWorkers: 0 }),
      ).toThrow('maxWorkers must be at least 1');
    });

    it('should accept maxWorkers of 1', () => {
      const pool = createPool({ maxWorkers: 1 });
      expect(pool.getMaxWorkers()).toBe(1);
    });

    it('should default to the configured maxWorkers', () => {
      const pool = createPool({ maxWorkers: 4 });
      expect(pool.getMaxWorkers()).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('should not be running before start', () => {
      const pool = createPool();
      expect(pool.isRunning()).toBe(false);
    });

    it('should be running after start', () => {
      const pool = createPool();
      pool.start();
      expect(pool.isRunning()).toBe(true);
      void pool.stop();
    });

    it('should not be running after stop', async () => {
      const pool = createPool();
      pool.start();
      await pool.stop();
      expect(pool.isRunning()).toBe(false);
    });

    it('should be idempotent on start', () => {
      const pool = createPool();
      pool.start();
      pool.start(); // no-op
      expect(pool.isRunning()).toBe(true);
      void pool.stop();
    });

    it('should return empty array when stopping with no active jobs', async () => {
      const pool = createPool();
      pool.start();
      const stillRunning = await pool.stop();
      expect(stillRunning).toEqual([]);
    });

    it('should return empty array when stopping an already-stopped pool', async () => {
      const pool = createPool();
      const stillRunning = await pool.stop();
      expect(stillRunning).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Job processing
  // -------------------------------------------------------------------------

  describe('job processing', () => {
    it('should claim and process a pending job', async () => {
      const processedJobs: string[] = [];
      const processor: JobProcessor = (job) => {
        processedJobs.push(job.id);
        return Promise.resolve();
      };

      const pool = createPool({ processor, maxWorkers: 2, pollIntervalMs: 30 });

      const job = await queue.createJob({ source: 'user' });

      pool.start();
      // Wait for poll + processing
      await delay(150);
      await pool.stop();

      expect(processedJobs).toContain(job.id);
    });

    it('should process multiple jobs concurrently', async () => {
      const startTimes: Record<string, number> = {};
      const endTimes: Record<string, number> = {};

      const processor: JobProcessor = async (job) => {
        startTimes[job.id] = Date.now();
        await delay(100);
        endTimes[job.id] = Date.now();
      };

      const pool = createPool({ processor, maxWorkers: 4, pollIntervalMs: 20 });

      const job1 = await queue.createJob({ source: 'user' });
      const job2 = await queue.createJob({ source: 'user' });

      pool.start();
      await delay(300);
      await pool.stop();

      // Both jobs should have been processed
      expect(startTimes[job1.id]).toBeDefined();
      expect(startTimes[job2.id]).toBeDefined();

      // Both should have completed
      expect(Object.keys(endTimes).length).toBe(2);
    });

    it('should not exceed maxWorkers concurrent jobs', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const processor: JobProcessor = async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await delay(100);
        currentConcurrent--;
      };

      const pool = createPool({ processor, maxWorkers: 2, pollIntervalMs: 20 });

      // Create 5 jobs
      for (let i = 0; i < 5; i++) {
        await queue.createJob({ source: 'user' });
      }

      pool.start();
      await delay(600);
      await pool.stop();

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should handle processor errors without crashing the pool', async () => {
      let errorJobProcessed = false;
      let successJobProcessed = false;
      const logger = createSpyLogger();

      const processor: JobProcessor = (_job) => {
        if (!errorJobProcessed) {
          errorJobProcessed = true;
          return Promise.reject(new Error('processing failed'));
        }
        successJobProcessed = true;
        return Promise.resolve();
      };

      const pool = createPool({ processor, maxWorkers: 2, pollIntervalMs: 30, logger });

      await queue.createJob({ source: 'user' });
      await queue.createJob({ source: 'user' });

      pool.start();
      await delay(200);
      await pool.stop();

      expect(errorJobProcessed).toBe(true);
      expect(successJobProcessed).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- key initialized in createSpyLogger
      expect(logger.calls['error']!.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Backpressure
  // -------------------------------------------------------------------------

  describe('backpressure', () => {
    it('should enter backpressure when all workers are busy', async () => {
      const logger = createSpyLogger();

      const processor: JobProcessor = async () => {
        await delay(200);
      };

      const pool = createPool({
        processor,
        maxWorkers: 1,
        pollIntervalMs: 30,
        logger,
      });

      await queue.createJob({ source: 'user' });
      await queue.createJob({ source: 'user' });

      pool.start();
      await delay(100);
      expect(pool.isBackpressureActive()).toBe(true);
      await pool.stop();
    });

    it('should release backpressure when all jobs complete', async () => {
      const processedJobs: string[] = [];
      const processor: JobProcessor = async (job) => {
        await delay(60);
        processedJobs.push(job.id);
      };

      const pool = createPool({
        processor,
        maxWorkers: 1,
        pollIntervalMs: 20,
      });

      await queue.createJob({ source: 'user' });

      pool.start();
      // Wait for the job to be claimed
      await delay(40);
      expect(pool.isBackpressureActive()).toBe(true);

      // Wait for the job to complete and a poll cycle to release backpressure
      await delay(80);
      expect(pool.isBackpressureActive()).toBe(false);
      expect(processedJobs.length).toBe(1);

      await pool.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  describe('graceful shutdown', () => {
    it('should signal active workers via AbortSignal on stop', async () => {
      let signalAborted = false;

      const processor: JobProcessor = async (_job, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            signalAborted = true;
            resolve();
          }, { once: true });
        });
      };

      const pool = createPool({ processor, maxWorkers: 1, pollIntervalMs: 30 });

      await queue.createJob({ source: 'user' });

      pool.start();
      await delay(100);
      await pool.stop(5000);

      expect(signalAborted).toBe(true);
    });

    it('should wait for active jobs during grace period', async () => {
      let jobCompleted = false;

      const processor: JobProcessor = async (_job, signal) => {
        signal.addEventListener('abort', () => {
          // Simulate cleanup work
          setTimeout(() => { jobCompleted = true; }, 50);
        }, { once: true });
        // Wait for abort or long timeout
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            setTimeout(resolve, 60);
          }, { once: true });
        });
      };

      const pool = createPool({ processor, maxWorkers: 1, pollIntervalMs: 30 });

      await queue.createJob({ source: 'user' });

      pool.start();
      await delay(100);
      await pool.stop(5000);

      expect(jobCompleted).toBe(true);
    });

    it('should return still-running worker IDs when grace expires', async () => {
      const processor: JobProcessor = async () => {
        // Job that never finishes
        await new Promise(() => {});
      };

      const pool = createPool({ processor, maxWorkers: 1, pollIntervalMs: 30 });

      await queue.createJob({ source: 'user' });

      pool.start();
      await delay(100);
      const stillRunning = await pool.stop(50);

      expect(stillRunning.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  describe('introspection', () => {
    it('should report active worker count', async () => {
      const processor: JobProcessor = async () => {
        await delay(200);
      };

      const pool = createPool({ processor, maxWorkers: 4, pollIntervalMs: 20 });

      await queue.createJob({ source: 'user' });
      await queue.createJob({ source: 'user' });

      pool.start();
      await delay(100);

      expect(pool.getActiveWorkerCount()).toBe(2);
      await pool.stop();
    });

    it('should expose worker info', async () => {
      const processor: JobProcessor = async () => {
        await delay(200);
      };

      const pool = createPool({ processor, maxWorkers: 4, pollIntervalMs: 20 });

      const job = await queue.createJob({ source: 'user' });

      pool.start();
      await delay(100);

      const workers = pool.getWorkers();
      expect(workers.size).toBe(1);
      const [workerInfo] = workers.values();
      expect(workerInfo).toBeDefined();
      expect(workerInfo?.status).toBe('busy');
      expect(workerInfo?.currentJobId).toBe(job.id);
      expect(workerInfo?.busySince).toBeGreaterThan(0);

      await pool.stop();
    });

    it('should return maxWorkers', () => {
      const pool = createPool({ maxWorkers: 8 });
      expect(pool.getMaxWorkers()).toBe(8);
    });
  });

  // -------------------------------------------------------------------------
  // Priority ordering
  // -------------------------------------------------------------------------

  describe('priority ordering', () => {
    it('should process higher-priority jobs first', async () => {
      const processedOrder: string[] = [];

      const processor: JobProcessor = (job) => {
        processedOrder.push(job.priority ?? 'normal');
        return Promise.resolve();
      };

      const pool = createPool({ processor, maxWorkers: 1, pollIntervalMs: 30 });

      // Create jobs in reverse priority order
      await queue.createJob({ source: 'user', priority: 'low' });
      await queue.createJob({ source: 'user', priority: 'critical' });
      await queue.createJob({ source: 'user', priority: 'high' });

      pool.start();
      await delay(300);
      await pool.stop();

      // Critical should be processed before high, high before low
      expect(processedOrder[0]).toBe('critical');
      expect(processedOrder[1]).toBe('high');
      expect(processedOrder[2]).toBe('low');
    });
  });

  // -------------------------------------------------------------------------
  // Worker pool with logger
  // -------------------------------------------------------------------------

  describe('logging', () => {
    it('should log worker pool start and stop', async () => {
      const logger = createSpyLogger();
      const pool = createPool({ logger });

      pool.start();
      await pool.stop();

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- key initialized in createSpyLogger
      const infoMessages = logger.calls['info']!.map((c) => c[0]);
      expect(infoMessages).toContain('Worker pool started');
      expect(
        infoMessages.some((m) =>
          typeof m === 'string' && m.includes('Worker pool stopped'),
        ),
      ).toBe(true);
    });

    it('should log job claim events', async () => {
      const logger = createSpyLogger();
      const processor: JobProcessor = () => Promise.resolve();

      const pool = createPool({ processor, logger, pollIntervalMs: 30 });

      await queue.createJob({ source: 'user' });

      pool.start();
      await delay(100);
      await pool.stop();

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- key initialized in createSpyLogger
      const infoMessages = logger.calls['info']!.map((c) => c[0]);
      expect(infoMessages).toContain('Worker claimed job');
    });
  });
});
