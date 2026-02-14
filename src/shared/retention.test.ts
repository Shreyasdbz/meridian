// Data retention tests (Phase 10.6)

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DatabaseClient } from './database/index.js';
import { applyRetention, computeCutoffDate } from './retention.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let db: DatabaseClient;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-retention-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  db = new DatabaseClient({ dataDir: testDir, direct: true });
  await db.start();

  // Create necessary tables in meridian.db
  await db.exec('meridian', `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_log (
      execution_id TEXT PRIMARY KEY,
      job_id TEXT,
      step_id TEXT,
      status TEXT,
      result_json TEXT,
      started_at TEXT,
      completed_at TEXT
    );
  `);

  // Create necessary tables in journal.db
  await db.exec('journal', `
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      content TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
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
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeCutoffDate', () => {
  it('should compute a date in the past', () => {
    const now = new Date('2026-02-14T00:00:00.000Z');
    const cutoff = computeCutoffDate(30, now);
    expect(cutoff).toBe(new Date('2026-01-15T00:00:00.000Z').toISOString());
  });

  it('should handle 0 days (returns now)', () => {
    const now = new Date('2026-02-14T12:00:00.000Z');
    const cutoff = computeCutoffDate(0, now);
    expect(cutoff).toBe(now.toISOString());
  });

  it('should handle 90 days', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const cutoff = computeCutoffDate(90, now);
    const expected = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(cutoff).toBe(expected.toISOString());
  });
});

describe('applyRetention', () => {
  describe('conversation archival', () => {
    it('should archive conversations older than the retention period', async () => {
      const now = new Date().toISOString();
      await db.run('meridian', `INSERT INTO conversations VALUES (?, ?, ?, ?, ?)`,
        ['conv-old', 'Old', 'active', daysAgo(100), now]);
      await db.run('meridian', `INSERT INTO conversations VALUES (?, ?, ?, ?, ?)`,
        ['conv-new', 'New', 'active', daysAgo(10), now]);

      const result = await applyRetention({ db, conversationDays: 90 });

      expect(result.conversationsArchived).toBe(1);

      // Old conversation should be archived
      const rows = await db.query<{ status: string }>('meridian',
        `SELECT status FROM conversations WHERE id = 'conv-old'`);
      expect(rows[0]?.status).toBe('archived');

      // New conversation should be untouched
      const newRows = await db.query<{ status: string }>('meridian',
        `SELECT status FROM conversations WHERE id = 'conv-new'`);
      expect(newRows[0]?.status).toBe('active');
    });

    it('should not re-archive already archived conversations', async () => {
      const now = new Date().toISOString();
      await db.run('meridian', `INSERT INTO conversations VALUES (?, ?, ?, ?, ?)`,
        ['conv-already', 'Already Archived', 'archived', daysAgo(200), now]);

      const result = await applyRetention({ db, conversationDays: 90 });
      expect(result.conversationsArchived).toBe(0);
    });

    it('should use custom retention period', async () => {
      const now = new Date().toISOString();
      await db.run('meridian', `INSERT INTO conversations VALUES (?, ?, ?, ?, ?)`,
        ['conv-custom', 'Custom', 'active', daysAgo(10), now]);

      // With 5-day retention, should be archived
      const result = await applyRetention({ db, conversationDays: 5 });
      expect(result.conversationsArchived).toBe(1);
    });
  });

  describe('episodic memory archival', () => {
    it('should archive old episodes', async () => {
      await db.run('journal', `INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?)`,
        ['ep-old', null, 'Old episode', null, daysAgo(100), null]);
      await db.run('journal', `INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?)`,
        ['ep-new', null, 'New episode', null, daysAgo(10), null]);

      const result = await applyRetention({ db, episodicDays: 90 });
      expect(result.episodesArchived).toBe(1);

      // Old episode should have archived_at set
      const rows = await db.query<{ archived_at: string | null }>('journal',
        `SELECT archived_at FROM episodes WHERE id = 'ep-old'`);
      expect(rows[0]?.archived_at).toBeTruthy();

      // New episode should be untouched
      const newRows = await db.query<{ archived_at: string | null }>('journal',
        `SELECT archived_at FROM episodes WHERE id = 'ep-new'`);
      expect(newRows[0]?.archived_at).toBeNull();
    });

    it('should not re-archive already archived episodes', async () => {
      await db.run('journal', `INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?)`,
        ['ep-already', null, 'Already archived', null, daysAgo(200), daysAgo(50)]);

      const result = await applyRetention({ db, episodicDays: 90 });
      expect(result.episodesArchived).toBe(0);
    });
  });

  describe('execution log purging', () => {
    it('should purge old completed execution logs', async () => {
      await db.run('meridian', `INSERT INTO execution_log VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['exec-old', 'job-1', 'step-1', 'completed', null, daysAgo(40), daysAgo(40)]);
      await db.run('meridian', `INSERT INTO execution_log VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['exec-new', 'job-2', 'step-1', 'completed', null, daysAgo(5), daysAgo(5)]);

      const result = await applyRetention({ db, executionLogDays: 30 });
      expect(result.executionLogsPurged).toBe(1);

      // Old log should be gone
      const rows = await db.query<{ execution_id: string }>('meridian',
        `SELECT execution_id FROM execution_log`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.execution_id).toBe('exec-new');
    });

    it('should not purge logs without completed_at', async () => {
      await db.run('meridian', `INSERT INTO execution_log VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['exec-running', 'job-1', 'step-1', 'running', null, daysAgo(40), null]);

      const result = await applyRetention({ db, executionLogDays: 30 });
      expect(result.executionLogsPurged).toBe(0);
    });
  });

  describe('combined retention', () => {
    it('should handle empty databases gracefully', async () => {
      const result = await applyRetention({ db });

      expect(result.conversationsArchived).toBe(0);
      expect(result.episodesArchived).toBe(0);
      expect(result.executionLogsPurged).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should be idempotent', async () => {
      const now = new Date().toISOString();
      await db.run('meridian', `INSERT INTO conversations VALUES (?, ?, ?, ?, ?)`,
        ['conv-1', 'Test', 'active', daysAgo(100), now]);

      const first = await applyRetention({ db, conversationDays: 90 });
      expect(first.conversationsArchived).toBe(1);

      const second = await applyRetention({ db, conversationDays: 90 });
      expect(second.conversationsArchived).toBe(0);
    });
  });
});
