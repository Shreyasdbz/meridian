// @meridian/axis — Cross-DB consistency scanner (Section 9.6)
//
// Periodic scanner that checks for orphaned cross-DB references.
// Report-only mode — no automatic fixes. Each check uses a SQL LEFT JOIN
// query to find records that reference non-existent parent rows.

import type { DatabaseClient } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single consistency issue found during a scan.
 */
export interface ConsistencyIssue {
  type: 'orphaned_execution_log' | 'orphaned_message' | 'orphaned_job_reference';
  table: string;
  recordId: string;
  details: string;
}

/**
 * Result of a full consistency scan.
 */
export interface ConsistencyScanResult {
  scannedAt: string;
  issueCount: number;
  issues: ConsistencyIssue[];
  durationMs: number;
}

/**
 * Logger interface for consistency scan events.
 */
export interface ConsistencyScannerLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Configuration for the ConsistencyScanner.
 */
export interface ConsistencyScannerConfig {
  db: DatabaseClient;
  logger?: ConsistencyScannerLogger;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: ConsistencyScannerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// ConsistencyScanner
// ---------------------------------------------------------------------------

/**
 * Scans for orphaned cross-DB references in the Meridian core database.
 *
 * Checks performed:
 * 1. Orphaned execution_log entries — `execution_log.job_id` not in `jobs.id`
 * 2. Orphaned messages — `messages.conversation_id` not in `conversations.id`
 * 3. Orphaned job references — `jobs.parent_id` not null and not in `jobs.id`
 *
 * This is report-only: issues are returned and logged but never automatically
 * fixed. The caller decides how to handle them.
 */
export class ConsistencyScanner {
  private readonly db: DatabaseClient;
  private readonly logger: ConsistencyScannerLogger;

  constructor(config: ConsistencyScannerConfig) {
    this.db = config.db;
    this.logger = config.logger ?? noopLogger;
  }

  /**
   * Run all consistency checks and return results.
   */
  async scan(): Promise<ConsistencyScanResult> {
    const start = performance.now();
    const issues: ConsistencyIssue[] = [];

    const orphanedExecutionLogs = await this.checkOrphanedExecutionLogs();
    issues.push(...orphanedExecutionLogs);

    const orphanedMessages = await this.checkOrphanedMessages();
    issues.push(...orphanedMessages);

    const orphanedJobReferences = await this.checkOrphanedJobReferences();
    issues.push(...orphanedJobReferences);

    const durationMs = Math.round(performance.now() - start);

    for (const issue of issues) {
      this.logger.warn('Consistency issue found', {
        type: issue.type,
        table: issue.table,
        recordId: issue.recordId,
        details: issue.details,
      });
    }

    const result: ConsistencyScanResult = {
      scannedAt: new Date().toISOString(),
      issueCount: issues.length,
      issues,
      durationMs,
    };

    this.logger.info('Consistency scan complete', {
      issueCount: result.issueCount,
      durationMs: result.durationMs,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Individual checks
  // -------------------------------------------------------------------------

  /**
   * Find execution_log entries whose job_id does not exist in jobs.
   */
  private async checkOrphanedExecutionLogs(): Promise<ConsistencyIssue[]> {
    const rows = await this.db.query<{ execution_id: string; job_id: string }>(
      'meridian',
      `SELECT el.execution_id, el.job_id FROM execution_log el
       LEFT JOIN jobs j ON el.job_id = j.id
       WHERE j.id IS NULL`,
    );

    return rows.map((row) => ({
      type: 'orphaned_execution_log' as const,
      table: 'execution_log',
      recordId: row.execution_id,
      details: `execution_log entry ${row.execution_id} references non-existent job ${row.job_id}`,
    }));
  }

  /**
   * Find messages whose conversation_id does not exist in conversations.
   */
  private async checkOrphanedMessages(): Promise<ConsistencyIssue[]> {
    const rows = await this.db.query<{ id: string; conversation_id: string }>(
      'meridian',
      `SELECT m.id, m.conversation_id FROM messages m
       LEFT JOIN conversations c ON m.conversation_id = c.id
       WHERE c.id IS NULL`,
    );

    return rows.map((row) => ({
      type: 'orphaned_message' as const,
      table: 'messages',
      recordId: row.id,
      details: `message ${row.id} references non-existent conversation ${row.conversation_id}`,
    }));
  }

  /**
   * Find jobs whose parent_id is set but does not exist in jobs.
   */
  private async checkOrphanedJobReferences(): Promise<ConsistencyIssue[]> {
    const rows = await this.db.query<{ id: string; parent_id: string }>(
      'meridian',
      `SELECT j1.id, j1.parent_id FROM jobs j1
       LEFT JOIN jobs j2 ON j1.parent_id = j2.id
       WHERE j1.parent_id IS NOT NULL AND j2.id IS NULL`,
    );

    return rows.map((row) => ({
      type: 'orphaned_job_reference' as const,
      table: 'jobs',
      recordId: row.id,
      details: `job ${row.id} references non-existent parent job ${row.parent_id}`,
    }));
  }
}
