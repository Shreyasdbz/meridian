// @meridian/scout — LLM provider configuration and base utilities
// Implements Section 5.2.4 (LLM Provider Abstraction) and Section 11.2 (connection pooling).

import type {
  ChatChunk,
  ChatRequest,
  LLMProvider,
} from '@meridian/shared';
import {
  LLMProviderError,
  TimeoutError,
  LLM_FIRST_TOKEN_TIMEOUT_MS,
  LLM_STALL_TIMEOUT_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export type ProviderType = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter';

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxContextTokens?: number;
  /** First-token timeout in ms. Default: LLM_FIRST_TOKEN_TIMEOUT_MS (30s) */
  firstTokenTimeoutMs?: number;
  /** Stall timeout between tokens in ms. Default: LLM_STALL_TIMEOUT_MS (30s) */
  stallTimeoutMs?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Streaming timeout wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a streaming AsyncIterable with first-token and stall timeout enforcement.
 * Throws TimeoutError if the first chunk doesn't arrive within `firstTokenTimeoutMs`
 * or if no subsequent chunk arrives within `stallTimeoutMs`.
 */
export async function* withStreamingTimeouts(
  stream: AsyncIterable<ChatChunk>,
  options: {
    firstTokenTimeoutMs?: number;
    stallTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): AsyncIterable<ChatChunk> {
  const firstTimeout = options.firstTokenTimeoutMs ?? LLM_FIRST_TOKEN_TIMEOUT_MS;
  const stallTimeout = options.stallTimeoutMs ?? LLM_STALL_TIMEOUT_MS;

  const iterator = stream[Symbol.asyncIterator]();
  let isFirstChunk = true;

  for (;;) {
    if (options.signal?.aborted) {
      throw new LLMProviderError('LLM request aborted');
    }

    const timeout = isFirstChunk ? firstTimeout : stallTimeout;

    const result = await Promise.race([
      iterator.next(),
      rejectAfterTimeout(
        timeout,
        isFirstChunk
          ? `No response from LLM within ${timeout}ms`
          : `LLM stream stalled for ${timeout}ms between tokens`,
        options.signal,
      ),
    ]);

    if (result.done === true) {
      return;
    }

    isFirstChunk = false;
    yield result.value;

    if (result.value.done) {
      return;
    }
  }
}

/**
 * Returns a promise that rejects after the given timeout with a TimeoutError.
 * Resolves early if the AbortSignal fires.
 */
function rejectAfterTimeout(
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(message));
    }, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new LLMProviderError('LLM request aborted'));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { LLMProvider, ChatRequest, ChatChunk };
