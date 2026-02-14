// Data deletion tests (Phase 10.6)

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { deleteAllUserData } from './data-deletion.js';
import { DatabaseClient } from './database/index.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let db: DatabaseClient;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-deletion-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, 'workspace'), { recursive: true });

  db = new DatabaseClient({ dataDir: testDir, direct: true });
  await db.start();

  // Create tables in meridian.db
  await db.exec('meridian', `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      role TEXT,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS execution_log (
      execution_id TEXT PRIMARY KEY,
      job_id TEXT,
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth (
      id TEXT PRIMARY KEY,
      password_hash TEXT,
      created_at TEXT
    );
  `);

  // Create tables in journal.db
  await db.exec('journal', `
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS procedures (
      id TEXT PRIMARY KEY,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_staging (
      id TEXT PRIMARY KEY,
      content TEXT,
      staged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      memory_id TEXT,
      embedding BLOB
    );
  `);

  // Create tables in sentinel.db
  await db.exec('sentinel', `
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      action_type TEXT,
      verdict TEXT,
      created_at TEXT
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

async function seedData(): Promise<void> {
  const now = new Date().toISOString();

  // meridian.db
  await db.run('meridian', `INSERT INTO conversations VALUES (?, ?, ?, ?, ?)`,
    ['conv-1', 'Test Conv', 'active', now, now]);
  await db.run('meridian', `INSERT INTO messages VALUES (?, ?, ?, ?, ?)`,
    ['msg-1', 'conv-1', 'user', 'Hello', now]);
  await db.run('meridian', `INSERT INTO jobs VALUES (?, ?, ?)`,
    ['job-1', 'completed', now]);
  await db.run('meridian', `INSERT INTO execution_log VALUES (?, ?, ?)`,
    ['exec-1', 'job-1', 'completed']);
  await db.run('meridian', `INSERT INTO config VALUES (?, ?, ?)`,
    ['theme', 'dark', now]);
  await db.run('meridian', `INSERT INTO config VALUES (?, ?, ?)`,
    ['auth.method', 'password', now]);
  await db.run('meridian', `INSERT INTO sessions VALUES (?, ?, ?)`,
    ['sess-1', 'hash123', now]);
  await db.run('meridian', `INSERT INTO auth VALUES (?, ?, ?)`,
    ['admin', 'hashed-pw', now]);

  // journal.db
  await db.run('journal', `INSERT INTO episodes VALUES (?, ?, ?)`,
    ['ep-1', 'Episode content', now]);
  await db.run('journal', `INSERT INTO facts VALUES (?, ?, ?)`,
    ['fact-1', 'A fact', now]);
  await db.run('journal', `INSERT INTO procedures VALUES (?, ?, ?)`,
    ['proc-1', 'A procedure', now]);
  await db.run('journal', `INSERT INTO memory_staging VALUES (?, ?, ?)`,
    ['stage-1', 'Staged memory', now]);
  await db.run('journal', `INSERT INTO memory_embeddings VALUES (?, ?, ?)`,
    ['emb-1', 'ep-1', Buffer.alloc(32)]);

  // sentinel.db
  await db.run('sentinel', `INSERT INTO decisions VALUES (?, ?, ?, ?)`,
    ['dec-1', 'file.read', 'allow', now]);

  // workspace file
  writeFileSync(join(testDir, 'workspace', 'user-file.txt'), 'user data');
}

async function count(dbName: 'meridian' | 'journal' | 'sentinel', table: string): Promise<number> {
  const rows = await db.query<{ c: number }>(dbName, `SELECT COUNT(*) as c FROM ${table}`);
  return rows[0]?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deleteAllUserData', () => {
  it('should throw if confirm is not true', async () => {
    await expect(
      deleteAllUserData({ db, dataDir: testDir, confirm: false }),
    ).rejects.toThrow('confirm');
  });

  it('should delete all user data when confirmed', async () => {
    await seedData();

    const result = await deleteAllUserData({
      db,
      dataDir: testDir,
      confirm: true,
    });

    expect(result.executed).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // meridian.db should be cleared
    expect(await count('meridian', 'conversations')).toBe(0);
    expect(await count('meridian', 'messages')).toBe(0);
    expect(await count('meridian', 'jobs')).toBe(0);
    expect(await count('meridian', 'execution_log')).toBe(0);
    expect(await count('meridian', 'sessions')).toBe(0);

    // journal.db should be cleared
    expect(await count('journal', 'episodes')).toBe(0);
    expect(await count('journal', 'facts')).toBe(0);
    expect(await count('journal', 'procedures')).toBe(0);
    expect(await count('journal', 'memory_staging')).toBe(0);
    expect(await count('journal', 'memory_embeddings')).toBe(0);

    // sentinel.db should be cleared
    expect(await count('sentinel', 'decisions')).toBe(0);
  });

  it('should retain auth credentials', async () => {
    await seedData();

    await deleteAllUserData({ db, dataDir: testDir, confirm: true });

    // Auth should be preserved
    expect(await count('meridian', 'auth')).toBe(1);
  });

  it('should preserve auth-related config', async () => {
    await seedData();

    await deleteAllUserData({ db, dataDir: testDir, confirm: true });

    // auth.method config should be preserved
    const rows = await db.query<{ key: string }>('meridian',
      `SELECT key FROM config WHERE key LIKE 'auth.%'`);
    expect(rows).toHaveLength(1);

    // theme config should be deleted
    const themeRows = await db.query<{ key: string }>('meridian',
      `SELECT key FROM config WHERE key = 'theme'`);
    expect(themeRows).toHaveLength(0);
  });

  it('should clean workspace directory', async () => {
    await seedData();
    expect(existsSync(join(testDir, 'workspace', 'user-file.txt'))).toBe(true);

    await deleteAllUserData({ db, dataDir: testDir, confirm: true });

    // File should be deleted
    expect(existsSync(join(testDir, 'workspace', 'user-file.txt'))).toBe(false);
    // workspace dir itself should still exist
    expect(existsSync(join(testDir, 'workspace'))).toBe(true);
  });

  it('should report what was retained', async () => {
    await seedData();

    const result = await deleteAllUserData({
      db,
      dataDir: testDir,
      confirm: true,
    });

    expect(result.retained).toContain('audit logs (append-only)');
    expect(result.retained).toContain('auth credentials');
  });

  it('should handle empty databases gracefully', async () => {
    const result = await deleteAllUserData({
      db,
      dataDir: testDir,
      confirm: true,
    });

    expect(result.executed).toBe(true);
  });

  it('should handle missing workspace directory', async () => {
    rmSync(join(testDir, 'workspace'), { recursive: true, force: true });

    const result = await deleteAllUserData({
      db,
      dataDir: testDir,
      confirm: true,
    });

    expect(result.executed).toBe(true);
    expect(result.deleted.workspace).toBe(false);
  });
});
