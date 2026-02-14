// @meridian/sentinel — Sentinel Memory (Phase 10.3)
//
// Stores and retrieves approval/denial decisions for auto-approval.
// Matching semantics per Section 5.3.8:
// - Action type: exact string match
// - File operations: prefix match on canonicalized directory boundaries
// - Network: exact domain match
// - Financial: numeric comparison (request <= approved)
// - Shell commands: EXCLUDED entirely (storeDecision throws)
//
// Cap: 500 active decisions (SENTINEL_MEMORY_CAP). Oldest evicted on overflow.

import type { DatabaseClient, SentinelDecision, SentinelVerdict } from '@meridian/shared';
import {
  generateId,
  NotFoundError,
  SENTINEL_MEMORY_CAP,
  ValidationError,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SentinelMemoryOptions {
  db: DatabaseClient;
  logger?: SentinelMemoryLogger;
}

export interface SentinelMemoryLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface StoreDecisionOptions {
  actionType: string;
  scope: string;
  verdict: SentinelVerdict;
  jobId?: string;
  expiresAt?: string;
  conditions?: string;
  metadata?: Record<string, unknown>;
}

export interface MatchResult {
  matched: boolean;
  decision?: SentinelDecision;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Action types that are excluded from Sentinel Memory storage. */
const EXCLUDED_ACTION_TYPES = new Set([
  'shell.execute',
  'shell.run',
  'shell.exec',
]);

// ---------------------------------------------------------------------------
// Database row type
// ---------------------------------------------------------------------------

interface DecisionRow {
  id: string;
  action_type: string;
  scope: string;
  verdict: string;
  job_id: string | null;
  created_at: string;
  expires_at: string | null;
  conditions: string | null;
  metadata_json: string | null;
}

// ---------------------------------------------------------------------------
// Row-to-DTO mapper
// ---------------------------------------------------------------------------

function rowToDecision(row: DecisionRow): SentinelDecision {
  return {
    id: row.id,
    actionType: row.action_type,
    scope: row.scope,
    verdict: row.verdict as SentinelVerdict,
    jobId: row.job_id ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    conditions: row.conditions ?? undefined,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: SentinelMemoryLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// SentinelMemory
// ---------------------------------------------------------------------------

export class SentinelMemory {
  private readonly db: DatabaseClient;
  private readonly logger: SentinelMemoryLogger;

  constructor(options: SentinelMemoryOptions) {
    this.db = options.db;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Store a new decision. Throws if the action type is excluded (shell).
   * Enforces the cap by evicting the oldest decision when exceeded.
   */
  async storeDecision(options: StoreDecisionOptions): Promise<SentinelDecision> {
    // Shell commands are excluded entirely
    if (EXCLUDED_ACTION_TYPES.has(options.actionType)) {
      throw new ValidationError(
        `Action type '${options.actionType}' is excluded from Sentinel Memory. ` +
          'Shell commands must always go through full validation.',
      );
    }

    const now = new Date().toISOString();
    const id = generateId();

    await this.db.run(
      'sentinel',
      `INSERT INTO decisions (id, action_type, scope, verdict, job_id, created_at, expires_at, conditions, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        options.actionType,
        options.scope,
        options.verdict,
        options.jobId ?? null,
        now,
        options.expiresAt ?? null,
        options.conditions ?? null,
        options.metadata ? JSON.stringify(options.metadata) : null,
      ],
    );

    // Enforce cap
    await this.enforceCap();

    this.logger.info('Decision stored', {
      id,
      actionType: options.actionType,
      verdict: options.verdict,
    });

    return {
      id,
      actionType: options.actionType,
      scope: options.scope,
      verdict: options.verdict,
      jobId: options.jobId,
      createdAt: now,
      expiresAt: options.expiresAt,
      conditions: options.conditions,
      metadata: options.metadata,
    };
  }

  /**
   * Find a matching decision for the given action type and scope.
   * Uses matching semantics from Section 5.3.8:
   * - File ops: prefix match on directory boundaries
   * - Network: exact domain match
   * - Financial: numeric comparison
   * - Default: exact scope match
   */
  async findMatch(
    actionType: string,
    scope: string,
  ): Promise<MatchResult> {
    const now = new Date().toISOString();

    // Get all non-expired decisions for this action type
    const rows = await this.db.query<DecisionRow>(
      'sentinel',
      `SELECT * FROM decisions
       WHERE action_type = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
      [actionType, now],
    );

    for (const row of rows) {
      const decision = rowToDecision(row);

      if (this.matchesScope(actionType, decision.scope, scope)) {
        this.logger.debug('Decision matched', {
          decisionId: decision.id,
          actionType,
          scope,
          verdict: decision.verdict,
        });
        return { matched: true, decision };
      }
    }

    return { matched: false };
  }

  /**
   * Get a decision by ID.
   */
  async getDecision(id: string): Promise<SentinelDecision | undefined> {
    const rows = await this.db.query<DecisionRow>(
      'sentinel',
      'SELECT * FROM decisions WHERE id = ?',
      [id],
    );
    return rows[0] ? rowToDecision(rows[0]) : undefined;
  }

  /**
   * List all active (non-expired) decisions.
   */
  async listActiveDecisions(): Promise<SentinelDecision[]> {
    const now = new Date().toISOString();
    const rows = await this.db.query<DecisionRow>(
      'sentinel',
      `SELECT * FROM decisions
       WHERE expires_at IS NULL OR expires_at > ?
       ORDER BY created_at DESC`,
      [now],
    );
    return rows.map(rowToDecision);
  }

  /**
   * Delete a specific decision.
   */
  async deleteDecision(id: string): Promise<void> {
    const result = await this.db.run(
      'sentinel',
      'DELETE FROM decisions WHERE id = ?',
      [id],
    );
    if (result.changes === 0) {
      throw new NotFoundError(`Decision '${id}' not found`);
    }
    this.logger.info('Decision deleted', { id });
  }

  /**
   * Prune expired decisions.
   */
  async pruneExpired(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db.run(
      'sentinel',
      'DELETE FROM decisions WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [now],
    );
    const pruned = result.changes;
    if (pruned > 0) {
      this.logger.info('Pruned expired decisions', { count: pruned });
    }
    return pruned;
  }

  /**
   * Count total active decisions.
   */
  async countActive(): Promise<number> {
    const now = new Date().toISOString();
    const rows = await this.db.query<{ count: number }>(
      'sentinel',
      `SELECT COUNT(*) as count FROM decisions
       WHERE expires_at IS NULL OR expires_at > ?`,
      [now],
    );
    return rows[0]?.count ?? 0;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Match scope based on action type semantics.
   */
  private matchesScope(
    actionType: string,
    decisionScope: string,
    requestScope: string,
  ): boolean {
    // File operations: prefix match on directory boundaries
    if (actionType.startsWith('file.') || actionType.startsWith('fs.')) {
      return matchFileScope(decisionScope, requestScope);
    }

    // Network operations: exact domain match
    if (actionType.startsWith('network.') || actionType.startsWith('http.')) {
      return matchNetworkScope(decisionScope, requestScope);
    }

    // Financial operations: numeric comparison
    if (actionType.startsWith('financial.') || actionType.startsWith('payment.')) {
      return matchFinancialScope(decisionScope, requestScope);
    }

    // Default: exact match
    return decisionScope === requestScope;
  }

  /**
   * Enforce the cap on active decisions by evicting oldest.
   */
  private async enforceCap(): Promise<void> {
    const count = await this.countActive();
    if (count <= SENTINEL_MEMORY_CAP) {
      return;
    }

    const excess = count - SENTINEL_MEMORY_CAP;
    // Delete the oldest excess decisions
    await this.db.run(
      'sentinel',
      `DELETE FROM decisions WHERE id IN (
        SELECT id FROM decisions ORDER BY created_at ASC LIMIT ?
      )`,
      [excess],
    );

    this.logger.warn('Sentinel Memory cap exceeded, evicted oldest decisions', {
      cap: SENTINEL_MEMORY_CAP,
      evicted: excess,
    });
  }
}

// ---------------------------------------------------------------------------
// Scope matching functions
// ---------------------------------------------------------------------------

/**
 * File scope matching: the decision scope must be a directory prefix of
 * the request scope, matching on directory boundaries.
 *
 * E.g., decision scope "/data/workspace" matches request "/data/workspace/file.txt"
 * but NOT "/data/workspacetoo/file.txt".
 */
export function matchFileScope(decisionScope: string, requestScope: string): boolean {
  const normalizedDecision = canonicalizePath(decisionScope);
  const normalizedRequest = canonicalizePath(requestScope);

  if (normalizedRequest === normalizedDecision) {
    return true;
  }

  // Ensure prefix match is on a directory boundary
  const prefix = normalizedDecision.endsWith('/')
    ? normalizedDecision
    : normalizedDecision + '/';

  return normalizedRequest.startsWith(prefix);
}

/**
 * Network scope matching: exact domain match (case-insensitive).
 */
export function matchNetworkScope(decisionScope: string, requestScope: string): boolean {
  return decisionScope.toLowerCase() === requestScope.toLowerCase();
}

/**
 * Financial scope matching: request amount must be <= approved amount.
 * Scopes are expected to be numeric strings (amounts).
 */
export function matchFinancialScope(decisionScope: string, requestScope: string): boolean {
  const approvedAmount = parseFloat(decisionScope);
  const requestAmount = parseFloat(requestScope);

  if (isNaN(approvedAmount) || isNaN(requestAmount)) {
    return false;
  }

  return requestAmount <= approvedAmount;
}

/**
 * Canonicalize a file path: resolve . and .., normalize separators,
 * remove trailing slash (except for root).
 */
function canonicalizePath(p: string): string {
  // Split on / or \, resolve . and ..
  const parts: string[] = [];
  const segments = p.split(/[/\\]+/);

  for (const seg of segments) {
    if (seg === '.' || seg === '') {
      continue;
    }
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }

  const result = '/' + parts.join('/');
  return result;
}
