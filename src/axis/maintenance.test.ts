// Idle maintenance tests (Phase 10.6)

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DatabaseClient } from '@meridian/shared';

import { IdleMaintenance } from './maintenance.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let db: DatabaseClient;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-maintenance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  db = new DatabaseClient({ dataDir: testDir, direct: true });
  await db.start();

  // Create minimal tables needed for retention tests
  await db.exec('meridian', `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS execution_log (
      execution_id TEXT PRIMARY KEY,
      job_id TEXT,
      status TEXT,
      completed_at TEXT
    );
  `);

  await db.exec('journal', `
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      content TEXT,
      created_at TEXT,
      archived_at TEXT
    );
  `);
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
// Tests
// ---------------------------------------------------------------------------

describe('IdleMaintenance', () => {
  describe('idle check', () => {
    it('should skip maintenance when system is not idle', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(false),
      });

      const result = await maintenance.runMaintenance();
      expect(result.skipped).toBe(true);
      expect(result.analyzeSucceeded).toHaveLength(0);
    });

    it('should run maintenance when system is idle', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
      });

      const result = await maintenance.runMaintenance();
      expect(result.skipped).toBe(false);
      expect(result.analyzeSucceeded.length).toBeGreaterThan(0);
    });

    it('should skip if idle check throws', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.reject(new Error('check failed')),
      });

      const result = await maintenance.runMaintenance();
      expect(result.skipped).toBe(true);
    });
  });

  describe('basic maintenance', () => {
    it('should run ANALYZE on all default databases', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
      });

      const result = await maintenance.runMaintenance();
      expect(result.analyzeSucceeded).toContain('meridian');
      expect(result.analyzeSucceeded).toContain('journal');
      expect(result.analyzeSucceeded).toContain('sentinel');
    });

    it('should run on custom database list', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        databases: ['meridian'],
      });

      const result = await maintenance.runMaintenance();
      expect(result.analyzeSucceeded).toContain('meridian');
      expect(result.analyzeSucceeded).not.toContain('journal');
    });
  });

  describe('FTS rebuild', () => {
    it('should rebuild FTS on first run', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
      });

      const result = await maintenance.runMaintenance();
      expect(result.ftsRebuilt).toBe(true);
    });

    it('should not rebuild FTS on immediate second run', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
      });

      await maintenance.runMaintenance();
      const result2 = await maintenance.runMaintenance();
      // FTS was already rebuilt recently, should skip
      expect(result2.ftsRebuilt).toBe(false);
    });
  });

  describe('staged memory promotion', () => {
    it('should call promoteStagedMemories callback', async () => {
      const promoter = vi.fn().mockResolvedValue(3);

      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        promoteStagedMemories: promoter,
      });

      const result = await maintenance.runMaintenance();
      expect(promoter).toHaveBeenCalledOnce();
      expect(result.stagedMemoriesPromoted).toBe(3);
    });

    it('should handle promoter failure gracefully', async () => {
      const promoter = vi.fn().mockRejectedValue(new Error('promotion failed'));

      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        promoteStagedMemories: promoter,
      });

      const result = await maintenance.runMaintenance();
      expect(result.stagedMemoriesPromoted).toBe(0);
    });

    it('should skip promotion if callback not provided', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
      });

      const result = await maintenance.runMaintenance();
      expect(result.stagedMemoriesPromoted).toBe(0);
    });
  });

  describe('sentinel pruning', () => {
    it('should call pruneSentinelExpired callback', async () => {
      const pruner = vi.fn().mockResolvedValue(5);

      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        pruneSentinelExpired: pruner,
      });

      const result = await maintenance.runMaintenance();
      expect(pruner).toHaveBeenCalledOnce();
      expect(result.sentinelDecisionsPruned).toBe(5);
    });

    it('should handle pruner failure gracefully', async () => {
      const pruner = vi.fn().mockRejectedValue(new Error('prune failed'));

      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        pruneSentinelExpired: pruner,
      });

      const result = await maintenance.runMaintenance();
      expect(result.sentinelDecisionsPruned).toBe(0);
    });
  });

  describe('backup creation', () => {
    it('should call createBackup callback', async () => {
      const backup = vi.fn().mockResolvedValue(undefined);

      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        createBackup: backup,
      });

      const result = await maintenance.runMaintenance();
      expect(backup).toHaveBeenCalledOnce();
      expect(result.backupCreated).toBe(true);
    });

    it('should handle backup failure gracefully', async () => {
      const backup = vi.fn().mockRejectedValue(new Error('backup failed'));

      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        createBackup: backup,
      });

      const result = await maintenance.runMaintenance();
      expect(result.backupCreated).toBe(false);
    });
  });

  describe('retention enforcement', () => {
    it('should run retention during maintenance', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
      });

      const result = await maintenance.runMaintenance();
      expect(result.retention).toBeDefined();
      const retention = result.retention as NonNullable<typeof result.retention>;
      expect(retention.conversationsArchived).toBe(0);
    });
  });

  describe('lifecycle', () => {
    it('should start and stop the scheduler', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        intervalMs: 60_000,
      });

      expect(maintenance.isRunning()).toBe(false);

      await maintenance.start();
      expect(maintenance.isRunning()).toBe(true);
      expect(maintenance.getLastRunAt()).toBeDefined();

      maintenance.stop();
      expect(maintenance.isRunning()).toBe(false);
    });

    it('should not start twice', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
        intervalMs: 60_000,
      });

      const first = await maintenance.start();
      const second = await maintenance.start();

      expect(first.skipped).toBe(false);
      expect(second.skipped).toBe(true);

      maintenance.stop();
    });

    it('should be safe to stop when not started', () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
      });

      expect(() => { maintenance.stop(); }).not.toThrow();
    });

    it('should report duration', async () => {
      const maintenance = new IdleMaintenance({
        db,
        isIdle: () => Promise.resolve(true),
      });

      const result = await maintenance.runMaintenance();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
