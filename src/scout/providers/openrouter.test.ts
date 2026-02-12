import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatChunk, ChatRequest } from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import { OpenRouterProvider } from './openrouter.js';
import type { ProviderConfig } from './provider.js';

// ---------------------------------------------------------------------------
// Mock OpenAI SDK (OpenRouter uses the OpenAI SDK under the hood)
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();

vi.mock('openai', () => {
  class OpenAIError extends Error {}

  class APIError extends OpenAIError {
    readonly status: number | undefined;
    readonly headers: unknown;
    readonly error: unknown;
    constructor(
      status: number | undefined,
      error: unknown,
      message: string | undefined,
      headers: unknown,
    ) {
      super(message ?? 'API Error');
      this.status = status;
      this.headers = headers;
      this.error = error;
      this.name = 'APIError';
    }
  }

  return {
    default: class MockOpenAI {
      static APIError = APIError;
      chat = { completions: { create: mockCreate } };
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    type: 'openrouter',
    apiKey: 'test-key',
    model: 'anthropic/claude-sonnet-4-5-20250929',
    ...overrides,
  };
}

function createRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'anthropic/claude-sonnet-4-5-20250929',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

async function* toAsync(events: unknown[]): AsyncIterable<unknown> {
  await Promise.resolve();
  for (const event of events) {
    yield event;
  }
}

async function collectChunks(
  iterable: AsyncIterable<ChatChunk>,
): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// OpenRouterProvider — constructor
// ---------------------------------------------------------------------------

describe('OpenRouterProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe('constructor', () => {
    it('should set provider id with openrouter prefix', () => {
      const provider = new OpenRouterProvider(createConfig());
      expect(provider.id).toBe('openrouter:anthropic/claude-sonnet-4-5-20250929');
    });

    it('should set name to "openrouter"', () => {
      const provider = new OpenRouterProvider(createConfig());
      expect(provider.name).toBe('openrouter');
    });

    it('should use default max context tokens when not specified', () => {
      const provider = new OpenRouterProvider(createConfig());
      expect(provider.maxContextTokens).toBe(128_000);
    });

    it('should use custom max context tokens when specified', () => {
      const provider = new OpenRouterProvider(
        createConfig({ maxContextTokens: 32_000 }),
      );
      expect(provider.maxContextTokens).toBe(32_000);
    });

    it('should throw if no API key is provided', () => {
      expect(
        () => new OpenRouterProvider(createConfig({ apiKey: undefined })),
      ).toThrow(LLMProviderError);
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming — delegates to OpenAI shared logic
  // ---------------------------------------------------------------------------

  describe('chat — streaming', () => {
    it('should yield text chunks from a streaming response', async () => {
      const events = [
        {
          id: 'chatcmpl-1',
          choices: [
            { index: 0, delta: { content: 'Hello from OpenRouter' }, finish_reason: null },
          ],
        },
        {
          id: 'chatcmpl-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        {
          id: 'chatcmpl-1',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(events));

      const provider = new OpenRouterProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0]?.content).toBe('Hello from OpenRouter');

      const lastChunk = chunks.at(-1);
      expect(lastChunk?.done).toBe(true);
      expect(lastChunk?.usage?.inputTokens).toBe(10);
    });

    it('should handle tool calls via OpenAI-compatible format', async () => {
      const events = [
        {
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_or_123',
                    type: 'function',
                    function: {
                      name: 'file_read',
                      arguments: '{"path":"/tmp/test.txt"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
        {
          id: 'chatcmpl-1',
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(events));

      const provider = new OpenRouterProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);
      expect(toolChunk).toBeDefined();
      expect(toolChunk?.toolCalls?.[0]?.name).toBe('file_read');
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('chat — error handling', () => {
    it('should throw LLMProviderError for API errors', async () => {
      const { default: OpenAI } = (await import('openai')) as {
        default: {
          APIError: new (s: number, e: unknown, m: string, h: unknown) => Error;
        };
      };
      mockCreate.mockRejectedValueOnce(
        new OpenAI.APIError(401, undefined, 'Invalid key', undefined),
      );

      const provider = new OpenRouterProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(LLMProviderError);
    });

    it('should wrap generic errors as LLMProviderError', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Network failure'));

      const provider = new OpenRouterProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(LLMProviderError);
    });
  });

  // ---------------------------------------------------------------------------
  // Token estimation
  // ---------------------------------------------------------------------------

  describe('estimateTokens', () => {
    it('should estimate roughly 1 token per 4 characters', () => {
      const provider = new OpenRouterProvider(createConfig());
      expect(provider.estimateTokens('a'.repeat(100))).toBe(25);
    });

    it('should return 0 for empty string', () => {
      const provider = new OpenRouterProvider(createConfig());
      expect(provider.estimateTokens('')).toBe(0);
    });
  });
});
