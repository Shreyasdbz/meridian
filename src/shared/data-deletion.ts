// @meridian/shared — Right to deletion (Phase 10.6)
//
// Purges all user data across all databases. Audit logs are explicitly
// retained per the architecture document (Section 7.4) since they serve
// a security and compliance purpose.
//
// The function requires `{ confirm: true }` to prevent accidental deletion.

import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseClient } from './database/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DataDeletionLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface DataDeletionOptions {
  /** Database client. */
  db: DatabaseClient;
  /** Data directory (for workspace cleanup). */
  dataDir: string;
  /** Must be true to proceed. */
  confirm: boolean;
  /** Logger. */
  logger?: DataDeletionLogger;
}

export interface DataDeletionResult {
  /** Whether the deletion was executed. */
  executed: boolean;
  /** What was deleted. */
  deleted: {
    conversations: boolean;
    messages: boolean;
    jobs: boolean;
    executionLogs: boolean;
    episodes: boolean;
    facts: boolean;
    procedures: boolean;
    stagedMemories: boolean;
    embeddings: boolean;
    workspace: boolean;
    config: boolean;
    sessions: boolean;
    secrets: boolean;
  };
  /** What was explicitly retained. */
  retained: string[];
  /** Duration in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: DataDeletionLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Delete all user data
// ---------------------------------------------------------------------------

/**
 * Delete all user data from all databases.
 *
 * This is the "right to deletion" implementation per Section 7.4.
 * It purges:
 * - All conversations and messages (meridian.db)
 * - All jobs and execution logs (meridian.db)
 * - All episodic, semantic, and procedural memories (journal.db)
 * - All staged memories and embeddings (journal.db)
 * - All config (except auth) (meridian.db)
 * - All sessions (meridian.db)
 * - Workspace contents
 * - Secrets vault (secrets.vault)
 *
 * Explicitly RETAINED (not deleted):
 * - Audit logs (append-only, security/compliance)
 * - Authentication credentials (auth table)
 * - Sentinel decisions (sentinel.db) — cleared separately below
 *
 * @throws If `confirm` is not `true`
 */
export async function deleteAllUserData(
  options: DataDeletionOptions,
): Promise<DataDeletionResult> {
  if (!options.confirm) {
    throw new Error(
      'Data deletion requires { confirm: true }. This action is irreversible.',
    );
  }

  const start = performance.now();
  const logger = options.logger ?? noopLogger;
  const db = options.db;

  logger.warn('Starting full user data deletion');

  const result: DataDeletionResult = {
    executed: true,
    deleted: {
      conversations: false,
      messages: false,
      jobs: false,
      executionLogs: false,
      episodes: false,
      facts: false,
      procedures: false,
      stagedMemories: false,
      embeddings: false,
      workspace: false,
      config: false,
      sessions: false,
      secrets: false,
    },
    retained: ['audit logs (append-only)', 'auth credentials'],
    durationMs: 0,
  };

  // -------------------------------------------------------------------------
  // meridian.db
  // -------------------------------------------------------------------------

  const meridianTables: Array<{ table: string; key: keyof typeof result.deleted }> = [
    { table: 'messages', key: 'messages' },
    { table: 'jobs', key: 'jobs' },
    { table: 'execution_log', key: 'executionLogs' },
    { table: 'conversations', key: 'conversations' },
    { table: 'sessions', key: 'sessions' },
  ];

  for (const { table, key } of meridianTables) {
    try {
      await db.run('meridian', `DELETE FROM ${table}`, []);
      result.deleted[key] = true;
      logger.info(`Deleted all rows from meridian.${table}`);
    } catch (error) {
      logger.error(`Failed to delete from meridian.${table}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Delete config except auth-related entries
  try {
    await db.run(
      'meridian',
      `DELETE FROM config WHERE key NOT LIKE 'auth.%'`,
      [],
    );
    result.deleted.config = true;
    logger.info('Deleted config (preserved auth settings)');
  } catch (error) {
    logger.error('Failed to delete config', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // -------------------------------------------------------------------------
  // journal.db
  // -------------------------------------------------------------------------

  const journalTables: Array<{ table: string; key: keyof typeof result.deleted }> = [
    { table: 'memory_embeddings', key: 'embeddings' },
    { table: 'memory_staging', key: 'stagedMemories' },
    { table: 'procedures', key: 'procedures' },
    { table: 'facts', key: 'facts' },
    { table: 'episodes', key: 'episodes' },
  ];

  for (const { table, key } of journalTables) {
    try {
      await db.run('journal', `DELETE FROM ${table}`, []);
      result.deleted[key] = true;
      logger.info(`Deleted all rows from journal.${table}`);
    } catch (error) {
      logger.error(`Failed to delete from journal.${table}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // sentinel.db — clear decisions (these are user-facing trust preferences)
  // -------------------------------------------------------------------------

  try {
    await db.run('sentinel', `DELETE FROM decisions`, []);
    logger.info('Deleted all Sentinel decisions');
  } catch (error) {
    logger.error('Failed to delete Sentinel decisions', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // -------------------------------------------------------------------------
  // Workspace cleanup
  // -------------------------------------------------------------------------

  const workspacePath = join(options.dataDir, 'workspace');
  try {
    if (existsSync(workspacePath)) {
      const entries = readdirSync(workspacePath);
      for (const entry of entries) {
        rmSync(join(workspacePath, entry), { recursive: true, force: true });
      }
      result.deleted.workspace = true;
      logger.info('Cleaned workspace directory', { path: workspacePath });
    }
  } catch (error) {
    logger.error('Failed to clean workspace', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // -------------------------------------------------------------------------
  // Secrets vault cleanup
  // -------------------------------------------------------------------------

  const secretsVaultPath = join(options.dataDir, 'secrets.vault');
  try {
    if (existsSync(secretsVaultPath)) {
      unlinkSync(secretsVaultPath);
      result.deleted.secrets = true;
      logger.info('Deleted secrets vault', { path: secretsVaultPath });
    }
  } catch (error) {
    logger.error('Failed to delete secrets vault', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  result.durationMs = Math.round(performance.now() - start);

  logger.warn('Full user data deletion complete', {
    durationMs: result.durationMs,
    retained: result.retained,
  });

  return result;
}
