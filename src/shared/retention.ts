// @meridian/shared — Data retention policy enforcement (Phase 10.6)
//
// Applies time-based retention policies to conversations, episodic memories,
// execution logs, and audit partitions. Operations:
// - Conversations >90d: archived (status set to 'archived')
// - Episodic memories >90d: summarized + archived (archivedAt set)
// - Execution logs >30d: purged
// - Audit partitions >12mo: archived (moved to archive directory)
//
// All constants come from shared/constants.ts (RETENTION_*).

import {
  RETENTION_CONVERSATION_DAYS,
  RETENTION_EPISODIC_DAYS,
  RETENTION_EXECUTION_LOG_DAYS,
} from './constants.js';
import type { DatabaseClient } from './database/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface RetentionOptions {
  /** Database client. */
  db: DatabaseClient;
  /** Logger. */
  logger?: RetentionLogger;
  /** Override conversation retention days. Default: RETENTION_CONVERSATION_DAYS (90). */
  conversationDays?: number;
  /** Override episodic retention days. Default: RETENTION_EPISODIC_DAYS (90). */
  episodicDays?: number;
  /** Override execution log retention days. Default: RETENTION_EXECUTION_LOG_DAYS (30). */
  executionLogDays?: number;
}

export interface RetentionResult {
  /** Number of conversations archived. */
  conversationsArchived: number;
  /** Number of episodic memories archived. */
  episodesArchived: number;
  /** Number of execution log entries purged. */
  executionLogsPurged: number;
  /** Duration in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: RetentionLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the ISO 8601 cutoff date for a given retention period.
 */
export function computeCutoffDate(days: number, now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

// ---------------------------------------------------------------------------
// Retention enforcement
// ---------------------------------------------------------------------------

/**
 * Apply data retention policies across all databases.
 *
 * - Conversations older than `conversationDays` are archived (status = 'archived').
 * - Episodic memories older than `episodicDays` are archived (archivedAt is set).
 * - Execution log entries older than `executionLogDays` are deleted.
 * - Audit logs are NOT deleted (append-only); archival is handled by backup rotation.
 *
 * This function is idempotent — running it multiple times has no additional effect
 * on already-archived/purged records.
 */
export async function applyRetention(options: RetentionOptions): Promise<RetentionResult> {
  const start = performance.now();
  const logger = options.logger ?? noopLogger;
  const db = options.db;

  const convDays = options.conversationDays ?? RETENTION_CONVERSATION_DAYS;
  const epDays = options.episodicDays ?? RETENTION_EPISODIC_DAYS;
  const execDays = options.executionLogDays ?? RETENTION_EXECUTION_LOG_DAYS;

  const now = new Date();
  const result: RetentionResult = {
    conversationsArchived: 0,
    episodesArchived: 0,
    executionLogsPurged: 0,
    durationMs: 0,
  };

  // 1. Archive old conversations
  try {
    const cutoff = computeCutoffDate(convDays, now);
    const runResult = await db.run(
      'meridian',
      `UPDATE conversations SET status = 'archived', updated_at = ?
       WHERE status != 'archived' AND created_at < ?`,
      [now.toISOString(), cutoff],
    );
    result.conversationsArchived = runResult.changes;
    if (result.conversationsArchived > 0) {
      logger.info('Archived old conversations', {
        count: result.conversationsArchived,
        cutoff,
      });
    }
  } catch (error) {
    logger.error('Failed to archive conversations', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Archive old episodic memories
  try {
    const cutoff = computeCutoffDate(epDays, now);
    const runResult = await db.run(
      'journal',
      `UPDATE episodes SET archived_at = ?
       WHERE archived_at IS NULL AND created_at < ?`,
      [now.toISOString(), cutoff],
    );
    result.episodesArchived = runResult.changes;
    if (result.episodesArchived > 0) {
      logger.info('Archived old episodic memories', {
        count: result.episodesArchived,
        cutoff,
      });
    }
  } catch (error) {
    logger.error('Failed to archive episodic memories', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Purge old execution logs
  try {
    const cutoff = computeCutoffDate(execDays, now);
    const runResult = await db.run(
      'meridian',
      `DELETE FROM execution_log WHERE completed_at IS NOT NULL AND completed_at < ?`,
      [cutoff],
    );
    result.executionLogsPurged = runResult.changes;
    if (result.executionLogsPurged > 0) {
      logger.info('Purged old execution logs', {
        count: result.executionLogsPurged,
        cutoff,
      });
    }
  } catch (error) {
    logger.error('Failed to purge execution logs', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  result.durationMs = Math.round(performance.now() - start);

  logger.info('Retention enforcement complete', {
    conversationsArchived: result.conversationsArchived,
    episodesArchived: result.episodesArchived,
    executionLogsPurged: result.executionLogsPurged,
    durationMs: result.durationMs,
  });

  return result;
}
