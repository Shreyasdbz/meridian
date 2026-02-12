import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseClient } from './client.js';
import { discoverMigrations, getCurrentVersion, migrate, migrateAll } from './migrator.js';
import type { DatabaseName } from './types.js';

const TEST_DIR = join(tmpdir(), `meridian-migrator-test-${Date.now()}`);
const DATA_DIR = join(TEST_DIR, 'data');
const PROJECT_ROOT = join(TEST_DIR, 'project');

function createMigrationFile(module: string, name: string, sql: string): void {
  const dir = join(PROJECT_ROOT, 'src', module, 'migrations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), sql, 'utf-8');
}

describe('migrator', () => {
  let client: DatabaseClient;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(PROJECT_ROOT, { recursive: true });

    client = new DatabaseClient({ dataDir: DATA_DIR, tier: 'desktop', direct: true });
    await client.start();
  });

  afterEach(async () => {
    await client.close();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('discoverMigrations', () => {
    it('should discover SQL migration files in order', () => {
      createMigrationFile('axis', '001_initial.sql', 'CREATE TABLE test1 (id INTEGER);');
      createMigrationFile('axis', '002_add_column.sql', 'ALTER TABLE test1 ADD COLUMN name TEXT;');

      const migrations = discoverMigrations('meridian', PROJECT_ROOT, {
        meridian: 'src/axis/migrations',
      });

      expect(migrations).toHaveLength(2);
      expect(migrations[0]?.version).toBe(1);
      expect(migrations[0]?.name).toBe('001_initial.sql');
      expect(migrations[1]?.version).toBe(2);
      expect(migrations[1]?.name).toBe('002_add_column.sql');
    });

    it('should ignore non-migration files', () => {
      const dir = join(PROJECT_ROOT, 'src', 'axis', 'migrations');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '001_initial.sql'), 'CREATE TABLE t (id INTEGER);');
      writeFileSync(join(dir, 'README.md'), '# Migrations');
      writeFileSync(join(dir, 'notes.txt'), 'Some notes');

      const migrations = discoverMigrations('meridian', PROJECT_ROOT, {
        meridian: 'src/axis/migrations',
      });

      expect(migrations).toHaveLength(1);
    });

    it('should return empty array for non-existent directory', () => {
      const migrations = discoverMigrations('meridian', PROJECT_ROOT, {
        meridian: 'src/nonexistent/migrations',
      });

      expect(migrations).toHaveLength(0);
    });

    it('should read SQL content from files', () => {
      const sql = 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);';
      createMigrationFile('axis', '001_items.sql', sql);

      const migrations = discoverMigrations('meridian', PROJECT_ROOT, {
        meridian: 'src/axis/migrations',
      });

      expect(migrations[0]?.sql).toBe(sql);
    });
  });

  describe('getCurrentVersion', () => {
    it('should return 0 when no migrations have been applied', async () => {
      const version = await getCurrentVersion(client, 'meridian');
      expect(version).toBe(0);
    });

    it('should return the latest applied version', async () => {
      createMigrationFile('axis', '001_initial.sql', 'CREATE TABLE t1 (id INTEGER);');
      createMigrationFile('axis', '002_second.sql', 'CREATE TABLE t2 (id INTEGER);');

      await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
      });

      const version = await getCurrentVersion(client, 'meridian');
      expect(version).toBe(2);
    });
  });

  describe('migrate', () => {
    it('should apply pending migrations in order', async () => {
      createMigrationFile(
        'axis',
        '001_initial.sql',
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
      );
      createMigrationFile('axis', '002_add_email.sql', 'ALTER TABLE users ADD COLUMN email TEXT;');

      const result = await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
      });

      expect(result.database).toBe('meridian');
      expect(result.applied).toEqual([1, 2]);
      expect(result.currentVersion).toBe(2);

      const rows = await client.query<{ name: string }>(
        'meridian',
        "SELECT name FROM pragma_table_info('users')",
      );
      const columnNames = rows.map((r) => r.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('name');
      expect(columnNames).toContain('email');
    });

    it('should skip already-applied migrations (idempotency)', async () => {
      createMigrationFile('axis', '001_initial.sql', 'CREATE TABLE t1 (id INTEGER);');

      await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
      });

      createMigrationFile('axis', '002_second.sql', 'CREATE TABLE t2 (id INTEGER);');

      const result = await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
      });

      expect(result.applied).toEqual([2]);
      expect(result.currentVersion).toBe(2);
    });

    it('should return empty applied list when no pending migrations', async () => {
      createMigrationFile('axis', '001_initial.sql', 'CREATE TABLE t1 (id INTEGER);');

      await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
      });

      const result = await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
      });

      expect(result.applied).toEqual([]);
    });

    it('should rollback a failed migration and throw', async () => {
      createMigrationFile('axis', '001_initial.sql', 'CREATE TABLE t1 (id INTEGER);');
      createMigrationFile('axis', '002_bad.sql', 'INVALID SQL STATEMENT;');

      await expect(
        migrate(client, 'meridian', PROJECT_ROOT, {
          migrationDirs: { meridian: 'src/axis/migrations' },
        }),
      ).rejects.toThrow('Migration 002_bad.sql failed for meridian');

      const version = await getCurrentVersion(client, 'meridian');
      expect(version).toBe(1);

      const rows = await client.query<{ name: string }>(
        'meridian',
        "SELECT name FROM sqlite_master WHERE type='table' AND name='t1'",
      );
      expect(rows).toHaveLength(1);
    });

    it('should record applied migrations in schema_version table', async () => {
      createMigrationFile('axis', '001_initial.sql', 'CREATE TABLE t1 (id INTEGER);');

      await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
      });

      const rows = await client.query<{ version: number; name: string }>(
        'meridian',
        'SELECT version, name FROM schema_version ORDER BY version',
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe(1);
      expect(rows[0]?.name).toBe('001_initial.sql');
    });

    it('should create pre-migration backup when backupDir is set', async () => {
      const backupDir = join(TEST_DIR, 'backups');
      mkdirSync(backupDir, { recursive: true });

      createMigrationFile('axis', '001_initial.sql', 'CREATE TABLE t1 (id INTEGER);');

      await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
        backupDir,
      });

      createMigrationFile('axis', '002_second.sql', 'CREATE TABLE t2 (id INTEGER);');

      await migrate(client, 'meridian', PROJECT_ROOT, {
        migrationDirs: { meridian: 'src/axis/migrations' },
        backupDir,
      });

      const backups = readdirSync(backupDir).filter((f) => f.startsWith('meridian-pre-migration'));
      expect(backups.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('migrateAll', () => {
    it('should migrate multiple databases', async () => {
      createMigrationFile('axis', '001_initial.sql', 'CREATE TABLE core (id INTEGER);');
      createMigrationFile('sentinel', '001_initial.sql', 'CREATE TABLE decisions (id INTEGER);');

      const auditDir = join(PROJECT_ROOT, 'src', 'shared', 'database', 'migrations', 'audit');
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(join(auditDir, '001_initial.sql'), 'CREATE TABLE audit_entries (id INTEGER);');

      const results = await migrateAll(client, PROJECT_ROOT, {
        migrationDirs: {
          meridian: 'src/axis/migrations',
          sentinel: 'src/sentinel/migrations',
          audit: 'src/shared/database/migrations/audit',
        },
        databases: ['meridian', 'sentinel', 'audit'] as DatabaseName[],
      });

      expect(results).toHaveLength(3);
      expect(results[0]?.database).toBe('meridian');
      expect(results[0]?.applied).toEqual([1]);
      expect(results[1]?.database).toBe('sentinel');
      expect(results[1]?.applied).toEqual([1]);
      expect(results[2]?.database).toBe('audit');
      expect(results[2]?.applied).toEqual([1]);
    });
  });
});
