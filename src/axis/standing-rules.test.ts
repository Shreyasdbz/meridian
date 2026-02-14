import { describe, it, expect, vi, beforeEach } from 'vitest';

import { StandingRuleEvaluator } from './standing-rules.js';
import type { StandingRuleEvaluatorLogger } from './standing-rules.js';

// ---------------------------------------------------------------------------
// Mock generateId
// ---------------------------------------------------------------------------

let idCounter = 0;

vi.mock('@meridian/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@meridian/shared')>();
  return {
    ...original,
    generateId: vi.fn(() => `rule-${String(++idCounter).padStart(3, '0')}`),
  };
});

// ---------------------------------------------------------------------------
// Types
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

interface MockDatabaseClient {
  query: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockDb(): MockDatabaseClient {
  return {
    query: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 0 }),
  };
}

function createMockLogger(): StandingRuleEvaluatorLogger & {
  messages: Array<{
    level: string;
    message: string;
    data?: Record<string, unknown>;
  }>;
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

function makeRuleRow(overrides: Partial<StandingRuleRow> = {}): StandingRuleRow {
  return {
    id: 'rule-001',
    action_pattern: 'file-manager:*',
    scope: 'global',
    verdict: 'approve',
    created_at: '2026-02-01T00:00:00.000Z',
    expires_at: null,
    created_by: 'user',
    approval_count: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StandingRuleEvaluator', () => {
  let db: MockDatabaseClient;
  let logger: ReturnType<typeof createMockLogger>;
  let evaluator: StandingRuleEvaluator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-13T12:00:00.000Z'));

    idCounter = 0;
    db = createMockDb();
    logger = createMockLogger();

    evaluator = new StandingRuleEvaluator({
      db: db as unknown as ConstructorParameters<typeof StandingRuleEvaluator>[0]['db'],
      logger,
    });
  });

  // -------------------------------------------------------------------------
  // matchRule
  // -------------------------------------------------------------------------

  describe('matchRule()', () => {
    it('should return a rule on exact match', async () => {
      const row = makeRuleRow({
        action_pattern: 'file-manager:read_file',
      });
      db.query.mockResolvedValueOnce([row]);

      const result = await evaluator.matchRule('file-manager:read_file');

      expect(result).toBeDefined();
      expect(result?.id).toBe('rule-001');
      expect(result?.actionPattern).toBe('file-manager:read_file');
      expect(result?.verdict).toBe('approve');
    });

    it('should return a rule on glob-style prefix match', async () => {
      const row = makeRuleRow({ action_pattern: 'file-manager:*' });
      db.query.mockResolvedValueOnce([row]);

      const result = await evaluator.matchRule('file-manager:read_file');

      expect(result).toBeDefined();
      expect(result?.id).toBe('rule-001');
      expect(result?.actionPattern).toBe('file-manager:*');
    });

    it('should not match a glob pattern against a different prefix', async () => {
      const row = makeRuleRow({ action_pattern: 'file-manager:*' });
      db.query.mockResolvedValueOnce([row]);

      const result = await evaluator.matchRule('network:fetch');

      expect(result).toBeUndefined();
    });

    it('should ignore expired rules (filtered by query)', async () => {
      // The query filters with expires_at IS NULL OR expires_at > now,
      // so expired rules should not appear in the result set.
      db.query.mockResolvedValueOnce([]);

      const result = await evaluator.matchRule('file-manager:read_file');

      expect(result).toBeUndefined();

      // Verify the query uses the correct filter
      const [, sql, params] = db.query.mock.calls[0] as [string, string, unknown[]];
      expect(sql).toContain('expires_at IS NULL OR expires_at > ?');
      expect(params[0]).toBe('2026-02-13T12:00:00.000Z');
    });

    it('should return undefined when no rules match', async () => {
      const row = makeRuleRow({ action_pattern: 'shell:execute' });
      db.query.mockResolvedValueOnce([row]);

      const result = await evaluator.matchRule('file-manager:read_file');

      expect(result).toBeUndefined();
    });

    it('should return the first matching rule when multiple exist', async () => {
      const row1 = makeRuleRow({
        id: 'rule-001',
        action_pattern: 'file-manager:*',
        verdict: 'approve',
      });
      const row2 = makeRuleRow({
        id: 'rule-002',
        action_pattern: 'file-manager:read_file',
        verdict: 'deny',
      });
      db.query.mockResolvedValueOnce([row1, row2]);

      const result = await evaluator.matchRule('file-manager:read_file');

      // Should match the first row (glob pattern), since rows are ordered by created_at DESC
      expect(result?.id).toBe('rule-001');
    });

    it('should log when a rule is matched', async () => {
      const row = makeRuleRow({ action_pattern: 'file-manager:*' });
      db.query.mockResolvedValueOnce([row]);

      await evaluator.matchRule('file-manager:read_file');

      const logMsg = logger.messages.find(
        (m) => m.message === 'Standing rule matched',
      );
      expect(logMsg).toBeDefined();
      expect(logMsg?.data?.ruleId).toBe('rule-001');
      expect(logMsg?.data?.rulePattern).toBe('file-manager:*');
      expect(logMsg?.data?.actionPattern).toBe('file-manager:read_file');
    });

    it('should correctly map database row fields to StandingRule properties', async () => {
      const row = makeRuleRow({
        id: 'rule-abc',
        action_pattern: 'net:fetch',
        scope: 'conversation',
        verdict: 'deny',
        created_at: '2026-01-15T08:00:00.000Z',
        expires_at: '2026-12-31T23:59:59.000Z',
        created_by: 'system',
        approval_count: 10,
      });
      db.query.mockResolvedValueOnce([row]);

      const result = await evaluator.matchRule('net:fetch');

      expect(result).toEqual({
        id: 'rule-abc',
        actionPattern: 'net:fetch',
        scope: 'conversation',
        verdict: 'deny',
        createdAt: '2026-01-15T08:00:00.000Z',
        expiresAt: '2026-12-31T23:59:59.000Z',
        createdBy: 'system',
        approvalCount: 10,
      });
    });
  });

  // -------------------------------------------------------------------------
  // suggestRule
  // -------------------------------------------------------------------------

  describe('suggestRule()', () => {
    it('should return false when count is below the threshold', async () => {
      const result = await evaluator.suggestRule('file-manager:read_file');

      expect(result).toBe(false);
    });

    it('should return false for subsequent calls below threshold', async () => {
      // Default threshold is 5 (STANDING_RULE_SUGGESTION_COUNT)
      for (let i = 0; i < 4; i++) {
        const result = await evaluator.suggestRule('file-manager:read_file');
        expect(result).toBe(false);
      }
    });

    it('should return true when count reaches the threshold', async () => {
      // Calls 1-4 should return false
      for (let i = 0; i < 4; i++) {
        await evaluator.suggestRule('file-manager:read_file');
      }

      // Call 5 should return true (threshold reached)
      const result = await evaluator.suggestRule('file-manager:read_file');
      expect(result).toBe(true);
    });

    it('should reset the counter after reaching the threshold', async () => {
      // First batch: reach threshold
      for (let i = 0; i < 5; i++) {
        await evaluator.suggestRule('file-manager:write_file');
      }

      // Counter is now reset to 0 -- next call should return false
      const result = await evaluator.suggestRule('file-manager:write_file');
      expect(result).toBe(false);
    });

    it('should track categories independently', async () => {
      // Approve file-manager actions 4 times
      for (let i = 0; i < 4; i++) {
        await evaluator.suggestRule('file-manager:read_file');
      }

      // Approve network actions 4 times
      for (let i = 0; i < 4; i++) {
        await evaluator.suggestRule('network:fetch');
      }

      // File-manager is at 4, network is at 4 -- neither has reached 5
      expect(await evaluator.suggestRule('file-manager:delete')).toBe(true); // 5th
      expect(await evaluator.suggestRule('network:post')).toBe(true); // 5th
    });

    it('should use the prefix before the first colon as the category', async () => {
      // These should all count toward the 'file-manager' category
      await evaluator.suggestRule('file-manager:read_file');
      await evaluator.suggestRule('file-manager:write_file');
      await evaluator.suggestRule('file-manager:delete');
      await evaluator.suggestRule('file-manager:list');

      const result = await evaluator.suggestRule('file-manager:move');
      expect(result).toBe(true);
    });

    it('should use the entire pattern as category when no colon is present', async () => {
      for (let i = 0; i < 4; i++) {
        await evaluator.suggestRule('shell');
      }

      const result = await evaluator.suggestRule('shell');
      expect(result).toBe(true);
    });

    it('should respect a custom suggestion threshold', async () => {
      const customEvaluator = new StandingRuleEvaluator({
        db: db as unknown as ConstructorParameters<typeof StandingRuleEvaluator>[0]['db'],
        logger,
        suggestionThreshold: 3,
      });

      await customEvaluator.suggestRule('net:fetch');
      await customEvaluator.suggestRule('net:post');

      const result = await customEvaluator.suggestRule('net:delete');
      expect(result).toBe(true);
    });

    it('should log when the threshold is reached', async () => {
      for (let i = 0; i < 5; i++) {
        await evaluator.suggestRule('file-manager:read');
      }

      const logMsg = logger.messages.find(
        (m) => m.message === 'Standing rule suggestion threshold reached',
      );
      expect(logMsg).toBeDefined();
      expect(logMsg?.data?.category).toBe('file-manager');
      expect(logMsg?.data?.count).toBe(5);
      expect(logMsg?.data?.threshold).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // createRule
  // -------------------------------------------------------------------------

  describe('createRule()', () => {
    it('should insert a rule with default values and return it', async () => {
      const rule = await evaluator.createRule({
        actionPattern: 'file-manager:*',
      });

      expect(rule.id).toBe('rule-001');
      expect(rule.actionPattern).toBe('file-manager:*');
      expect(rule.scope).toBe('global');
      expect(rule.verdict).toBe('approve');
      expect(rule.createdBy).toBe('system');
      expect(rule.approvalCount).toBe(0);
      expect(rule.expiresAt).toBeNull();
      expect(rule.createdAt).toBe('2026-02-13T12:00:00.000Z');
    });

    it('should insert a rule with custom values', async () => {
      const rule = await evaluator.createRule({
        actionPattern: 'network:*',
        scope: 'conversation',
        verdict: 'deny',
        expiresAt: '2026-12-31T23:59:59.000Z',
        createdBy: 'user',
        approvalCount: 10,
      });

      expect(rule.actionPattern).toBe('network:*');
      expect(rule.scope).toBe('conversation');
      expect(rule.verdict).toBe('deny');
      expect(rule.expiresAt).toBe('2026-12-31T23:59:59.000Z');
      expect(rule.createdBy).toBe('user');
      expect(rule.approvalCount).toBe(10);
    });

    it('should call db.run with the correct INSERT statement', async () => {
      await evaluator.createRule({
        actionPattern: 'file-manager:*',
        scope: 'global',
        verdict: 'approve',
      });

      expect(db.run).toHaveBeenCalledOnce();
      const [dbName, sql, params] = db.run.mock.calls[0] as [
        string,
        string,
        unknown[],
      ];
      expect(dbName).toBe('meridian');
      expect(sql).toContain('INSERT INTO standing_rules');
      expect(params).toEqual([
        'rule-001',
        'file-manager:*',
        'global',
        'approve',
        '2026-02-13T12:00:00.000Z',
        null,
        'system',
        0,
      ]);
    });

    it('should log when a rule is created', async () => {
      await evaluator.createRule({ actionPattern: 'file-manager:*' });

      const logMsg = logger.messages.find(
        (m) => m.message === 'Standing rule created',
      );
      expect(logMsg).toBeDefined();
      expect(logMsg?.data?.ruleId).toBe('rule-001');
      expect(logMsg?.data?.actionPattern).toBe('file-manager:*');
      expect(logMsg?.data?.scope).toBe('global');
      expect(logMsg?.data?.verdict).toBe('approve');
    });

    it('should generate unique IDs for each rule', async () => {
      const rule1 = await evaluator.createRule({ actionPattern: 'a:*' });
      const rule2 = await evaluator.createRule({ actionPattern: 'b:*' });

      expect(rule1.id).not.toBe(rule2.id);
    });
  });

  // -------------------------------------------------------------------------
  // listRules
  // -------------------------------------------------------------------------

  describe('listRules()', () => {
    it('should return all non-expired rules', async () => {
      const row1 = makeRuleRow({ id: 'rule-001', action_pattern: 'file-manager:*' });
      const row2 = makeRuleRow({ id: 'rule-002', action_pattern: 'network:*' });
      db.query.mockResolvedValueOnce([row1, row2]);

      const rules = await evaluator.listRules();

      expect(rules).toHaveLength(2);
      expect(rules[0]?.id).toBe('rule-001');
      expect(rules[1]?.id).toBe('rule-002');
    });

    it('should return an empty array when no active rules exist', async () => {
      db.query.mockResolvedValueOnce([]);

      const rules = await evaluator.listRules();

      expect(rules).toEqual([]);
    });

    it('should filter expired rules via the SQL query', async () => {
      db.query.mockResolvedValueOnce([]);

      await evaluator.listRules();

      const [, sql, params] = db.query.mock.calls[0] as [string, string, unknown[]];
      expect(sql).toContain('expires_at IS NULL OR expires_at > ?');
      expect(params[0]).toBe('2026-02-13T12:00:00.000Z');
    });

    it('should correctly map all row fields', async () => {
      const row = makeRuleRow({
        id: 'rule-xyz',
        action_pattern: 'shell:*',
        scope: 'conversation',
        verdict: 'deny',
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-06-01T00:00:00.000Z',
        created_by: 'user',
        approval_count: 3,
      });
      db.query.mockResolvedValueOnce([row]);

      const rules = await evaluator.listRules();

      expect(rules[0]).toEqual({
        id: 'rule-xyz',
        actionPattern: 'shell:*',
        scope: 'conversation',
        verdict: 'deny',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-06-01T00:00:00.000Z',
        createdBy: 'user',
        approvalCount: 3,
      });
    });
  });

  // -------------------------------------------------------------------------
  // deleteRule
  // -------------------------------------------------------------------------

  describe('deleteRule()', () => {
    it('should return true when a rule is deleted', async () => {
      db.run.mockResolvedValueOnce({ changes: 1, lastInsertRowid: 0 });

      const result = await evaluator.deleteRule('rule-001');

      expect(result).toBe(true);
    });

    it('should return false when the rule is not found', async () => {
      db.run.mockResolvedValueOnce({ changes: 0, lastInsertRowid: 0 });

      const result = await evaluator.deleteRule('nonexistent-rule');

      expect(result).toBe(false);
    });

    it('should call db.run with the correct DELETE statement', async () => {
      await evaluator.deleteRule('rule-abc');

      expect(db.run).toHaveBeenCalledOnce();
      const [dbName, sql, params] = db.run.mock.calls[0] as [
        string,
        string,
        unknown[],
      ];
      expect(dbName).toBe('meridian');
      expect(sql).toContain('DELETE FROM standing_rules WHERE id = ?');
      expect(params).toEqual(['rule-abc']);
    });

    it('should log when a rule is deleted', async () => {
      db.run.mockResolvedValueOnce({ changes: 1, lastInsertRowid: 0 });

      await evaluator.deleteRule('rule-001');

      const logMsg = logger.messages.find(
        (m) => m.message === 'Standing rule deleted',
      );
      expect(logMsg).toBeDefined();
      expect(logMsg?.data?.ruleId).toBe('rule-001');
    });

    it('should not log when the rule is not found', async () => {
      db.run.mockResolvedValueOnce({ changes: 0, lastInsertRowid: 0 });

      await evaluator.deleteRule('nonexistent');

      const logMsg = logger.messages.find(
        (m) => m.message === 'Standing rule deleted',
      );
      expect(logMsg).toBeUndefined();
    });
  });
});
