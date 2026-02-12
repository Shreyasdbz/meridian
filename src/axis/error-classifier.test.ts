import { describe, it, expect } from 'vitest';

import {
  classifyError,
  extractStatusCode,
  isTimeoutError,
  computeBackoffDelay,
  shouldRetry,
} from './error-classifier.js';


// ---------------------------------------------------------------------------
// extractStatusCode
// ---------------------------------------------------------------------------

describe('extractStatusCode', () => {
  it('should extract .status from an error object', () => {
    expect(extractStatusCode({ status: 429 })).toBe(429);
  });

  it('should extract .statusCode from an error object', () => {
    expect(extractStatusCode({ statusCode: 500 })).toBe(500);
  });

  it('should extract .response.status (axios-style)', () => {
    expect(extractStatusCode({ response: { status: 502 } })).toBe(502);
  });

  it('should prefer .status over .response.status', () => {
    expect(extractStatusCode({ status: 401, response: { status: 500 } })).toBe(401);
  });

  it('should return undefined for null', () => {
    expect(extractStatusCode(null)).toBeUndefined();
  });

  it('should return undefined for undefined', () => {
    expect(extractStatusCode(undefined)).toBeUndefined();
  });

  it('should return undefined for a string', () => {
    expect(extractStatusCode('error')).toBeUndefined();
  });

  it('should return undefined for a number', () => {
    expect(extractStatusCode(42)).toBeUndefined();
  });

  it('should return undefined when status is not a number', () => {
    expect(extractStatusCode({ status: '429' })).toBeUndefined();
  });

  it('should return undefined for an empty object', () => {
    expect(extractStatusCode({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isTimeoutError
// ---------------------------------------------------------------------------

describe('isTimeoutError', () => {
  it('should detect ERR_TIMEOUT code', () => {
    expect(isTimeoutError({ code: 'ERR_TIMEOUT' })).toBe(true);
  });

  it('should detect ETIMEDOUT code', () => {
    expect(isTimeoutError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('should detect ECONNABORTED code', () => {
    expect(isTimeoutError({ code: 'ECONNABORTED' })).toBe(true);
  });

  it('should detect TimeoutError name', () => {
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(true);
  });

  it('should detect AbortError name', () => {
    expect(isTimeoutError({ name: 'AbortError' })).toBe(true);
  });

  it('should return false for generic Error', () => {
    expect(isTimeoutError(new Error('something'))).toBe(false);
  });

  it('should return false for null', () => {
    expect(isTimeoutError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isTimeoutError(undefined)).toBe(false);
  });

  it('should return false for a number', () => {
    expect(isTimeoutError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyError — HTTP status codes
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  describe('retriable HTTP status codes', () => {
    const retriableCodes = [429, 500, 502, 503, 504];

    for (const code of retriableCodes) {
      it(`should classify ${code} as retriable`, () => {
        const result = classifyError({ status: code });
        expect(result.category).toBe('retriable');
        expect(result.retriable).toBe(true);
        expect(result.statusCode).toBe(code);
      });
    }
  });

  describe('non-retriable credential HTTP status codes', () => {
    const credentialCodes = [401, 403];

    for (const code of credentialCodes) {
      it(`should classify ${code} as non_retriable_credential`, () => {
        const result = classifyError({ status: code });
        expect(result.category).toBe('non_retriable_credential');
        expect(result.retriable).toBe(false);
        expect(result.statusCode).toBe(code);
      });
    }
  });

  describe('non-retriable client HTTP status codes', () => {
    const clientCodes = [400, 404, 422];

    for (const code of clientCodes) {
      it(`should classify ${code} as non_retriable_client`, () => {
        const result = classifyError({ status: code });
        expect(result.category).toBe('non_retriable_client');
        expect(result.retriable).toBe(false);
        expect(result.statusCode).toBe(code);
      });
    }
  });

  describe('non-retriable quota HTTP status codes', () => {
    it('should classify 402 as non_retriable_quota', () => {
      const result = classifyError({ status: 402 });
      expect(result.category).toBe('non_retriable_quota');
      expect(result.retriable).toBe(false);
      expect(result.statusCode).toBe(402);
    });
  });

  describe('unmapped HTTP status codes', () => {
    it('should classify unmapped 4xx as non_retriable_client', () => {
      const result = classifyError({ status: 418 });
      expect(result.category).toBe('non_retriable_client');
      expect(result.retriable).toBe(false);
      expect(result.statusCode).toBe(418);
    });

    it('should classify unmapped 5xx as retriable', () => {
      const result = classifyError({ status: 599 });
      expect(result.category).toBe('retriable');
      expect(result.retriable).toBe(true);
      expect(result.statusCode).toBe(599);
    });
  });

  describe('timeout errors', () => {
    it('should classify timeout errors as retriable', () => {
      const result = classifyError({ name: 'TimeoutError' });
      expect(result.category).toBe('retriable');
      expect(result.retriable).toBe(true);
      expect(result.statusCode).toBeUndefined();
    });

    it('should classify AbortError as retriable', () => {
      const result = classifyError({ name: 'AbortError' });
      expect(result.category).toBe('retriable');
      expect(result.retriable).toBe(true);
    });

    it('should classify ETIMEDOUT as retriable', () => {
      const result = classifyError({ code: 'ETIMEDOUT' });
      expect(result.category).toBe('retriable');
      expect(result.retriable).toBe(true);
    });
  });

  describe('unknown errors', () => {
    it('should classify generic Error as retriable (fail-safe)', () => {
      const result = classifyError(new Error('network failure'));
      expect(result.category).toBe('retriable');
      expect(result.retriable).toBe(true);
    });

    it('should classify null as retriable', () => {
      const result = classifyError(null);
      expect(result.category).toBe('retriable');
      expect(result.retriable).toBe(true);
    });

    it('should classify string error as retriable', () => {
      const result = classifyError('something broke');
      expect(result.category).toBe('retriable');
      expect(result.retriable).toBe(true);
    });
  });

  describe('HTTP status takes precedence over timeout name', () => {
    it('should use HTTP status when both status and timeout name present', () => {
      const result = classifyError({ status: 401, name: 'TimeoutError' });
      expect(result.category).toBe('non_retriable_credential');
      expect(result.retriable).toBe(false);
      expect(result.statusCode).toBe(401);
    });
  });

  it('should preserve the original error in the result', () => {
    const original = { status: 429, message: 'rate limited' };
    const result = classifyError(original);
    expect(result.error).toBe(original);
  });

  it('should include a reason string', () => {
    const result = classifyError({ status: 500 });
    expect(result.reason).toBeTruthy();
    expect(typeof result.reason).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// computeBackoffDelay
// ---------------------------------------------------------------------------

describe('computeBackoffDelay', () => {
  // Use fixed random for deterministic tests
  const fixedRandom = (value: number) => () => value;

  it('should return base delay on attempt 0 with zero jitter', () => {
    expect(computeBackoffDelay(0, fixedRandom(0))).toBe(1_000);
  });

  it('should double the base on each attempt', () => {
    expect(computeBackoffDelay(0, fixedRandom(0))).toBe(1_000);
    expect(computeBackoffDelay(1, fixedRandom(0))).toBe(2_000);
    expect(computeBackoffDelay(2, fixedRandom(0))).toBe(4_000);
    expect(computeBackoffDelay(3, fixedRandom(0))).toBe(8_000);
    expect(computeBackoffDelay(4, fixedRandom(0))).toBe(16_000);
  });

  it('should add jitter up to 1000ms', () => {
    // With max jitter (random=0.999...)
    const delay = computeBackoffDelay(0, fixedRandom(0.999));
    expect(delay).toBe(1_000 + 999); // base + floor(0.999 * 1000)
  });

  it('should cap at 30000ms', () => {
    // Attempt 5: 1000 * 2^5 = 32000, capped to 30000
    expect(computeBackoffDelay(5, fixedRandom(0))).toBe(30_000);
  });

  it('should cap at 30000ms even with jitter', () => {
    // Very high attempt with full jitter
    expect(computeBackoffDelay(10, fixedRandom(0.999))).toBe(30_000);
  });

  it('should never return negative values', () => {
    expect(computeBackoffDelay(0, fixedRandom(0))).toBeGreaterThan(0);
  });

  it('should produce different delays with different random values', () => {
    const delay1 = computeBackoffDelay(1, fixedRandom(0.1));
    const delay2 = computeBackoffDelay(1, fixedRandom(0.9));
    expect(delay1).not.toBe(delay2);
  });
});

// ---------------------------------------------------------------------------
// shouldRetry
// ---------------------------------------------------------------------------

describe('shouldRetry', () => {
  const fixedRandom = (value: number) => () => value;

  it('should retry a retriable error on first attempt', () => {
    const result = shouldRetry({ status: 500 }, 0, 3, fixedRandom(0));
    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBeGreaterThan(0);
    expect(result.classified.category).toBe('retriable');
  });

  it('should not retry when max attempts reached', () => {
    const result = shouldRetry({ status: 500 }, 2, 3, fixedRandom(0));
    expect(result.shouldRetry).toBe(false);
    expect(result.delayMs).toBe(0);
  });

  it('should not retry non-retriable errors', () => {
    const result = shouldRetry({ status: 401 }, 0, 3, fixedRandom(0));
    expect(result.shouldRetry).toBe(false);
    expect(result.delayMs).toBe(0);
    expect(result.classified.category).toBe('non_retriable_credential');
  });

  it('should not retry quota errors', () => {
    const result = shouldRetry({ status: 402 }, 0, 3, fixedRandom(0));
    expect(result.shouldRetry).toBe(false);
    expect(result.classified.category).toBe('non_retriable_quota');
  });

  it('should not retry client errors', () => {
    const result = shouldRetry({ status: 400 }, 0, 3, fixedRandom(0));
    expect(result.shouldRetry).toBe(false);
    expect(result.classified.category).toBe('non_retriable_client');
  });

  it('should retry timeout errors', () => {
    const result = shouldRetry({ name: 'TimeoutError' }, 0, 3, fixedRandom(0));
    expect(result.shouldRetry).toBe(true);
  });

  it('should increase delay with subsequent attempts', () => {
    const delay0 = shouldRetry({ status: 500 }, 0, 5, fixedRandom(0)).delayMs;
    const delay1 = shouldRetry({ status: 500 }, 1, 5, fixedRandom(0)).delayMs;
    const delay2 = shouldRetry({ status: 500 }, 2, 5, fixedRandom(0)).delayMs;
    expect(delay1).toBeGreaterThan(delay0);
    expect(delay2).toBeGreaterThan(delay1);
  });

  it('should not retry when maxAttempts is 1', () => {
    const result = shouldRetry({ status: 500 }, 0, 1, fixedRandom(0));
    expect(result.shouldRetry).toBe(false);
  });
});
