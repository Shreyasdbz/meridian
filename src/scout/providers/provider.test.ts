import { describe, it, expect } from 'vitest';

import type { ChatChunk } from '@meridian/shared';
import { LLMProviderError, TimeoutError } from '@meridian/shared';

import type { ProviderConfig, ProviderType } from './provider.js';
import { withStreamingTimeouts } from './provider.js';

import { createProvider, resolveProviderType } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectChunks(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// withStreamingTimeouts
// ---------------------------------------------------------------------------

describe('withStreamingTimeouts', () => {
  it('should pass through chunks from a fast stream', async () => {
    const source: ChatChunk[] = [
      { content: 'Hello', done: false },
      { content: ' world', done: false },
      { content: '', done: true, usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    // Use sync iterable wrapped as async
    async function* asyncFrom(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
      await Promise.resolve();
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    const result = await collectChunks(
      withStreamingTimeouts(asyncFrom(source), {
        firstTokenTimeoutMs: 1000,
        stallTimeoutMs: 1000,
      }),
    );

    expect(result).toHaveLength(3);
    expect(result.at(0)?.content).toBe('Hello');
    expect(result.at(2)?.done).toBe(true);
  });

  it('should throw TimeoutError when first token exceeds timeout', async () => {
    async function* slowStart(): AsyncIterable<ChatChunk> {
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield { content: 'late', done: true };
    }

    await expect(
      collectChunks(
        withStreamingTimeouts(slowStart(), {
          firstTokenTimeoutMs: 50,
          stallTimeoutMs: 5000,
        }),
      ),
    ).rejects.toThrow(TimeoutError);
  });

  it('should throw TimeoutError when stream stalls between tokens', async () => {
    async function* stallAfterFirst(): AsyncIterable<ChatChunk> {
      yield { content: 'First', done: false };
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield { content: 'Second', done: true };
    }

    await expect(
      collectChunks(
        withStreamingTimeouts(stallAfterFirst(), {
          firstTokenTimeoutMs: 5000,
          stallTimeoutMs: 50,
        }),
      ),
    ).rejects.toThrow(TimeoutError);
  });

  it('should stop early when an AbortSignal fires', async () => {
    async function* infiniteStream(): AsyncIterable<ChatChunk> {
      let i = 0;
      while (i < 1000) {
        yield { content: `chunk-${i++}`, done: false };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 50);

    await expect(
      collectChunks(
        withStreamingTimeouts(infiniteStream(), {
          firstTokenTimeoutMs: 5000,
          stallTimeoutMs: 5000,
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow(LLMProviderError);
  });

  it('should stop when a done chunk is received', async () => {
    async function* singleDone(): AsyncIterable<ChatChunk> {
      await Promise.resolve();
      yield { content: 'Only', done: true };
    }

    const result = await collectChunks(
      withStreamingTimeouts(singleDone(), {
        firstTokenTimeoutMs: 1000,
        stallTimeoutMs: 1000,
      }),
    );

    expect(result).toHaveLength(1);
    expect(result.at(0)?.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createProvider — factory
// ---------------------------------------------------------------------------

describe('createProvider', () => {
  it('should create an AnthropicProvider for type "anthropic"', () => {
    const config: ProviderConfig = {
      type: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5-20250929',
    };

    const provider = createProvider(config);
    expect(provider.name).toBe('anthropic');
    expect(provider.id).toBe('anthropic:claude-sonnet-4-5-20250929');
  });

  it('should create an OpenAIProvider for type "openai"', () => {
    const config: ProviderConfig = {
      type: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
    };

    const provider = createProvider(config);
    expect(provider.name).toBe('openai');
    expect(provider.id).toBe('openai:gpt-4o');
  });

  it('should create a GoogleProvider for type "google"', () => {
    const provider = createProvider({
      type: 'google',
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
    });
    expect(provider.name).toBe('google');
    expect(provider.id).toBe('google:gemini-2.0-flash');
  });

  it('should create an OllamaProvider for type "ollama"', () => {
    const provider = createProvider({
      type: 'ollama',
      model: 'llama3',
    });
    expect(provider.name).toBe('ollama');
    expect(provider.id).toBe('ollama:llama3');
  });

  it('should create an OpenRouterProvider for type "openrouter"', () => {
    const provider = createProvider({
      type: 'openrouter',
      apiKey: 'test-key',
      model: 'anthropic/claude-sonnet-4-5-20250929',
    });
    expect(provider.name).toBe('openrouter');
    expect(provider.id).toBe('openrouter:anthropic/claude-sonnet-4-5-20250929');
  });

  it('should throw LLMProviderError for unknown provider type', () => {
    expect(() =>
      createProvider({ type: 'unknown' as ProviderType, model: 'test' }),
    ).toThrow(LLMProviderError);
  });
});

// ---------------------------------------------------------------------------
// resolveProviderType
// ---------------------------------------------------------------------------

describe('resolveProviderType', () => {
  it('should return "anthropic" for "anthropic"', () => {
    expect(resolveProviderType('anthropic')).toBe('anthropic');
  });

  it('should return "openai" for "openai"', () => {
    expect(resolveProviderType('openai')).toBe('openai');
  });

  it('should return "google" for "google"', () => {
    expect(resolveProviderType('google')).toBe('google');
  });

  it('should return "ollama" for "ollama"', () => {
    expect(resolveProviderType('ollama')).toBe('ollama');
  });

  it('should return "openrouter" for "openrouter"', () => {
    expect(resolveProviderType('openrouter')).toBe('openrouter');
  });

  it('should throw LLMProviderError for unknown provider', () => {
    expect(() => resolveProviderType('invalid')).toThrow(LLMProviderError);
    expect(() => resolveProviderType('invalid')).toThrow(/Unknown provider/);
  });
});
