// @meridian/shared — Database infrastructure types

/**
 * Logical database names. Each maps to a separate SQLite file.
 * - meridian: Core database (jobs, conversations, config, schedules, gear, execution_log)
 * - journal: Memory system (episodes, facts, procedures, vector embeddings)
 * - sentinel: Sentinel Memory (isolated approval decisions)
 * - audit: Append-only audit log (monthly partitioned: audit-YYYY-MM.db)
 */
export type DatabaseName = 'meridian' | 'journal' | 'sentinel' | 'audit';

/**
 * Deployment tier affects PRAGMA tuning (cache_size, mmap_size).
 */
export type DeploymentTier = 'pi' | 'desktop' | 'vps';

/**
 * Result of a write operation (INSERT/UPDATE/DELETE).
 */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

// ---------------------------------------------------------------------------
// Worker thread message protocol
// ---------------------------------------------------------------------------

export type WorkerRequest =
  | WorkerInitMessage
  | WorkerQueryMessage
  | WorkerRunMessage
  | WorkerExecMessage
  | WorkerBeginMessage
  | WorkerCommitMessage
  | WorkerRollbackMessage
  | WorkerBackupMessage
  | WorkerCloseMessage;

export interface WorkerInitMessage {
  type: 'init';
  id: string;
  dbName: string;
  dbPath: string;
  tier: DeploymentTier;
}

export interface WorkerQueryMessage {
  type: 'query';
  id: string;
  dbName: string;
  sql: string;
  params?: unknown[];
  useWriteConnection?: boolean;
}

export interface WorkerRunMessage {
  type: 'run';
  id: string;
  dbName: string;
  sql: string;
  params?: unknown[];
}

export interface WorkerExecMessage {
  type: 'exec';
  id: string;
  dbName: string;
  sql: string;
}

export interface WorkerBeginMessage {
  type: 'begin';
  id: string;
  dbName: string;
}

export interface WorkerCommitMessage {
  type: 'commit';
  id: string;
  dbName: string;
}

export interface WorkerRollbackMessage {
  type: 'rollback';
  id: string;
  dbName: string;
}

export interface WorkerBackupMessage {
  type: 'backup';
  id: string;
  dbName: string;
  destPath: string;
}

export interface WorkerCloseMessage {
  type: 'close';
  id: string;
  dbName?: string;
}

export interface WorkerResponse {
  type: 'result' | 'error';
  id: string;
  data?: unknown;
  error?: string;
  code?: string;
}
