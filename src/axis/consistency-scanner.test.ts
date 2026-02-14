/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { ConsistencyScanner } from './consistency-scanner.js';
import type {
  ConsistencyScannerConfig,
  ConsistencyScannerLogger,
} from './consistency-scanner.js';

// ---------------------------------------------------------------------------
// Mock DatabaseClient
// ---------------------------------------------------------------------------

interface MockDatabaseClient {
  query: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDatabaseClient {
  return {
    query: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Collecting logger
// ---------------------------------------------------------------------------

function createCollectingLogger(): ConsistencyScannerLogger & {
  messages: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
} {
  const messages: Array<{
    level: string;
    message: string;
    data?: Record<string, unknown>;
  }> = [];
  return {
    messages,
    info: (message, data) => {
      messages.push({ level: 'info', message, data });
    },
    warn: (message, data) => {
      messages.push({ level: 'warn', message, data });
    },
    error: (message, data) => {
      messages.push({ level: 'error', message, data });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsistencyScanner', () => {
  let mockDb: MockDatabaseClient;
  let logger: ReturnType<typeof createCollectingLogger>;
  let scanner: ConsistencyScanner;

  beforeEach(() => {
    mockDb = createMockDb();
    logger = createCollectingLogger();
    scanner = new ConsistencyScanner({
      db: mockDb as unknown as ConsistencyScannerConfig['db'],
      logger,
    });
  });

  describe('scan with no issues', () => {
    it('should return zero issues when all queries return empty', async () => {
      const result = await scanner.scan();

      expect(result.issueCount).toBe(0);
      expect(result.issues).toHaveLength(0);
      expect(result.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should call all three check queries', async () => {
      await scanner.scan();

      expect(mockDb.query).toHaveBeenCalledTimes(3);

      const calls = mockDb.query.mock.calls as string[][];
      expect(calls[0]![0]).toBe('meridian');
      expect(calls[0]![1]).toContain('execution_log');
      expect(calls[1]![0]).toBe('meridian');
      expect(calls[1]![1]).toContain('messages');
      expect(calls[2]![0]).toBe('meridian');
      expect(calls[2]![1]).toContain('jobs');
    });
  });

  describe('scan with orphaned execution_log entries', () => {
    it('should report orphaned execution_log entries', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { execution_id: 'exec-001', job_id: 'job-missing-1' },
          { execution_id: 'exec-002', job_id: 'job-missing-2' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await scanner.scan();

      expect(result.issueCount).toBe(2);
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0]).toEqual({
        type: 'orphaned_execution_log',
        table: 'execution_log',
        recordId: 'exec-001',
        details: 'execution_log entry exec-001 references non-existent job job-missing-1',
      });
      expect(result.issues[1]).toEqual({
        type: 'orphaned_execution_log',
        table: 'execution_log',
        recordId: 'exec-002',
        details: 'execution_log entry exec-002 references non-existent job job-missing-2',
      });
    });
  });

  describe('scan with orphaned messages', () => {
    it('should report orphaned messages', async () => {
      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'msg-001', conversation_id: 'conv-missing-1' },
        ])
        .mockResolvedValueOnce([]);

      const result = await scanner.scan();

      expect(result.issueCount).toBe(1);
      expect(result.issues[0]).toEqual({
        type: 'orphaned_message',
        table: 'messages',
        recordId: 'msg-001',
        details: 'message msg-001 references non-existent conversation conv-missing-1',
      });
    });
  });

  describe('scan with orphaned job references', () => {
    it('should report orphaned job references', async () => {
      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'job-child-1', parent_id: 'job-parent-missing' },
        ]);

      const result = await scanner.scan();

      expect(result.issueCount).toBe(1);
      expect(result.issues[0]).toEqual({
        type: 'orphaned_job_reference',
        table: 'jobs',
        recordId: 'job-child-1',
        details: 'job job-child-1 references non-existent parent job job-parent-missing',
      });
    });
  });

  describe('scan with multiple issue types simultaneously', () => {
    it('should aggregate issues from all checks', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { execution_id: 'exec-orphan', job_id: 'job-gone' },
        ])
        .mockResolvedValueOnce([
          { id: 'msg-orphan', conversation_id: 'conv-gone' },
        ])
        .mockResolvedValueOnce([
          { id: 'job-child', parent_id: 'job-parent-gone' },
        ]);

      const result = await scanner.scan();

      expect(result.issueCount).toBe(3);
      expect(result.issues).toHaveLength(3);

      const types = result.issues.map((i) => i.type);
      expect(types).toContain('orphaned_execution_log');
      expect(types).toContain('orphaned_message');
      expect(types).toContain('orphaned_job_reference');
    });
  });

  describe('duration tracking', () => {
    it('should track scan duration in milliseconds', async () => {
      const result = await scanner.scan();

      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('logging', () => {
    it('should log warnings for each issue found', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { execution_id: 'exec-orphan', job_id: 'job-gone' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await scanner.scan();

      const warnings = logger.messages.filter((m) => m.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toBe('Consistency issue found');
      expect(warnings[0]!.data).toEqual({
        type: 'orphaned_execution_log',
        table: 'execution_log',
        recordId: 'exec-orphan',
        details: 'execution_log entry exec-orphan references non-existent job job-gone',
      });
    });

    it('should log multiple warnings when multiple issues found', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { execution_id: 'exec-1', job_id: 'job-1' },
          { execution_id: 'exec-2', job_id: 'job-2' },
        ])
        .mockResolvedValueOnce([
          { id: 'msg-1', conversation_id: 'conv-1' },
        ])
        .mockResolvedValueOnce([]);

      await scanner.scan();

      const warnings = logger.messages.filter((m) => m.level === 'warn');
      expect(warnings).toHaveLength(3);
    });

    it('should log a summary after scan completes', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { execution_id: 'exec-1', job_id: 'job-1' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await scanner.scan();

      const summaryMsg = logger.messages.find(
        (m) => m.level === 'info' && m.message === 'Consistency scan complete',
      );
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.data?.issueCount).toBe(1);
      expect(typeof summaryMsg?.data?.durationMs).toBe('number');
    });

    it('should log summary with zero issues when clean', async () => {
      await scanner.scan();

      const summaryMsg = logger.messages.find(
        (m) => m.level === 'info' && m.message === 'Consistency scan complete',
      );
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.data?.issueCount).toBe(0);
    });

    it('should not log any warnings when no issues found', async () => {
      await scanner.scan();

      const warnings = logger.messages.filter((m) => m.level === 'warn');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('default logger', () => {
    it('should work without a logger provided', async () => {
      const scannerNoLogger = new ConsistencyScanner({
        db: mockDb as unknown as ConsistencyScannerConfig['db'],
      });

      const result = await scannerNoLogger.scan();

      expect(result.issueCount).toBe(0);
      expect(result.issues).toHaveLength(0);
    });
  });
});
