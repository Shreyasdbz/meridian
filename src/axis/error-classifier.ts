// @meridian/axis — Error classification & retry logic
// Architecture Reference: Section 5.1.11

// ---------------------------------------------------------------------------
// Error categories
// ---------------------------------------------------------------------------

/**
 * Classification of an error for retry decisions.
 *
 * - `retriable`: Transient failures (429, 5xx, timeouts) — retry with backoff.
 * - `non_retriable_credential`: Auth failures (401, 403) — stop, notify user.
 * - `non_retriable_client`: Client errors (400, 404, 422) — do not retry.
 * - `non_retriable_quota`: Quota/billing errors (402) — stop, notify user.
 */
export type ErrorCategory =
  | 'retriable'
  | 'non_retriable_credential'
  | 'non_retriable_client'
  | 'non_retriable_quota';

/**
 * Result of classifying an error.
 */
export interface ClassifiedError {
  /** The original error. */
  error: unknown;
  /** The classification category. */
  category: ErrorCategory;
  /** Whether the error should be retried. */
  retriable: boolean;
  /** HTTP status code if available, undefined for non-HTTP errors. */
  statusCode?: number;
  /** Human-readable reason for the classification. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Backoff constants
// ---------------------------------------------------------------------------

/** Base delay in milliseconds for exponential backoff. */
const BACKOFF_BASE_MS = 1_000;

/** Maximum jitter in milliseconds added to backoff delay. */
const BACKOFF_MAX_JITTER_MS = 1_000;

/** Maximum backoff delay in milliseconds (cap). */
const BACKOFF_MAX_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP status → category mapping
// ---------------------------------------------------------------------------

const STATUS_CATEGORIES: ReadonlyMap<number, ErrorCategory> = new Map([
  // Retriable: transient server/rate-limit errors
  [429, 'retriable'],
  [500, 'retriable'],
  [502, 'retriable'],
  [503, 'retriable'],
  [504, 'retriable'],

  // Non-retriable: credential/auth errors
  [401, 'non_retriable_credential'],
  [403, 'non_retriable_credential'],

  // Non-retriable: client errors
  [400, 'non_retriable_client'],
  [404, 'non_retriable_client'],
  [422, 'non_retriable_client'],

  // Non-retriable: quota/billing errors
  [402, 'non_retriable_quota'],
]);

const CATEGORY_REASONS: Record<ErrorCategory, string> = {
  retriable: 'Transient error — will retry with exponential backoff',
  non_retriable_credential: 'Authentication/authorization failure — requires user action',
  non_retriable_client: 'Client error — request is invalid and should not be retried',
  non_retriable_quota: 'Quota/billing limit reached — requires user action',
};

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Extract an HTTP status code from an error, if available.
 *
 * Looks for common patterns: `.status`, `.statusCode`, `.response.status`.
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (error === null || error === undefined || typeof error !== 'object') {
    return undefined;
  }

  const obj = error as Record<string, unknown>;

  if (typeof obj['status'] === 'number') {
    return obj['status'];
  }
  if (typeof obj['statusCode'] === 'number') {
    return obj['statusCode'];
  }

  // Nested .response.status (common in axios-style errors)
  const response = obj['response'];
  if (response !== null && response !== undefined && typeof response === 'object') {
    const resp = response as Record<string, unknown>;
    if (typeof resp['status'] === 'number') {
      return resp['status'];
    }
  }

  return undefined;
}

/**
 * Check if an error represents a timeout.
 *
 * Looks for: `.code === 'ERR_TIMEOUT'`, `.name === 'TimeoutError'`,
 * `.code === 'ETIMEDOUT'`, `.code === 'ECONNABORTED'`.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error === null || error === undefined || typeof error !== 'object') {
    return false;
  }

  const obj = error as Record<string, unknown>;

  if (obj['code'] === 'ERR_TIMEOUT' || obj['code'] === 'ETIMEDOUT' || obj['code'] === 'ECONNABORTED') {
    return true;
  }

  if (obj['name'] === 'TimeoutError') {
    return true;
  }

  // AbortError from AbortSignal.timeout() or AbortController
  if (obj['name'] === 'AbortError') {
    return true;
  }

  return false;
}

/**
 * Classify an error into a retry category.
 *
 * Classification precedence:
 * 1. HTTP status code (if extractable) → mapped category
 * 2. Timeout detection → retriable
 * 3. Unknown errors → retriable (fail-safe: retry unknown transient issues)
 */
export function classifyError(error: unknown): ClassifiedError {
  const statusCode = extractStatusCode(error);

  // 1. HTTP status code mapping
  if (statusCode !== undefined) {
    const category = STATUS_CATEGORIES.get(statusCode);
    if (category) {
      return {
        error,
        category,
        retriable: category === 'retriable',
        statusCode,
        reason: CATEGORY_REASONS[category],
      };
    }

    // Unmapped status codes: 4xx = client error, 5xx = retriable
    if (statusCode >= 400 && statusCode < 500) {
      return {
        error,
        category: 'non_retriable_client',
        retriable: false,
        statusCode,
        reason: `Unmapped client error (${statusCode}) — not retriable`,
      };
    }
    if (statusCode >= 500) {
      return {
        error,
        category: 'retriable',
        retriable: true,
        statusCode,
        reason: `Server error (${statusCode}) — will retry with exponential backoff`,
      };
    }
  }

  // 2. Timeout errors
  if (isTimeoutError(error)) {
    return {
      error,
      category: 'retriable',
      retriable: true,
      reason: 'Timeout — will retry with exponential backoff',
    };
  }

  // 3. Unknown/network errors — default to retriable (fail-safe)
  return {
    error,
    category: 'retriable',
    retriable: true,
    reason: 'Unknown error — defaulting to retriable',
  };
}

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

/**
 * Compute the backoff delay for a given retry attempt.
 *
 * Formula: `min(1000 * 2^attempt + random(0, 1000), 30000)`
 *
 * @param attempt — Zero-based attempt number (0 = first retry)
 * @param randomFn — Optional random function for deterministic testing (returns 0–1)
 * @returns Delay in milliseconds before the next retry
 */
export function computeBackoffDelay(
  attempt: number,
  randomFn: () => number = Math.random,
): number {
  const exponential = BACKOFF_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.floor(randomFn() * BACKOFF_MAX_JITTER_MS);
  return Math.min(exponential + jitter, BACKOFF_MAX_DELAY_MS);
}

/**
 * Determine whether a failed operation should be retried.
 *
 * @param error — The error from the failed operation
 * @param attempt — Zero-based current attempt number
 * @param maxAttempts — Maximum number of attempts (total, including first)
 * @returns Object with `shouldRetry` flag and `delayMs` (0 if no retry)
 */
export function shouldRetry(
  error: unknown,
  attempt: number,
  maxAttempts: number,
  randomFn: () => number = Math.random,
): { shouldRetry: boolean; delayMs: number; classified: ClassifiedError } {
  const classified = classifyError(error);

  if (!classified.retriable || attempt >= maxAttempts - 1) {
    return { shouldRetry: false, delayMs: 0, classified };
  }

  const delayMs = computeBackoffDelay(attempt, randomFn);
  return { shouldRetry: true, delayMs, classified };
}
