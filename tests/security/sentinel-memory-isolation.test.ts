// Security test: Sentinel Memory isolation (Phase 10.3)
//
// Verifies that:
// 1. Shell commands are excluded from Sentinel Memory
// 2. Sentinel's database is isolated from Journal/Scout
// 3. Expired decisions are not matched

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseClient, ValidationError } from '@meridian/shared';

import { SentinelMemory } from '../../src/sentinel/memory.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let sentinelDb: DatabaseClient;
let memory: SentinelMemory;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-sentinel-iso-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  sentinelDb = new DatabaseClient({ dataDir: testDir, direct: true });
  await sentinelDb.start();
  await sentinelDb.open('sentinel');

  await sentinelDb.exec('sentinel', `
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('allow', 'deny')),
      job_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      conditions TEXT,
      metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_action_scope ON decisions(action_type, scope);
    CREATE INDEX IF NOT EXISTS idx_decisions_expires ON decisions(expires_at) WHERE expires_at IS NOT NULL;
  `);

  memory = new SentinelMemory({ db: sentinelDb });
});

afterEach(async () => {
  await sentinelDb.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Security tests
// ---------------------------------------------------------------------------

describe('Sentinel Memory isolation', () => {
  describe('shell command exclusion', () => {
    it('should reject shell.execute from storage', async () => {
      await expect(
        memory.storeDecision({
          actionType: 'shell.execute',
          scope: 'rm -rf /',
          verdict: 'allow',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject shell.run from storage', async () => {
      await expect(
        memory.storeDecision({
          actionType: 'shell.run',
          scope: 'sudo anything',
          verdict: 'allow',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject shell.exec from storage', async () => {
      await expect(
        memory.storeDecision({
          actionType: 'shell.exec',
          scope: 'cat /etc/shadow',
          verdict: 'allow',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject shell commands even with deny verdict', async () => {
      await expect(
        memory.storeDecision({
          actionType: 'shell.execute',
          scope: 'ls',
          verdict: 'deny',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should allow non-shell action types', async () => {
      const decision = await memory.storeDecision({
        actionType: 'file.read',
        scope: '/safe/path',
        verdict: 'allow',
      });
      expect(decision.id).toBeTruthy();
    });
  });

  describe('database isolation', () => {
    it('should use sentinel database not journal or meridian', async () => {
      // Store a decision in sentinel.db
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data',
        verdict: 'allow',
      });

      // Verify it's in sentinel.db by querying directly
      const rows = await sentinelDb.query<{ count: number }>(
        'sentinel',
        'SELECT COUNT(*) as count FROM decisions',
      );
      expect((rows[0] as { count: number }).count).toBe(1);

      // Verify journal.db does NOT have a decisions table
      // (opening a separate journal db should not find sentinel data)
      const journalDb = new DatabaseClient({ dataDir: testDir, direct: true });
      await journalDb.start();
      await journalDb.open('journal');
      await journalDb.exec('journal', 'CREATE TABLE IF NOT EXISTS test_marker (id TEXT)');

      // The journal db should not have a decisions table
      const journalRows = await journalDb.query<{ name: string }>(
        'journal',
        "SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'",
      );
      expect(journalRows).toHaveLength(0);

      await journalDb.close();
    });
  });

  describe('expiry enforcement', () => {
    it('should not match expired decisions', async () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/workspace',
        verdict: 'allow',
        expiresAt: pastDate,
      });

      const result = await memory.findMatch('file.read', '/data/workspace/file.txt');
      expect(result.matched).toBe(false);
    });

    it('should match decisions with no expiry', async () => {
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/workspace',
        verdict: 'allow',
      });

      const result = await memory.findMatch('file.read', '/data/workspace/file.txt');
      expect(result.matched).toBe(true);
    });

    it('should match decisions with future expiry', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/workspace',
        verdict: 'allow',
        expiresAt: futureDate,
      });

      const result = await memory.findMatch('file.read', '/data/workspace/file.txt');
      expect(result.matched).toBe(true);
    });
  });
});
