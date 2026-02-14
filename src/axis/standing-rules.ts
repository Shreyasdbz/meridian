// @meridian/axis -- Standing rule evaluator (Phase 9.6)
//
// Manages standing approval rules. After repeated same-category approvals,
// suggests creating an auto-approval rule. This reduces user friction for
// routine, low-risk operations that have already been approved multiple times.

import type { DatabaseClient } from '@meridian/shared';
import { generateId, STANDING_RULE_SUGGESTION_COUNT } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A standing approval or denial rule for a specific action pattern.
 *
 * Rules are matched against incoming action patterns using exact match
 * or glob-style prefix matching (e.g., 'file-manager:*' matches
 * 'file-manager:read_file').
 */
export interface StandingRule {
  id: string;
  actionPattern: string;
  scope: string;
  verdict: 'approve' | 'deny';
  createdAt: string;
  expiresAt: string | null;
  createdBy: string;
  approvalCount: number;
}

/**
 * Logger interface for the standing rule evaluator.
 */
export interface StandingRuleEvaluatorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Configuration for the StandingRuleEvaluator.
 */
export interface StandingRuleEvaluatorConfig {
  /** Database client for reading/writing standing rules. */
  db: DatabaseClient;
  /** Number of approvals before suggesting a standing rule. */
  suggestionThreshold?: number;
  /** Optional logger. */
  logger?: StandingRuleEvaluatorLogger;
}

/**
 * Options for creating a new standing rule.
 */
export interface CreateRuleOptions {
  actionPattern: string;
  scope?: string;
  verdict?: 'approve' | 'deny';
  expiresAt?: string;
  createdBy?: string;
  approvalCount?: number;
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface StandingRuleRow {
  id: string;
  action_pattern: string;
  scope: string;
  verdict: string;
  created_at: string;
  expires_at: string | null;
  created_by: string;
  approval_count: number;
}

function rowToRule(row: StandingRuleRow): StandingRule {
  return {
    id: row.id,
    actionPattern: row.action_pattern,
    scope: row.scope,
    verdict: row.verdict as 'approve' | 'deny',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    approvalCount: row.approval_count,
  };
}

// ---------------------------------------------------------------------------
// StandingRuleEvaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates and manages standing approval rules.
 *
 * Tracks in-memory approval counts per action category (the prefix before
 * the first ':' in an action pattern). When the count reaches the configured
 * threshold, it signals that a standing rule should be created.
 */
export class StandingRuleEvaluator {
  private readonly db: DatabaseClient;
  private readonly threshold: number;
  private readonly logger: StandingRuleEvaluatorLogger;

  /**
   * In-memory counter tracking approvals per action category.
   * Category is derived from the prefix before the first ':' in the action pattern.
   */
  private readonly approvalCounts = new Map<string, number>();

  constructor(config: StandingRuleEvaluatorConfig) {
    this.db = config.db;
    this.threshold = config.suggestionThreshold ?? STANDING_RULE_SUGGESTION_COUNT;
    this.logger = config.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  // -------------------------------------------------------------------------
  // matchRule
  // -------------------------------------------------------------------------

  /**
   * Find a non-expired standing rule matching the given action pattern.
   *
   * Checks for exact matches first, then glob-style prefix matches
   * (e.g., pattern 'file-manager:*' matches action 'file-manager:read_file').
   *
   * @param actionPattern - The action pattern to match (e.g., 'file-manager:read_file')
   * @returns The matching rule, or undefined if none found
   */
  async matchRule(actionPattern: string): Promise<StandingRule | undefined> {
    const now = new Date().toISOString();

    const rows = await this.db.query<StandingRuleRow>(
      'meridian',
      `SELECT * FROM standing_rules
       WHERE (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
      [now],
    );

    for (const row of rows) {
      if (this.matchesPattern(row.action_pattern, actionPattern)) {
        this.logger.info('Standing rule matched', {
          ruleId: row.id,
          rulePattern: row.action_pattern,
          actionPattern,
        });
        return rowToRule(row);
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // suggestRule
  // -------------------------------------------------------------------------

  /**
   * Record an approval for an action pattern.
   *
   * Tracks approvals per action category (the prefix before the first ':').
   * Returns true when the approval count reaches the configured threshold,
   * indicating that a standing rule should be suggested. After reaching
   * the threshold, the counter resets.
   *
   * @param actionPattern - The action pattern that was approved
   * @returns true if the threshold was reached (suggest creating a rule)
   */
  suggestRule(actionPattern: string): boolean {
    const category = this.extractCategory(actionPattern);
    const current = this.approvalCounts.get(category) ?? 0;
    const next = current + 1;

    if (next >= this.threshold) {
      this.logger.info('Standing rule suggestion threshold reached', {
        category,
        count: next,
        threshold: this.threshold,
      });
      this.approvalCounts.set(category, 0);
      return true;
    }

    this.approvalCounts.set(category, next);
    return false;
  }

  // -------------------------------------------------------------------------
  // createRule
  // -------------------------------------------------------------------------

  /**
   * Create a new standing rule.
   *
   * @param options - Rule creation options
   * @returns The created standing rule
   */
  async createRule(options: CreateRuleOptions): Promise<StandingRule> {
    const id = generateId();
    const now = new Date().toISOString();
    const scope = options.scope ?? 'global';
    const verdict = options.verdict ?? 'approve';
    const createdBy = options.createdBy ?? 'system';
    const approvalCount = options.approvalCount ?? 0;
    const expiresAt = options.expiresAt ?? null;

    await this.db.run(
      'meridian',
      `INSERT INTO standing_rules (id, action_pattern, scope, verdict, created_at, expires_at, created_by, approval_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, options.actionPattern, scope, verdict, now, expiresAt, createdBy, approvalCount],
    );

    const rule: StandingRule = {
      id,
      actionPattern: options.actionPattern,
      scope,
      verdict,
      createdAt: now,
      expiresAt,
      createdBy,
      approvalCount,
    };

    this.logger.info('Standing rule created', {
      ruleId: id,
      actionPattern: options.actionPattern,
      scope,
      verdict,
    });

    return rule;
  }

  // -------------------------------------------------------------------------
  // listRules
  // -------------------------------------------------------------------------

  /**
   * List all non-expired standing rules.
   *
   * @returns Array of active standing rules
   */
  async listRules(): Promise<StandingRule[]> {
    const now = new Date().toISOString();

    const rows = await this.db.query<StandingRuleRow>(
      'meridian',
      `SELECT * FROM standing_rules
       WHERE (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
      [now],
    );

    return rows.map(rowToRule);
  }

  // -------------------------------------------------------------------------
  // deleteRule
  // -------------------------------------------------------------------------

  /**
   * Delete a standing rule by ID.
   *
   * @param ruleId - The ID of the rule to delete
   * @returns true if the rule was deleted, false if not found
   */
  async deleteRule(ruleId: string): Promise<boolean> {
    const result = await this.db.run(
      'meridian',
      'DELETE FROM standing_rules WHERE id = ?',
      [ruleId],
    );

    const deleted = result.changes > 0;

    if (deleted) {
      this.logger.info('Standing rule deleted', { ruleId });
    }

    return deleted;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Extract the category from an action pattern.
   * The category is the prefix before the first ':'.
   * If there is no ':', the entire pattern is the category.
   */
  private extractCategory(actionPattern: string): string {
    const colonIndex = actionPattern.indexOf(':');
    if (colonIndex === -1) {
      return actionPattern;
    }
    return actionPattern.slice(0, colonIndex);
  }

  /**
   * Check if a rule pattern matches an action pattern.
   *
   * Supports:
   * - Exact match: 'file-manager:read_file' matches 'file-manager:read_file'
   * - Glob prefix: 'file-manager:*' matches 'file-manager:read_file'
   */
  private matchesPattern(rulePattern: string, actionPattern: string): boolean {
    if (rulePattern === actionPattern) {
      return true;
    }

    if (rulePattern.endsWith(':*')) {
      const prefix = rulePattern.slice(0, -1); // Remove '*', keep ':'
      return actionPattern.startsWith(prefix);
    }

    return false;
  }
}
