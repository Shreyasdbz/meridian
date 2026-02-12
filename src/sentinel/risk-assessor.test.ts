import { describe, it, expect } from 'vitest';

import type { ExecutionStep, RiskLevel } from '@meridian/shared';

import {
  RISK_LEVEL_ORDER,
  assessStepRisk,
  checkRiskDivergence,
  classifyAction,
} from './risk-assessor.js';

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

// ---------------------------------------------------------------------------
// classifyAction
// ---------------------------------------------------------------------------

describe('classifyAction', () => {
  describe('shell execution', () => {
    it('should classify shell gear as shell_execute', () => {
      expect(classifyAction(createStep({ gear: 'shell' }))).toBe('shell_execute');
    });

    it('should classify terminal gear as shell_execute', () => {
      expect(classifyAction(createStep({ gear: 'terminal' }))).toBe('shell_execute');
    });

    it('should classify command gear as shell_execute', () => {
      expect(classifyAction(createStep({ gear: 'command-runner' }))).toBe('shell_execute');
    });

    it('should classify execute action as shell_execute', () => {
      expect(
        classifyAction(createStep({ gear: 'custom', action: 'execute' })),
      ).toBe('shell_execute');
    });

    it('should not classify sql execute as shell_execute', () => {
      expect(
        classifyAction(createStep({ gear: 'sql-db', action: 'execute' })),
      ).not.toBe('shell_execute');
    });
  });

  describe('financial transactions', () => {
    it('should classify payment gear as financial_transaction', () => {
      expect(classifyAction(createStep({ gear: 'payment-gateway' }))).toBe(
        'financial_transaction',
      );
    });

    it('should classify stripe gear as financial_transaction', () => {
      expect(classifyAction(createStep({ gear: 'stripe' }))).toBe(
        'financial_transaction',
      );
    });

    it('should classify charge action as financial_transaction', () => {
      expect(
        classifyAction(createStep({ gear: 'custom', action: 'charge' })),
      ).toBe('financial_transaction');
    });

    it('should classify transfer action as financial_transaction', () => {
      expect(
        classifyAction(createStep({ gear: 'custom', action: 'transfer' })),
      ).toBe('financial_transaction');
    });
  });

  describe('system configuration', () => {
    it('should classify config gear with write action as system_config', () => {
      expect(
        classifyAction(createStep({ gear: 'config-manager', action: 'update' })),
      ).toBe('system_config');
    });

    it('should classify install action as system_config', () => {
      expect(
        classifyAction(createStep({ gear: 'package', action: 'install' })),
      ).toBe('system_config');
    });

    it('should not classify config gear with read action as system_config', () => {
      expect(
        classifyAction(createStep({ gear: 'config-manager', action: 'read' })),
      ).not.toBe('system_config');
    });

    it('should classify configure action as system_config', () => {
      expect(
        classifyAction(createStep({ gear: 'custom', action: 'configure' })),
      ).toBe('system_config');
    });
  });

  describe('credential usage', () => {
    it('should classify credential gear as credential_usage', () => {
      expect(classifyAction(createStep({ gear: 'credential-manager' }))).toBe(
        'credential_usage',
      );
    });

    it('should classify vault gear as credential_usage', () => {
      expect(classifyAction(createStep({ gear: 'vault' }))).toBe('credential_usage');
    });

    it('should classify auth gear as credential_usage', () => {
      expect(classifyAction(createStep({ gear: 'auth-provider' }))).toBe(
        'credential_usage',
      );
    });

    it('should classify authenticate action as credential_usage', () => {
      expect(
        classifyAction(createStep({ gear: 'custom', action: 'authenticate' })),
      ).toBe('credential_usage');
    });
  });

  describe('message sending', () => {
    it('should classify email gear as send_message', () => {
      expect(classifyAction(createStep({ gear: 'email-sender' }))).toBe(
        'send_message',
      );
    });

    it('should classify slack gear as send_message', () => {
      expect(classifyAction(createStep({ gear: 'slack' }))).toBe('send_message');
    });

    it('should classify send action as send_message', () => {
      expect(
        classifyAction(createStep({ gear: 'custom', action: 'send' })),
      ).toBe('send_message');
    });

    it('should not classify send action on web gear as send_message', () => {
      expect(
        classifyAction(createStep({ gear: 'web-api', action: 'send' })),
      ).not.toBe('send_message');
    });

    it('should classify notification gear as send_message', () => {
      expect(classifyAction(createStep({ gear: 'notification' }))).toBe(
        'send_message',
      );
    });
  });

  describe('network operations', () => {
    it('should classify web-fetch gear GET as network_get', () => {
      expect(
        classifyAction(
          createStep({
            gear: 'web-fetch',
            action: 'get',
            parameters: {},
          }),
        ),
      ).toBe('network_get');
    });

    it('should classify fetch action as network_get by default', () => {
      expect(
        classifyAction(
          createStep({
            gear: 'web-fetch',
            action: 'fetch',
            parameters: {},
          }),
        ),
      ).toBe('network_get');
    });

    it('should classify web-fetch with POST method as network_mutate', () => {
      expect(
        classifyAction(
          createStep({
            gear: 'web-fetch',
            action: 'fetch',
            parameters: { method: 'POST' },
          }),
        ),
      ).toBe('network_mutate');
    });

    it('should classify api gear with delete action as network_mutate', () => {
      expect(
        classifyAction(
          createStep({
            gear: 'api-client',
            action: 'request',
            parameters: { method: 'DELETE' },
          }),
        ),
      ).toBe('network_mutate');
    });

    it('should prioritize method param over action name', () => {
      expect(
        classifyAction(
          createStep({
            gear: 'web-fetch',
            action: 'get',
            parameters: { method: 'POST' },
          }),
        ),
      ).toBe('network_mutate');
    });

    it('should classify webhook gear as network', () => {
      expect(
        classifyAction(
          createStep({ gear: 'webhook', action: 'send' }),
        ),
      ).toBe('network_mutate');
    });
  });

  describe('file operations', () => {
    it('should classify file-manager read as read_files', () => {
      expect(
        classifyAction(
          createStep({ gear: 'file-manager', action: 'read' }),
        ),
      ).toBe('read_files');
    });

    it('should classify file-manager write as write_files', () => {
      expect(
        classifyAction(
          createStep({ gear: 'file-manager', action: 'write' }),
        ),
      ).toBe('write_files');
    });

    it('should classify file-manager delete as delete_files', () => {
      expect(
        classifyAction(
          createStep({ gear: 'file-manager', action: 'delete' }),
        ),
      ).toBe('delete_files');
    });

    it('should classify file-manager list as read_files', () => {
      expect(
        classifyAction(
          createStep({ gear: 'file-manager', action: 'list' }),
        ),
      ).toBe('read_files');
    });

    it('should classify mkdir action as write_files', () => {
      expect(
        classifyAction(
          createStep({ gear: 'file-manager', action: 'mkdir' }),
        ),
      ).toBe('write_files');
    });

    it('should classify unlink action as delete_files', () => {
      expect(
        classifyAction(
          createStep({ gear: 'file-manager', action: 'unlink' }),
        ),
      ).toBe('delete_files');
    });

    it('should default file gear to read_files for unknown action', () => {
      expect(
        classifyAction(
          createStep({ gear: 'file-manager', action: 'info' }),
        ),
      ).toBe('read_files');
    });
  });

  describe('parameter-based hints', () => {
    it('should classify by amount/currency params as financial_transaction', () => {
      expect(
        classifyAction(
          createStep({
            gear: 'custom',
            action: 'process',
            parameters: { amount: 50, currency: 'USD' },
          }),
        ),
      ).toBe('financial_transaction');
    });

    it('should classify by url param as network_get', () => {
      expect(
        classifyAction(
          createStep({
            gear: 'custom',
            action: 'process',
            parameters: { url: 'https://example.com' },
          }),
        ),
      ).toBe('network_get');
    });
  });

  describe('unknown classification', () => {
    it('should return unknown for unrecognizable step', () => {
      expect(
        classifyAction(
          createStep({
            gear: 'custom',
            action: 'process',
            parameters: {},
          }),
        ),
      ).toBe('unknown');
    });
  });

  describe('camelCase and mixed-case support', () => {
    it('should handle camelCase gear names', () => {
      expect(
        classifyAction(createStep({ gear: 'fileManager', action: 'read' })),
      ).toBe('read_files');
    });

    it('should handle camelCase action names', () => {
      expect(
        classifyAction(
          createStep({ gear: 'file-manager', action: 'deleteFile' }),
        ),
      ).toBe('delete_files');
    });
  });
});

// ---------------------------------------------------------------------------
// assessStepRisk
// ---------------------------------------------------------------------------

describe('assessStepRisk', () => {
  const riskCases: [Partial<ExecutionStep>, RiskLevel][] = [
    [{ gear: 'file-manager', action: 'read' }, 'low'],
    [{ gear: 'file-manager', action: 'write' }, 'medium'],
    [{ gear: 'file-manager', action: 'delete' }, 'high'],
    [{ gear: 'web-fetch', action: 'get' }, 'low'],
    [{ gear: 'web-fetch', action: 'fetch', parameters: { method: 'POST' } }, 'high'],
    [{ gear: 'shell', action: 'execute' }, 'critical'],
    [{ gear: 'credential-manager', action: 'get' }, 'medium'],
    [{ gear: 'payment', action: 'charge' }, 'critical'],
    [{ gear: 'email-sender', action: 'send' }, 'high'],
    [{ gear: 'config-manager', action: 'update' }, 'critical'],
    [{ gear: 'custom', action: 'process' }, 'high'], // unknown → high
  ];

  it.each(riskCases)(
    'should assess %o as %s risk',
    (stepOverrides, expectedRisk) => {
      const step = createStep(stepOverrides);
      expect(assessStepRisk(step)).toBe(expectedRisk);
    },
  );
});

// ---------------------------------------------------------------------------
// checkRiskDivergence
// ---------------------------------------------------------------------------

describe('checkRiskDivergence', () => {
  it('should return null when risk levels are the same', () => {
    expect(checkRiskDivergence('step-1', 'low', 'low')).toBeNull();
  });

  it('should return null when risk levels differ by one level', () => {
    expect(checkRiskDivergence('step-1', 'low', 'medium')).toBeNull();
    expect(checkRiskDivergence('step-1', 'medium', 'high')).toBeNull();
    expect(checkRiskDivergence('step-1', 'high', 'critical')).toBeNull();
  });

  it('should detect divergence when risk levels differ by two levels', () => {
    const result = checkRiskDivergence('step-1', 'low', 'high');
    expect(result).not.toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        stepId: 'step-1',
        scoutRisk: 'low',
        sentinelRisk: 'high',
        difference: 2,
      }),
    );
  });

  it('should detect divergence when risk levels differ by three levels', () => {
    const result = checkRiskDivergence('step-1', 'low', 'critical');
    expect(result).not.toBeNull();
    expect(result).toEqual(
      expect.objectContaining({ difference: 3 }),
    );
  });

  it('should detect divergence in both directions', () => {
    const result = checkRiskDivergence('step-1', 'critical', 'low');
    expect(result).not.toBeNull();
    expect(result).toEqual(
      expect.objectContaining({ difference: 3 }),
    );
  });
});

// ---------------------------------------------------------------------------
// RISK_LEVEL_ORDER
// ---------------------------------------------------------------------------

describe('RISK_LEVEL_ORDER', () => {
  it('should order risk levels from low to critical', () => {
    expect(RISK_LEVEL_ORDER['low']).toBeLessThan(RISK_LEVEL_ORDER['medium']);
    expect(RISK_LEVEL_ORDER['medium']).toBeLessThan(RISK_LEVEL_ORDER['high']);
    expect(RISK_LEVEL_ORDER['high']).toBeLessThan(RISK_LEVEL_ORDER['critical']);
  });
});
