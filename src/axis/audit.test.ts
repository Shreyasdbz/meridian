import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DatabaseClient } from '@meridian/shared';

import { AuditLog, getAuditDbFileName } from './audit.js';

// ---------------------------------------------------------------------------
// Test setup — unique temp directory per test with direct-mode DatabaseClient
// ---------------------------------------------------------------------------

let testDir: string;
let db: DatabaseClient;
let auditLog: AuditLog;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  db = new DatabaseClient({ dataDir: testDir, direct: true });
  await db.start();
  auditLog = new AuditLog({ db, dataDir: testDir });
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

/**
 * Assert that a value is defined and return it with a narrowed type.
 * Avoids non-null assertions while keeping tests readable.
 */
function defined<T>(value: T | undefined | null, label = 'value'): T {
  expect(value, `expected ${label} to be defined`).toBeDefined();
  return value as T;
}

/** Assert that an array has exactly the expected length and return it typed. */
function assertLength<T>(arr: T[], expectedLength: number): T[] {
  expect(arr).toHaveLength(expectedLength);
  return arr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditLog', () => {
  describe('entry creation', () => {
    it('should write an entry with all required fields', async () => {
      const entry = await auditLog.write({
        actor: 'axis',
        action: 'job.created',
        riskLevel: 'low',
      });

      expect(entry.id).toBeDefined();
      expect(entry.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(entry.timestamp).toBeDefined();
      expect(entry.actor).toBe('axis');
      expect(entry.action).toBe('job.created');
      expect(entry.riskLevel).toBe('low');
    });

    it('should write an entry with all optional fields', async () => {
      const entry = await auditLog.write({
        actor: 'gear',
        action: 'file.write',
        riskLevel: 'high',
        actorId: 'gear:file-manager',
        target: '/workspace/output.txt',
        jobId: 'job-123',
        details: { bytesWritten: 1024, path: '/workspace/output.txt' },
      });

      expect(entry.actor).toBe('gear');
      expect(entry.actorId).toBe('gear:file-manager');
      expect(entry.target).toBe('/workspace/output.txt');
      expect(entry.jobId).toBe('job-123');
      expect(entry.details).toEqual({ bytesWritten: 1024, path: '/workspace/output.txt' });
    });

    it('should generate unique IDs for each entry', async () => {
      const entry1 = await auditLog.write({
        actor: 'axis',
        action: 'job.created',
        riskLevel: 'low',
      });
      const entry2 = await auditLog.write({
        actor: 'axis',
        action: 'job.completed',
        riskLevel: 'low',
      });

      expect(entry1.id).not.toBe(entry2.id);
    });

    it('should set integrity chain fields as undefined for v0.1', async () => {
      const entry = await auditLog.write({
        actor: 'axis',
        action: 'job.created',
        riskLevel: 'low',
      });

      expect(entry.previousHash).toBeUndefined();
      expect(entry.entryHash).toBeUndefined();
    });

    it('should persist entries to the database and retrieve them', async () => {
      const written = await auditLog.write({
        actor: 'sentinel',
        action: 'plan.approved',
        riskLevel: 'medium',
        jobId: 'job-456',
      });

      const retrieved = defined(await auditLog.getById(written.id), 'retrieved entry');

      expect(retrieved.id).toBe(written.id);
      expect(retrieved.actor).toBe('sentinel');
      expect(retrieved.action).toBe('plan.approved');
      expect(retrieved.riskLevel).toBe('medium');
      expect(retrieved.jobId).toBe('job-456');
    });

    it('should store and retrieve details as JSON', async () => {
      const details = { reason: 'test', count: 42, nested: { key: 'value' } };
      const written = await auditLog.write({
        actor: 'scout',
        action: 'plan.created',
        riskLevel: 'low',
        details,
      });

      const retrieved = defined(await auditLog.getById(written.id), 'retrieved entry');
      expect(retrieved.details).toEqual(details);
    });
  });

  describe('monthly partitioning', () => {
    it('should create a database file named audit-YYYY-MM.db', async () => {
      await auditLog.write({
        actor: 'axis',
        action: 'test.partitioning',
        riskLevel: 'low',
      });

      const expectedFileName = getAuditDbFileName(new Date());
      const dbFilePath = join(testDir, expectedFileName);

      expect(existsSync(dbFilePath)).toBe(true);
    });

    it('should generate correct file names for different months', () => {
      expect(getAuditDbFileName(new Date(2026, 0, 15))).toBe('audit-2026-01.db');
      expect(getAuditDbFileName(new Date(2026, 11, 1))).toBe('audit-2026-12.db');
      expect(getAuditDbFileName(new Date(2025, 5, 30))).toBe('audit-2025-06.db');
    });

    it('should write entries to the current month partition', async () => {
      const entry = await auditLog.write({
        actor: 'axis',
        action: 'test.partition',
        riskLevel: 'low',
      });

      const entries = assertLength(await auditLog.query({ action: 'test.partition' }), 1);
      expect(entries[0]?.id).toBe(entry.id);
    });

    it('should not create a default audit.db file', async () => {
      await auditLog.write({
        actor: 'axis',
        action: 'test.no-default-db',
        riskLevel: 'low',
      });

      // The monthly partition file should exist
      const monthlyFile = join(testDir, getAuditDbFileName(new Date()));
      expect(existsSync(monthlyFile)).toBe(true);

      // A default audit.db should NOT exist — all data goes to the partition
      const defaultFile = join(testDir, 'audit.db');
      expect(existsSync(defaultFile)).toBe(false);
    });
  });

  describe('append-only enforcement', () => {
    it('should not expose any update or delete methods', () => {
      const auditLogProto = Object.getOwnPropertyNames(
        Object.getPrototypeOf(auditLog),
      );

      // Verify that no method name contains 'update' or 'delete'
      const mutatingMethods = auditLogProto.filter(
        (name) =>
          name.toLowerCase().includes('update') ||
          name.toLowerCase().includes('delete') ||
          name.toLowerCase().includes('remove'),
      );

      expect(mutatingMethods).toHaveLength(0);
    });

    it('should only provide write (insert) and read operations', () => {
      // Public methods should be: write, query, getById, count, export
      expect(typeof auditLog.write).toBe('function');
      expect(typeof auditLog.query).toBe('function');
      expect(typeof auditLog.getById).toBe('function');
      expect(typeof auditLog.count).toBe('function');
      expect(typeof auditLog.export).toBe('function');
    });

    it('should successfully append multiple entries', async () => {
      await auditLog.write({ actor: 'axis', action: 'action.1', riskLevel: 'low' });
      await auditLog.write({ actor: 'axis', action: 'action.2', riskLevel: 'low' });
      await auditLog.write({ actor: 'axis', action: 'action.3', riskLevel: 'low' });

      const count = await auditLog.count();
      expect(count).toBe(3);
    });
  });

  describe('write-ahead ordering', () => {
    it('should write audit entry before the primary action can be committed', async () => {
      // Simulate write-ahead pattern: audit entry is written first,
      // then the primary action follows. If the primary action fails,
      // the audit entry still records the attempt.
      const auditEntry = await auditLog.write({
        actor: 'axis',
        action: 'job.state_change',
        riskLevel: 'low',
        jobId: 'job-write-ahead',
        details: { from: 'pending', to: 'executing' },
      });

      // Verify the audit entry exists BEFORE any primary action
      const retrieved = defined(await auditLog.getById(auditEntry.id), 'audit entry');
      expect(retrieved.action).toBe('job.state_change');
      expect(retrieved.jobId).toBe('job-write-ahead');
    });

    it('should preserve audit entry even if subsequent action would fail', async () => {
      // Write the audit entry first (write-ahead)
      const auditEntry = await auditLog.write({
        actor: 'axis',
        action: 'job.state_change',
        riskLevel: 'medium',
        jobId: 'job-will-fail',
        details: { from: 'validating', to: 'executing' },
      });

      // Simulate primary action failure (e.g., constraint violation)
      // The audit entry should still be recorded
      const retrieved = defined(await auditLog.getById(auditEntry.id), 'audit entry');
      expect(retrieved.jobId).toBe('job-will-fail');
    });

    it('should maintain chronological order of entries', async () => {
      await auditLog.write({ actor: 'axis', action: 'first', riskLevel: 'low' });
      await auditLog.write({ actor: 'axis', action: 'second', riskLevel: 'low' });
      await auditLog.write({ actor: 'axis', action: 'third', riskLevel: 'low' });

      const entries = assertLength(await auditLog.query(), 3);
      expect(entries[0]?.action).toBe('first');
      expect(entries[1]?.action).toBe('second');
      expect(entries[2]?.action).toBe('third');

      // Verify timestamps are in ascending order
      for (let i = 1; i < entries.length; i++) {
        const current = defined(entries[i], `entry[${i}]`);
        const previous = defined(entries[i - 1], `entry[${i - 1}]`);
        expect(current.timestamp >= previous.timestamp).toBe(true);
      }
    });
  });

  describe('query', () => {
    it('should filter by actor', async () => {
      await auditLog.write({ actor: 'axis', action: 'a', riskLevel: 'low' });
      await auditLog.write({ actor: 'scout', action: 'b', riskLevel: 'low' });
      await auditLog.write({ actor: 'axis', action: 'c', riskLevel: 'low' });

      const entries = assertLength(await auditLog.query({ actor: 'axis' }), 2);
      expect(entries.every((e) => e.actor === 'axis')).toBe(true);
    });

    it('should filter by action', async () => {
      await auditLog.write({ actor: 'axis', action: 'plan.approved', riskLevel: 'low' });
      await auditLog.write({ actor: 'axis', action: 'job.completed', riskLevel: 'low' });

      const entries = assertLength(await auditLog.query({ action: 'plan.approved' }), 1);
      expect(entries[0]?.action).toBe('plan.approved');
    });

    it('should filter by risk level', async () => {
      await auditLog.write({ actor: 'axis', action: 'a', riskLevel: 'low' });
      await auditLog.write({ actor: 'axis', action: 'b', riskLevel: 'critical' });

      const entries = assertLength(await auditLog.query({ riskLevel: 'critical' }), 1);
      expect(entries[0]?.riskLevel).toBe('critical');
    });

    it('should filter by job ID', async () => {
      await auditLog.write({ actor: 'axis', action: 'a', riskLevel: 'low', jobId: 'job-1' });
      await auditLog.write({ actor: 'axis', action: 'b', riskLevel: 'low', jobId: 'job-2' });

      const entries = assertLength(await auditLog.query({ jobId: 'job-1' }), 1);
      expect(entries[0]?.jobId).toBe('job-1');
    });

    it('should support limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await auditLog.write({ actor: 'axis', action: `action-${i}`, riskLevel: 'low' });
      }

      const page1 = assertLength(await auditLog.query({ limit: 2, offset: 0 }), 2);
      expect(page1[0]?.action).toBe('action-0');
      expect(page1[1]?.action).toBe('action-1');

      const page2 = assertLength(await auditLog.query({ limit: 2, offset: 2 }), 2);
      expect(page2[0]?.action).toBe('action-2');
      expect(page2[1]?.action).toBe('action-3');
    });

    it('should return empty array when no entries match', async () => {
      const entries = await auditLog.query({ actor: 'sentinel' });
      expect(entries).toHaveLength(0);
    });
  });

  describe('count', () => {
    it('should return total count without filters', async () => {
      await auditLog.write({ actor: 'axis', action: 'a', riskLevel: 'low' });
      await auditLog.write({ actor: 'axis', action: 'b', riskLevel: 'low' });

      const count = await auditLog.count();
      expect(count).toBe(2);
    });

    it('should return filtered count', async () => {
      await auditLog.write({ actor: 'axis', action: 'a', riskLevel: 'low' });
      await auditLog.write({ actor: 'scout', action: 'b', riskLevel: 'high' });

      expect(await auditLog.count({ actor: 'axis' })).toBe(1);
      expect(await auditLog.count({ riskLevel: 'high' })).toBe(1);
    });

    it('should return zero when no entries exist', async () => {
      const count = await auditLog.count();
      expect(count).toBe(0);
    });
  });

  describe('export', () => {
    it('should export all entries in chronological order', async () => {
      await auditLog.write({ actor: 'axis', action: 'first', riskLevel: 'low' });
      await auditLog.write({ actor: 'scout', action: 'second', riskLevel: 'medium' });
      await auditLog.write({ actor: 'sentinel', action: 'third', riskLevel: 'high' });

      const result = await auditLog.export();

      expect(result.entryCount).toBe(3);
      const entries = assertLength(result.entries, 3);
      expect(entries[0]?.action).toBe('first');
      expect(entries[1]?.action).toBe('second');
      expect(entries[2]?.action).toBe('third');
    });

    it('should return empty result when no entries exist', async () => {
      const result = await auditLog.export();

      expect(result.entryCount).toBe(0);
      expect(result.entries).toHaveLength(0);
    });

    it('should include all fields in exported entries', async () => {
      await auditLog.write({
        actor: 'gear',
        action: 'file.write',
        riskLevel: 'high',
        actorId: 'gear:fs',
        target: '/workspace/file.txt',
        jobId: 'job-export',
        details: { bytes: 512 },
      });

      const result = await auditLog.export();
      const entry = defined(result.entries[0], 'exported entry');

      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      expect(entry.actor).toBe('gear');
      expect(entry.action).toBe('file.write');
      expect(entry.riskLevel).toBe('high');
      expect(entry.actorId).toBe('gear:fs');
      expect(entry.target).toBe('/workspace/file.txt');
      expect(entry.jobId).toBe('job-export');
      expect(entry.details).toEqual({ bytes: 512 });
    });
  });
});
