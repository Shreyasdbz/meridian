import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DatabaseClient, migrate } from '@meridian/shared';

import { BasicMaintenance } from './maintenance-basic.js';
import type { MaintenanceLogger } from './maintenance-basic.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createCollectingLogger(): MaintenanceLogger & {
  messages: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
} {
  const messages: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  return {
    messages,
    info: (message, data) => { messages.push({ level: 'info', message, data }); },
    warn: (message, data) => { messages.push({ level: 'warn', message, data }); },
    error: (message, data) => { messages.push({ level: 'error', message, data }); },
    debug: (message, data) => { messages.push({ level: 'debug', message, data }); },
  };
}

// ---------------------------------------------------------------------------
// Test setup — temp file SQLite via direct mode
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-maintenance');
let dbPath: string;
let db: DatabaseClient;
let maintenance: BasicMaintenance | null = null;

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
  if (maintenance) {
    maintenance.stop();
    maintenance = null;
  }
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
// Tests
// ---------------------------------------------------------------------------

describe('BasicMaintenance', () => {
  describe('lifecycle', () => {
    it('should start and stop without error', async () => {
      const logger = createCollectingLogger();
      maintenance = new BasicMaintenance({
        db,
        logger,
        databases: ['meridian'],
      });

      const result = await maintenance.start();
      expect(maintenance.isRunning()).toBe(true);
      expect(result.succeeded).toContain('meridian');
      expect(result.failed).toHaveLength(0);

      maintenance.stop();
      expect(maintenance.isRunning()).toBe(false);

      const startMsg = logger.messages.find((m) => m.message === 'Maintenance scheduler started');
      const stopMsg = logger.messages.find((m) => m.message === 'Maintenance scheduler stopped');
      expect(startMsg).toBeDefined();
      expect(stopMsg).toBeDefined();
    });

    it('should be idempotent on start', async () => {
      maintenance = new BasicMaintenance({
        db,
        databases: ['meridian'],
      });

      await maintenance.start();
      const result2 = await maintenance.start(); // should be a no-op
      expect(result2.succeeded).toHaveLength(0);
      expect(result2.durationMs).toBe(0);
    });

    it('should be idempotent on stop', () => {
      maintenance = new BasicMaintenance({
        db,
        databases: ['meridian'],
      });

      maintenance.stop(); // should not throw when not started
      expect(maintenance.isRunning()).toBe(false);
    });
  });

  describe('initial maintenance run', () => {
    it('should run ANALYZE and INCREMENTAL VACUUM on startup', async () => {
      const logger = createCollectingLogger();
      maintenance = new BasicMaintenance({
        db,
        logger,
        databases: ['meridian'],
      });

      const result = await maintenance.start();

      expect(result.succeeded).toEqual(['meridian']);
      expect(result.failed).toHaveLength(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const analyzeMsg = logger.messages.find(
        (m) => m.message === 'Running ANALYZE' && m.data?.database === 'meridian',
      );
      const vacuumMsg = logger.messages.find(
        (m) => m.message === 'Running PRAGMA incremental_vacuum' && m.data?.database === 'meridian',
      );
      expect(analyzeMsg).toBeDefined();
      expect(vacuumMsg).toBeDefined();
    });

    it('should track lastRunAt after maintenance', async () => {
      maintenance = new BasicMaintenance({
        db,
        databases: ['meridian'],
      });

      expect(maintenance.getLastRunAt()).toBeUndefined();

      await maintenance.start();

      const lastRun = maintenance.getLastRunAt();
      expect(lastRun).toBeDefined();
      expect(lastRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('manual maintenance', () => {
    it('should allow manual runMaintenance() invocation', async () => {
      const logger = createCollectingLogger();
      maintenance = new BasicMaintenance({
        db,
        logger,
        databases: ['meridian'],
      });

      // Run manually without starting the scheduler
      const result = await maintenance.runMaintenance();

      expect(result.succeeded).toEqual(['meridian']);
      expect(result.failed).toHaveLength(0);

      const completeMsg = logger.messages.find(
        (m) => m.message === 'Maintenance run complete',
      );
      expect(completeMsg).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should continue if one database fails', async () => {
      const logger = createCollectingLogger();

      // Create a closed client so exec() calls will fail
      const closedDb = new DatabaseClient({ dataDir: TEST_DIR, direct: true });
      await closedDb.start();
      await closedDb.open('meridian', dbPath);
      await closedDb.close(); // Close it to force failures

      maintenance = new BasicMaintenance({
        db: closedDb,
        logger,
        databases: ['meridian'],
      });

      const result = await maintenance.runMaintenance();

      // All should fail since the client is closed
      expect(result.failed.length).toBeGreaterThanOrEqual(1);

      const errorMsg = logger.messages.find(
        (m) => m.message === 'Maintenance failed for database',
      );
      expect(errorMsg).toBeDefined();
    });

    it('should isolate errors — succeeding databases still succeed', async () => {
      const logger = createCollectingLogger();

      // Spy on db.exec to make it fail for the second call only
      const originalExec = db.exec.bind(db);
      vi.spyOn(db, 'exec').mockImplementation(
        (dbName: Parameters<typeof db.exec>[0], sql: string) => {
          // Fail on sentinel (calls 3 and 4 are for sentinel ANALYZE and VACUUM)
          if (dbName === 'sentinel') {
            return Promise.reject(new Error('Simulated failure'));
          }
          return originalExec(dbName, sql);
        },
      );

      maintenance = new BasicMaintenance({
        db,
        logger,
        databases: ['meridian', 'sentinel'],
      });

      const result = await maintenance.runMaintenance();

      expect(result.succeeded).toContain('meridian');
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.db).toBe('sentinel');
      expect(result.failed[0]?.error).toContain('Simulated failure');

      vi.restoreAllMocks();
    });
  });

  describe('periodic scheduling', () => {
    it('should schedule periodic maintenance with the configured interval', async () => {
      vi.useFakeTimers();

      const logger = createCollectingLogger();
      maintenance = new BasicMaintenance({
        db,
        logger,
        databases: ['meridian'],
        intervalMs: 1_000, // 1 second for testing
      });

      await maintenance.start();

      // Count initial "Maintenance run complete" messages
      const initialCount = logger.messages.filter(
        (m) => m.message === 'Maintenance run complete',
      ).length;
      expect(initialCount).toBe(1);

      // Advance timer by the interval
      await vi.advanceTimersByTimeAsync(1_000);

      const afterCount = logger.messages.filter(
        (m) => m.message === 'Maintenance run complete',
      ).length;
      expect(afterCount).toBe(2);

      vi.useRealTimers();
    });
  });
});
