// @meridian/scout — OpenRouter provider adapter
// Implements Section 5.2.4 (LLM Provider Abstraction).
// OpenRouter is compatible with the OpenAI SDK — this adapter reuses the
// shared OpenAI streaming logic with a different base URL.

import OpenAI from 'openai';

import type {
  ChatChunk,
  ChatRequest,
  LLMProvider,
} from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import { openAIEstimateTokens, openAIStreamingChat } from './openai.js';
import type { ProviderConfig } from './provider.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default OpenRouter API base URL. */
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Default max context tokens (varies by model; conservative default). */
const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

// ---------------------------------------------------------------------------
// OpenRouter provider adapter
// ---------------------------------------------------------------------------

export class OpenRouterProvider implements LLMProvider {
  readonly id: string;
  readonly name = 'openrouter';
  readonly maxContextTokens: number;

  private readonly client: OpenAI;

  constructor(config: ProviderConfig) {
    this.id = `openrouter:${config.model}`;
    this.maxContextTokens =
      config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

    if (!config.apiKey) {
      throw new LLMProviderError('OpenRouter API key is required');
    }

    // OpenRouter uses an OpenAI-compatible API, so we use the OpenAI SDK
    // with a different base URL.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? DEFAULT_BASE_URL,
    });
  }

  /**
   * Streaming chat completion. Delegates to the shared OpenAI streaming logic.
   * Supports tool use translation and AbortSignal cancellation.
   */
  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    yield* openAIStreamingChat(this.client, request);
  }

  /**
   * Rough token count estimation (~4 chars/token).
   */
  estimateTokens(text: string): number {
    return openAIEstimateTokens(text);
  }
}
