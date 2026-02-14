// @meridian/axis — Append-only audit log (Sections 6.6, 8.6)
//
// Writes AuditEntry records to monthly-partitioned SQLite databases
// (audit-YYYY-MM.db). The application NEVER issues UPDATE or DELETE
// on audit entries.
//
// Key properties:
// - synchronous = FULL on audit databases (crash must never lose an entry)
// - Write-ahead audit: entry written BEFORE committing the primary action
// - Monthly partitioning: current month is the write target
// - Integrity chain: SHA-256 hash chain (previousHash, entryHash) for tamper detection

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { generateId } from '@meridian/shared';
import type {
  AuditEntry,
  AuditActor,
  DatabaseName,
  RiskLevel,
  DatabaseClient,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for audit events.
 */
export interface AuditLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Options for creating an audit entry.
 * Omits `id`, `timestamp`, `previousHash`, and `entryHash` which are
 * auto-generated.
 */
export interface WriteAuditEntryOptions {
  actor: AuditActor;
  action: string;
  riskLevel: RiskLevel;
  actorId?: string;
  target?: string;
  jobId?: string;
  details?: Record<string, unknown>;
}

/**
 * Options for querying audit entries.
 */
export interface QueryAuditOptions {
  /** Filter by actor type. */
  actor?: AuditActor;
  /** Filter by action string (exact match). */
  action?: string;
  /** Filter by risk level. */
  riskLevel?: RiskLevel;
  /** Filter by job ID. */
  jobId?: string;
  /** Start of time range (inclusive, ISO 8601). */
  startTime?: string;
  /** End of time range (inclusive, ISO 8601). */
  endTime?: string;
  /** Maximum number of entries to return. Default: 100. */
  limit?: number;
  /** Offset for pagination. Default: 0. */
  offset?: number;
}

/**
 * Result of an export operation.
 */
export interface AuditExportResult {
  /** Number of entries exported. */
  entryCount: number;
  /** The exported entries. */
  entries: AuditEntry[];
}

/**
 * Options for the AuditLog.
 */
export interface AuditLogOptions {
  /** Database client. */
  db: DatabaseClient;
  /** Data directory for audit database files. */
  dataDir: string;
  /** Logger for audit events. */
  logger?: AuditLogger;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: AuditLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the audit database file name for a given date.
 * Format: audit-YYYY-MM.db
 */
export function getAuditDbFileName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `audit-${year}-${month}.db`;
}

/**
 * Get the database key used by DatabaseClient for a monthly audit database.
 * Format: audit-YYYY-MM
 *
 * The returned key is a valid `DatabaseName` that maps directly to
 * the monthly partition file (e.g. `audit-2026-02` → `audit-2026-02.db`).
 */
function getAuditDbKey(date: Date = new Date()): DatabaseName {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `audit-${year}-${month}`;
}

// ---------------------------------------------------------------------------
// Database row type
// ---------------------------------------------------------------------------

interface AuditEntryRow {
  id: string;
  timestamp: string;
  actor: string;
  actor_id: string | null;
  action: string;
  risk_level: string;
  target: string | null;
  job_id: string | null;
  previous_hash: string | null;
  entry_hash: string | null;
  details: string | null;
}

/**
 * Convert a database row to an AuditEntry.
 */
function rowToEntry(row: AuditEntryRow): AuditEntry {
  const entry: AuditEntry = {
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor as AuditActor,
    action: row.action,
    riskLevel: row.risk_level as RiskLevel,
  };

  if (row.actor_id !== null) entry.actorId = row.actor_id;
  if (row.target !== null) entry.target = row.target;
  if (row.job_id !== null) entry.jobId = row.job_id;
  if (row.previous_hash !== null) entry.previousHash = row.previous_hash;
  if (row.entry_hash !== null) entry.entryHash = row.entry_hash;
  if (row.details !== null) {
    entry.details = JSON.parse(row.details) as Record<string, unknown>;
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Integrity chain helpers
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash for an audit entry.
 *
 * The hash covers the canonical JSON representation of the entry,
 * EXCLUDING the `entryHash` field itself (since that's what we're computing).
 * This creates a hash chain: each entry's hash incorporates the previous
 * entry's hash via the `previousHash` field.
 */
export function computeEntryHash(entry: AuditEntry): string {
  // Build a canonical representation excluding entryHash
  const canonical: Record<string, unknown> = {
    id: entry.id,
    timestamp: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
    riskLevel: entry.riskLevel,
  };

  if (entry.actorId !== undefined) canonical['actorId'] = entry.actorId;
  if (entry.target !== undefined) canonical['target'] = entry.target;
  if (entry.jobId !== undefined) canonical['jobId'] = entry.jobId;
  if (entry.previousHash !== undefined) canonical['previousHash'] = entry.previousHash;
  if (entry.details !== undefined) canonical['details'] = entry.details;

  // Sort keys for deterministic JSON
  const json = JSON.stringify(canonical, Object.keys(canonical).sort());
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Result of verifying an audit integrity chain.
 */
export interface ChainVerificationResult {
  /** Whether the entire chain is valid. */
  valid: boolean;
  /** Total entries checked. */
  entriesChecked: number;
  /** The first broken link, if any. */
  brokenAt?: {
    entryId: string;
    index: number;
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

/**
 * Append-only audit log with monthly database partitioning.
 *
 * The audit log enforces append-only semantics at the API level:
 * only `write()` and read operations are exposed. There are no
 * update or delete methods.
 *
 * Each monthly partition is a separate SQLite file (audit-YYYY-MM.db)
 * with `synchronous = FULL` to ensure crash safety.
 */
export class AuditLog {
  private readonly db: DatabaseClient;
  private readonly dataDir: string;
  private readonly logger: AuditLogger;
  private readonly initializedMonths = new Set<string>();

  constructor(options: AuditLogOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.logger = options.logger ?? noopLogger;
  }

  // -------------------------------------------------------------------------
  // Month initialization
  // -------------------------------------------------------------------------

  /**
   * Ensure the audit database for a given month is open and migrated.
   * Creates the database file if it doesn't exist.
   */
  private async ensureMonth(date: Date = new Date()): Promise<DatabaseName> {
    const key = getAuditDbKey(date);

    if (this.initializedMonths.has(key)) {
      return key;
    }

    const fileName = getAuditDbFileName(date);
    const dbPath = resolve(this.dataDir, fileName);

    // Open the database using the partition key (e.g. 'audit-2026-02').
    // DatabaseClient.defaultPath maps this to audit-2026-02.db and
    // DatabaseEngine detects the "audit-" prefix for synchronous = FULL.
    await this.db.open(key, dbPath);

    // Create the audit_entries table and indexes if they don't exist.
    // We use CREATE TABLE IF NOT EXISTS so this is idempotent.
    await this.db.exec(key, `
      CREATE TABLE IF NOT EXISTS audit_entries (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        target TEXT,
        job_id TEXT,
        previous_hash TEXT,
        entry_hash TEXT,
        details TEXT CHECK (json_valid(details) OR details IS NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_entries(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_entries(action);
      CREATE INDEX IF NOT EXISTS idx_audit_job_id ON audit_entries(job_id);
      CREATE INDEX IF NOT EXISTS idx_audit_risk_level ON audit_entries(risk_level);
    `);

    this.initializedMonths.add(key);
    this.logger.info('Audit database initialized', { month: key, path: dbPath });

    return key;
  }

  // -------------------------------------------------------------------------
  // Integrity chain helpers
  // -------------------------------------------------------------------------

  /**
   * Get the entryHash of the most recent audit entry in this month's database.
   * Returns undefined if no entries exist (i.e. this is the first entry).
   */
  private async getLastEntryHash(key: DatabaseName): Promise<string | undefined> {
    const rows = await this.db.query<{ entry_hash: string | null }>(
      key,
      `SELECT entry_hash FROM audit_entries ORDER BY timestamp DESC, id DESC LIMIT 1`,
    );

    return rows[0]?.entry_hash ?? undefined;
  }

  // -------------------------------------------------------------------------
  // Write (append-only)
  // -------------------------------------------------------------------------

  /**
   * Write an audit entry to the current month's database.
   *
   * This is the ONLY write operation exposed by AuditLog.
   * No update or delete operations exist, enforcing append-only
   * semantics at the API level.
   *
   * Per Section 8.6, audit entries should be written BEFORE
   * committing the primary action (write-ahead audit).
   *
   * @returns The created AuditEntry with generated id and timestamp.
   */
  async write(options: WriteAuditEntryOptions): Promise<AuditEntry> {
    const now = new Date();
    const key = await this.ensureMonth(now);

    // Get the previous entry's hash for the integrity chain
    const previousHash = await this.getLastEntryHash(key);

    const entry: AuditEntry = {
      id: generateId(),
      timestamp: now.toISOString(),
      actor: options.actor,
      action: options.action,
      riskLevel: options.riskLevel,
      actorId: options.actorId,
      target: options.target,
      jobId: options.jobId,
      previousHash,
      entryHash: undefined, // computed below
      details: options.details,
    };

    // Compute the entry hash (SHA-256 of canonical JSON excluding entryHash)
    entry.entryHash = computeEntryHash(entry);

    await this.db.run(
      key,
      `INSERT INTO audit_entries
        (id, timestamp, actor, actor_id, action, risk_level, target, job_id,
         previous_hash, entry_hash, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.timestamp,
        entry.actor,
        entry.actorId ?? null,
        entry.action,
        entry.riskLevel,
        entry.target ?? null,
        entry.jobId ?? null,
        entry.previousHash ?? null,
        entry.entryHash ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
      ],
    );

    return entry;
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Query audit entries from a specific month's database.
   * Defaults to the current month.
   */
  async query(
    options: QueryAuditOptions = {},
    date: Date = new Date(),
  ): Promise<AuditEntry[]> {
    const key = await this.ensureMonth(date);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.actor) {
      conditions.push('actor = ?');
      params.push(options.actor);
    }
    if (options.action) {
      conditions.push('action = ?');
      params.push(options.action);
    }
    if (options.riskLevel) {
      conditions.push('risk_level = ?');
      params.push(options.riskLevel);
    }
    if (options.jobId) {
      conditions.push('job_id = ?');
      params.push(options.jobId);
    }
    if (options.startTime) {
      conditions.push('timestamp >= ?');
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push('timestamp <= ?');
      params.push(options.endTime);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    params.push(limit, offset);

    const rows = await this.db.query<AuditEntryRow>(
      key,
      `SELECT id, timestamp, actor, actor_id, action, risk_level, target,
              job_id, previous_hash, entry_hash, details
       FROM audit_entries ${where}
       ORDER BY timestamp ASC
       LIMIT ? OFFSET ?`,
      params,
    );

    return rows.map(rowToEntry);
  }

  /**
   * Get a single audit entry by ID from a specific month.
   */
  async getById(id: string, date: Date = new Date()): Promise<AuditEntry | undefined> {
    const key = await this.ensureMonth(date);

    const rows = await this.db.query<AuditEntryRow>(
      key,
      `SELECT id, timestamp, actor, actor_id, action, risk_level, target,
              job_id, previous_hash, entry_hash, details
       FROM audit_entries WHERE id = ?`,
      [id],
    );

    return rows[0] ? rowToEntry(rows[0]) : undefined;
  }

  /**
   * Count audit entries in a specific month, with optional filters.
   */
  async count(
    options: Pick<QueryAuditOptions, 'actor' | 'action' | 'riskLevel' | 'jobId'> = {},
    date: Date = new Date(),
  ): Promise<number> {
    const key = await this.ensureMonth(date);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.actor) {
      conditions.push('actor = ?');
      params.push(options.actor);
    }
    if (options.action) {
      conditions.push('action = ?');
      params.push(options.action);
    }
    if (options.riskLevel) {
      conditions.push('risk_level = ?');
      params.push(options.riskLevel);
    }
    if (options.jobId) {
      conditions.push('job_id = ?');
      params.push(options.jobId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await this.db.query<{ count: number }>(
      key,
      `SELECT COUNT(*) as count FROM audit_entries ${where}`,
      params,
    );

    return rows[0]?.count ?? 0;
  }

  // -------------------------------------------------------------------------
  // Export (Section 6.6: "Can be exported for external review")
  // -------------------------------------------------------------------------

  /**
   * Export all audit entries from a specific month for external review.
   * Returns entries in chronological order.
   */
  async export(date: Date = new Date()): Promise<AuditExportResult> {
    const key = await this.ensureMonth(date);

    const rows = await this.db.query<AuditEntryRow>(
      key,
      `SELECT id, timestamp, actor, actor_id, action, risk_level, target,
              job_id, previous_hash, entry_hash, details
       FROM audit_entries
       ORDER BY timestamp ASC`,
    );

    const entries = rows.map(rowToEntry);
    return { entryCount: entries.length, entries };
  }

  // -------------------------------------------------------------------------
  // Integrity verification (Section 6.6)
  // -------------------------------------------------------------------------

  /**
   * Verify the integrity of the hash chain for a specific month.
   *
   * Reads all entries in chronological order and checks:
   * 1. Each entry's `entryHash` matches the recomputed hash
   * 2. Each entry's `previousHash` matches the preceding entry's `entryHash`
   * 3. The first entry's `previousHash` is undefined/null
   *
   * Returns a result indicating whether the chain is valid and, if not,
   * where the first break was detected.
   */
  async verifyChain(date: Date = new Date()): Promise<ChainVerificationResult> {
    const key = await this.ensureMonth(date);

    const rows = await this.db.query<AuditEntryRow>(
      key,
      `SELECT id, timestamp, actor, actor_id, action, risk_level, target,
              job_id, previous_hash, entry_hash, details
       FROM audit_entries
       ORDER BY timestamp ASC, id ASC`,
    );

    const entries = rows.map(rowToEntry);

    if (entries.length === 0) {
      return { valid: true, entriesChecked: 0 };
    }

    let previousHash: string | undefined;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;

      // Check previousHash linkage
      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          entriesChecked: i + 1,
          brokenAt: {
            entryId: entry.id,
            index: i,
            reason: `previousHash mismatch at index ${i}: expected '${previousHash ?? 'null'}', got '${entry.previousHash ?? 'null'}'`,
          },
        };
      }

      // Recompute and verify entryHash
      const recomputed = computeEntryHash(entry);
      if (entry.entryHash !== recomputed) {
        return {
          valid: false,
          entriesChecked: i + 1,
          brokenAt: {
            entryId: entry.id,
            index: i,
            reason: `entryHash mismatch at index ${i}: stored '${entry.entryHash ?? 'null'}', computed '${recomputed}'`,
          },
        };
      }

      previousHash = entry.entryHash;
    }

    return { valid: true, entriesChecked: entries.length };
  }
}
