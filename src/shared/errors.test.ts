import { describe, it, expect } from 'vitest';

import {
  MeridianError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  TimeoutError,
  RateLimitError,
  GearSandboxError,
  LLMProviderError,
  PlanValidationError,
  SecretAccessError,
} from './errors.js';

describe('MeridianError', () => {
  it('should extend Error', () => {
    const error = new MeridianError('ERR_TEST', 'test message');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MeridianError);
  });

  it('should have code and message properties', () => {
    const error = new MeridianError('ERR_TEST', 'test message');
    expect(error.code).toBe('ERR_TEST');
    expect(error.message).toBe('test message');
    expect(error.name).toBe('MeridianError');
  });

  it('should support Error cause via options', () => {
    const cause = new Error('root cause');
    const error = new MeridianError('ERR_TEST', 'wrapper', { cause });
    expect(error.cause).toBe(cause);
  });

  it('should produce a meaningful stack trace', () => {
    const error = new MeridianError('ERR_TEST', 'test');
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('MeridianError');
  });
});

describe('Error subclasses', () => {
  const cases: Array<{
    Class: new (message: string) => MeridianError;
    code: string;
    name: string;
  }> = [
    { Class: ValidationError, code: 'ERR_VALIDATION', name: 'ValidationError' },
    { Class: AuthenticationError, code: 'ERR_AUTH', name: 'AuthenticationError' },
    { Class: AuthorizationError, code: 'ERR_AUTHZ', name: 'AuthorizationError' },
    { Class: NotFoundError, code: 'ERR_NOT_FOUND', name: 'NotFoundError' },
    { Class: ConflictError, code: 'ERR_CONFLICT', name: 'ConflictError' },
    { Class: TimeoutError, code: 'ERR_TIMEOUT', name: 'TimeoutError' },
    { Class: RateLimitError, code: 'ERR_RATE_LIMIT', name: 'RateLimitError' },
    { Class: GearSandboxError, code: 'ERR_GEAR_SANDBOX', name: 'GearSandboxError' },
    { Class: LLMProviderError, code: 'ERR_LLM_PROVIDER', name: 'LLMProviderError' },
    { Class: PlanValidationError, code: 'ERR_PLAN_VALIDATION', name: 'PlanValidationError' },
    { Class: SecretAccessError, code: 'ERR_SECRET_ACCESS', name: 'SecretAccessError' },
  ];

  for (const { Class, code, name } of cases) {
    describe(name, () => {
      it('should extend MeridianError', () => {
        const error = new Class('test');
        expect(error).toBeInstanceOf(MeridianError);
        expect(error).toBeInstanceOf(Error);
      });

      it(`should have code '${code}'`, () => {
        const error = new Class('test');
        expect(error.code).toBe(code);
      });

      it(`should have name '${name}'`, () => {
        const error = new Class('test');
        expect(error.name).toBe(name);
      });

      it('should preserve the error message', () => {
        const error = new Class('specific message');
        expect(error.message).toBe('specific message');
      });
    });
  }
});
