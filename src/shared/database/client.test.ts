import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseClient } from './client.js';

// Use a unique temp directory per test run
const TEST_DIR = join(tmpdir(), `meridian-db-test-${Date.now()}`);

describe('DatabaseClient', () => {
  let client: DatabaseClient;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    client = new DatabaseClient({ dataDir: TEST_DIR, tier: 'desktop', direct: true });
    await client.start();
  });

  afterEach(async () => {
    await client.close();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('lifecycle', () => {
    it('should start and close without errors', async () => {
      await client.close();
      // Double-close should be safe
      await client.close();
    });

    it('should reject operations before start', async () => {
      const unstartedClient = new DatabaseClient({ dataDir: TEST_DIR, direct: true });
      await expect(unstartedClient.query('meridian', 'SELECT 1')).rejects.toThrow('not started');
    });
  });

  describe('query', () => {
    it('should execute read queries', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      await client.run('meridian', 'INSERT INTO test (id, name) VALUES (?, ?)', [1, 'alice']);

      const rows = await client.query<{ id: number; name: string }>(
        'meridian',
        'SELECT * FROM test WHERE id = ?',
        [1],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ id: 1, name: 'alice' });
    });

    it('should return empty array for no results', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER PRIMARY KEY)');

      const rows = await client.query<{ id: number }>('meridian', 'SELECT * FROM test');

      expect(rows).toHaveLength(0);
    });

    it('should support parameterized queries', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER, value TEXT)');
      await client.run('meridian', 'INSERT INTO test VALUES (?, ?)', [1, 'hello']);
      await client.run('meridian', 'INSERT INTO test VALUES (?, ?)', [2, 'world']);

      const rows = await client.query<{ id: number; value: string }>(
        'meridian',
        'SELECT * FROM test WHERE value = ?',
        ['world'],
      );

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      expect(row?.id).toBe(2);
    });
  });

  describe('run', () => {
    it('should return changes count for INSERT', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');

      const result = await client.run('meridian', 'INSERT INTO test (id, name) VALUES (?, ?)', [
        1,
        'bob',
      ]);

      expect(result.changes).toBe(1);
    });

    it('should return changes count for UPDATE', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER, status TEXT)');
      await client.run('meridian', 'INSERT INTO test VALUES (1, ?)', ['active']);
      await client.run('meridian', 'INSERT INTO test VALUES (2, ?)', ['active']);

      const result = await client.run('meridian', 'UPDATE test SET status = ? WHERE status = ?', [
        'inactive',
        'active',
      ]);

      expect(result.changes).toBe(2);
    });

    it('should return lastInsertRowid', async () => {
      await client.exec(
        'meridian',
        'CREATE TABLE test (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
      );

      const result = await client.run('meridian', 'INSERT INTO test (name) VALUES (?)', ['test']);

      expect(result.lastInsertRowid).toBe(1);
    });
  });

  describe('exec', () => {
    it('should execute raw SQL statements', async () => {
      await client.exec(
        'meridian',
        `
        CREATE TABLE test1 (id INTEGER);
        CREATE TABLE test2 (id INTEGER);
      `,
      );

      const rows = await client.query<{ name: string }>(
        'meridian',
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'test%' ORDER BY name",
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]?.name).toBe('test1');
      expect(rows[1]?.name).toBe('test2');
    });
  });

  describe('transaction', () => {
    it('should commit on success', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER, name TEXT)');

      await client.transaction('meridian', async () => {
        await client.run('meridian', 'INSERT INTO test VALUES (?, ?)', [1, 'alice']);
        await client.run('meridian', 'INSERT INTO test VALUES (?, ?)', [2, 'bob']);
      });

      const rows = await client.query<{ id: number }>('meridian', 'SELECT * FROM test');
      expect(rows).toHaveLength(2);
    });

    it('should rollback on error', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER, name TEXT)');

      await expect(
        client.transaction('meridian', async () => {
          await client.run('meridian', 'INSERT INTO test VALUES (?, ?)', [1, 'alice']);
          throw new Error('deliberate failure');
        }),
      ).rejects.toThrow('deliberate failure');

      const rows = await client.query<{ id: number }>('meridian', 'SELECT * FROM test');
      expect(rows).toHaveLength(0);
    });

    it('should allow reads inside a transaction to see uncommitted writes', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER, name TEXT)');

      await client.transaction('meridian', async () => {
        await client.run('meridian', 'INSERT INTO test VALUES (?, ?)', [1, 'inside']);

        const rows = await client.query<{ id: number; name: string }>(
          'meridian',
          'SELECT * FROM test',
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.name).toBe('inside');
      });
    });

    it('should return the result of the transaction function', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER)');

      const result = await client.transaction('meridian', async () => {
        await client.run('meridian', 'INSERT INTO test VALUES (?)', [42]);
        const rows = await client.query<{ id: number }>('meridian', 'SELECT * FROM test');
        return rows[0]?.id;
      });

      expect(result).toBe(42);
    });
  });

  describe('multiple databases', () => {
    it('should support operations on different databases', async () => {
      await client.exec('meridian', 'CREATE TABLE core_test (id INTEGER)');
      await client.exec('sentinel', 'CREATE TABLE sentinel_test (id INTEGER)');

      await client.run('meridian', 'INSERT INTO core_test VALUES (?)', [1]);
      await client.run('sentinel', 'INSERT INTO sentinel_test VALUES (?)', [2]);

      const coreRows = await client.query<{ id: number }>('meridian', 'SELECT * FROM core_test');
      const sentinelRows = await client.query<{ id: number }>(
        'sentinel',
        'SELECT * FROM sentinel_test',
      );

      expect(coreRows).toHaveLength(1);
      expect(sentinelRows).toHaveLength(1);
      expect(coreRows[0]?.id).toBe(1);
      expect(sentinelRows[0]?.id).toBe(2);
    });
  });

  describe('error handling', () => {
    it('should reject on invalid SQL', async () => {
      await expect(client.exec('meridian', 'INVALID SQL STATEMENT')).rejects.toThrow();
    });

    it('should reject on constraint violations', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER PRIMARY KEY)');
      await client.run('meridian', 'INSERT INTO test VALUES (?)', [1]);

      await expect(client.run('meridian', 'INSERT INTO test VALUES (?)', [1])).rejects.toThrow();
    });
  });

  describe('backup', () => {
    it('should create a backup via VACUUM INTO', async () => {
      await client.exec('meridian', 'CREATE TABLE test (id INTEGER)');
      await client.run('meridian', 'INSERT INTO test VALUES (?)', [1]);

      const backupPath = join(TEST_DIR, 'meridian-backup.db');
      await client.backup('meridian', backupPath);

      expect(existsSync(backupPath)).toBe(true);
    });
  });
});
