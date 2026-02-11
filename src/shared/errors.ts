// @meridian/shared — Typed error classes

/**
 * Base error class for all Meridian errors.
 * Every error carries a unique `code` string for programmatic handling.
 */
export class MeridianError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'MeridianError';
  }
}

export class ValidationError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_VALIDATION', message, options);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_AUTH', message, options);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_AUTHZ', message, options);
    this.name = 'AuthorizationError';
  }
}

export class NotFoundError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_NOT_FOUND', message, options);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_CONFLICT', message, options);
    this.name = 'ConflictError';
  }
}

export class TimeoutError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_TIMEOUT', message, options);
    this.name = 'TimeoutError';
  }
}

export class RateLimitError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_RATE_LIMIT', message, options);
    this.name = 'RateLimitError';
  }
}

export class GearSandboxError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_GEAR_SANDBOX', message, options);
    this.name = 'GearSandboxError';
  }
}

export class LLMProviderError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_LLM_PROVIDER', message, options);
    this.name = 'LLMProviderError';
  }
}

export class PlanValidationError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_PLAN_VALIDATION', message, options);
    this.name = 'PlanValidationError';
  }
}

export class SecretAccessError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_SECRET_ACCESS', message, options);
    this.name = 'SecretAccessError';
  }
}
