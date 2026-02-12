import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatChunk, ChatRequest, ToolDefinition } from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import {
  AnthropicProvider,
  toAnthropicTools,
  toAnthropicMessages,
  parseToolUseBlock,
} from './anthropic.js';
import type { ProviderConfig } from './provider.js';

// ---------------------------------------------------------------------------
// Mock Anthropic SDK
// ---------------------------------------------------------------------------

// The mock captures create() calls and returns a controllable async iterable.
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class AnthropicError extends Error {}

  class APIError extends AnthropicError {
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
    default: class MockAnthropic {
      static APIError = APIError;
      messages = { create: mockCreate };
    },
    APIError,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    type: 'anthropic',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5-20250929',
    ...overrides,
  };
}

function createRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'claude-sonnet-4-5-20250929',
    messages: [
      { role: 'user', content: 'Hello' },
    ],
    ...overrides,
  };
}

/** Creates an async iterable from an array of raw stream events. */
function* mockStream(events: unknown[]): Iterable<unknown> {
  for (const event of events) {
    yield event;
  }
}

/** Wraps sync iterable as async. */
async function* toAsync(iterable: Iterable<unknown>): AsyncIterable<unknown> {
  await Promise.resolve();
  for (const item of iterable) {
    yield item;
  }
}

/** Collects all chunks from an async iterable into an array. */
async function collectChunks(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Helper to get a mock call's first argument safely. */
function getCallParams(): Record<string, unknown> {
  const calls = mockCreate.mock.calls as unknown[][];
  expect(calls.length).toBeGreaterThan(0);
  return calls[0]?.[0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// toAnthropicTools — outbound tool use translation
// ---------------------------------------------------------------------------

describe('toAnthropicTools', () => {
  it('should convert a single ToolDefinition to Anthropic Tool format', () => {
    const tools: ToolDefinition[] = [{
      name: 'file_read',
      description: 'Read a file from disk',
      inputSchema: {
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
    }];

    const result = toAnthropicTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'file_read',
      description: 'Read a file from disk',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
    });
  });

  it('should convert multiple ToolDefinitions', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'file_read',
        description: 'Read a file',
        inputSchema: { properties: { path: { type: 'string' } } },
      },
      {
        name: 'http_get',
        description: 'Make an HTTP GET request',
        inputSchema: { properties: { url: { type: 'string' } } },
      },
    ];

    const result = toAnthropicTools(tools);
    expect(result).toHaveLength(2);
    expect(result.at(0)?.name).toBe('file_read');
    expect(result.at(1)?.name).toBe('http_get');
  });

  it('should handle empty tools array', () => {
    expect(toAnthropicTools([])).toEqual([]);
  });

  it('should preserve all inputSchema properties as input_schema', () => {
    const tools: ToolDefinition[] = [{
      name: 'send_email',
      description: 'Send an email',
      inputSchema: {
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
    }];

    const result = toAnthropicTools(tools);
    expect(result.at(0)?.input_schema).toEqual({
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    });
  });
});

// ---------------------------------------------------------------------------
// parseToolUseBlock — inbound tool use translation
// ---------------------------------------------------------------------------

describe('parseToolUseBlock', () => {
  it('should convert an Anthropic tool use block to a ToolCall', () => {
    const block = {
      id: 'toolu_abc123',
      name: 'file_read',
      input: { path: '/tmp/test.txt' },
    };

    const result = parseToolUseBlock(block);

    expect(result).toEqual({
      id: 'toolu_abc123',
      name: 'file_read',
      input: { path: '/tmp/test.txt' },
    });
  });

  it('should handle empty input object', () => {
    const result = parseToolUseBlock({
      id: 'toolu_def456',
      name: 'get_time',
      input: {},
    });

    expect(result.input).toEqual({});
  });

  it('should handle null input gracefully', () => {
    const result = parseToolUseBlock({
      id: 'toolu_xyz',
      name: 'noop',
      input: null,
    });

    expect(result.input).toEqual({});
  });

  it('should handle non-object input gracefully', () => {
    const result = parseToolUseBlock({
      id: 'toolu_xyz',
      name: 'noop',
      input: 'invalid',
    });

    expect(result.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// toAnthropicMessages — message translation
// ---------------------------------------------------------------------------

describe('toAnthropicMessages', () => {
  it('should separate system messages from user/assistant messages', () => {
    const result = toAnthropicMessages([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);

    expect(result.system).toBe('You are a helpful assistant.');
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('should handle messages with no system prompt', () => {
    const result = toAnthropicMessages([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.system).toBeUndefined();
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('should concatenate multiple system messages', () => {
    const result = toAnthropicMessages([
      { role: 'system', content: 'First instruction.' },
      { role: 'system', content: 'Second instruction.' },
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.system).toBe('First instruction.\n\nSecond instruction.');
  });

  it('should handle empty messages array', () => {
    const result = toAnthropicMessages([]);
    expect(result.system).toBeUndefined();
    expect(result.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider — constructor
// ---------------------------------------------------------------------------

describe('AnthropicProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe('constructor', () => {
    it('should set provider id with model name', () => {
      const provider = new AnthropicProvider(createConfig());
      expect(provider.id).toBe('anthropic:claude-sonnet-4-5-20250929');
    });

    it('should set name to "anthropic"', () => {
      const provider = new AnthropicProvider(createConfig());
      expect(provider.name).toBe('anthropic');
    });

    it('should use default max context tokens when not specified', () => {
      const provider = new AnthropicProvider(createConfig());
      expect(provider.maxContextTokens).toBe(200_000);
    });

    it('should use custom max context tokens when specified', () => {
      const provider = new AnthropicProvider(
        createConfig({ maxContextTokens: 100_000 }),
      );
      expect(provider.maxContextTokens).toBe(100_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming text response
  // ---------------------------------------------------------------------------

  describe('chat — streaming text', () => {
    it('should yield text chunks from a streaming response', async () => {
      const events = [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 10, cache_read_input_tokens: null } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, input_tokens: null } },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(mockStream(events)));

      const provider = new AnthropicProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      // Should have: 'Hello', ' world', and final done chunk
      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(2);
      expect(textChunks.at(0)?.content).toBe('Hello');
      expect(textChunks.at(1)?.content).toBe(' world');

      // Last chunk should be done with usage
      const lastChunk = chunks.at(-1);
      expect(lastChunk?.done).toBe(true);
      expect(lastChunk?.usage?.inputTokens).toBe(10);
      expect(lastChunk?.usage?.outputTokens).toBe(5);
    });

    it('should pass system message as top-level system parameter', async () => {
      mockCreate.mockResolvedValueOnce(toAsync(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'message_stop' },
      ])));

      const provider = new AnthropicProvider(createConfig());
      await collectChunks(provider.chat(createRequest({
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hi' },
        ],
      })));

      const callParams = getCallParams();
      expect(callParams.system).toBe('Be helpful');
      expect(callParams.messages).toEqual([
        { role: 'user', content: 'Hi' },
      ]);
    });

    it('should pass temperature and stop sequences', async () => {
      mockCreate.mockResolvedValueOnce(toAsync(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'message_stop' },
      ])));

      const provider = new AnthropicProvider(createConfig());
      await collectChunks(provider.chat(createRequest({
        temperature: 0.5,
        stopSequences: ['STOP', 'END'],
      })));

      const callParams = getCallParams();
      expect(callParams.temperature).toBe(0.5);
      expect(callParams.stop_sequences).toEqual(['STOP', 'END']);
    });

    it('should set stream: true on all requests', async () => {
      mockCreate.mockResolvedValueOnce(toAsync(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'message_stop' },
      ])));

      const provider = new AnthropicProvider(createConfig());
      await collectChunks(provider.chat(createRequest()));

      expect(getCallParams().stream).toBe(true);
    });

    it('should default maxTokens to 4096 when not specified', async () => {
      mockCreate.mockResolvedValueOnce(toAsync(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'message_stop' },
      ])));

      const provider = new AnthropicProvider(createConfig());
      await collectChunks(provider.chat(createRequest()));

      expect(getCallParams().max_tokens).toBe(4096);
    });

    it('should use custom maxTokens when specified', async () => {
      mockCreate.mockResolvedValueOnce(toAsync(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'message_stop' },
      ])));

      const provider = new AnthropicProvider(createConfig());
      await collectChunks(provider.chat(createRequest({ maxTokens: 1024 })));

      expect(getCallParams().max_tokens).toBe(1024);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool use translation (streaming)
  // ---------------------------------------------------------------------------

  describe('chat — tool use', () => {
    it('should pass tools in Anthropic format when tools are provided', async () => {
      mockCreate.mockResolvedValueOnce(toAsync(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 15 } } },
        { type: 'message_stop' },
      ])));

      const tools: ToolDefinition[] = [{
        name: 'file_read',
        description: 'Read a file',
        inputSchema: { properties: { path: { type: 'string' } }, required: ['path'] },
      }];

      const provider = new AnthropicProvider(createConfig());
      await collectChunks(provider.chat(createRequest({ tools })));

      const callParams = getCallParams();
      expect(callParams.tools).toEqual([{
        name: 'file_read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }]);
    });

    it('should not include tools param when no tools are provided', async () => {
      mockCreate.mockResolvedValueOnce(toAsync(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'message_stop' },
      ])));

      const provider = new AnthropicProvider(createConfig());
      await collectChunks(provider.chat(createRequest()));

      expect(getCallParams().tools).toBeUndefined();
    });

    it('should yield tool calls from streaming tool_use blocks', async () => {
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 20 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_abc', name: 'file_read' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"/tmp/test.txt"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(mockStream(events)));

      const provider = new AnthropicProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      // Find the chunk that has toolCalls
      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);

      expect(toolChunk).toBeDefined();
      expect(toolChunk?.toolCalls).toHaveLength(1);
      expect(toolChunk?.toolCalls?.at(0)).toEqual({
        id: 'toolu_abc',
        name: 'file_read',
        input: { path: '/tmp/test.txt' },
      });
    });

    it('should handle interleaved text and tool use blocks', async () => {
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 25 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me read that file.' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_xyz', name: 'file_read' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":"/etc/hosts"}' },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(mockStream(events)));

      const provider = new AnthropicProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      // Should have text content
      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(1);
      expect(textChunks.at(0)?.content).toBe('Let me read that file.');

      // Should have tool call
      const toolChunks = chunks.filter((c) => c.toolCalls !== undefined);
      expect(toolChunks).toHaveLength(1);
    });

    it('should handle malformed JSON in tool call input gracefully', async () => {
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_bad', name: 'test_tool' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{invalid json' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(mockStream(events)));

      const provider = new AnthropicProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);

      expect(toolChunk).toBeDefined();
      // Malformed JSON should result in empty input
      expect(toolChunk?.toolCalls?.at(0)?.input).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('chat — error handling', () => {
    it('should throw LLMProviderError for authentication errors (401)', async () => {
      const { APIError } = await import('@anthropic-ai/sdk') as {
        APIError: new (s: number, e: unknown, m: string, h: unknown) => Error;
      };
      mockCreate.mockRejectedValueOnce(
        new APIError(401, undefined, 'Invalid API key', undefined),
      );

      const provider = new AnthropicProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        /authentication failed/i,
      );
    });

    it('should throw LLMProviderError for rate limit errors (429)', async () => {
      const { APIError } = await import('@anthropic-ai/sdk') as {
        APIError: new (s: number, e: unknown, m: string, h: unknown) => Error;
      };
      mockCreate.mockRejectedValueOnce(
        new APIError(429, undefined, 'Rate limited', undefined),
      );

      const provider = new AnthropicProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        LLMProviderError,
      );
    });

    it('should throw LLMProviderError for server errors (500)', async () => {
      const { APIError } = await import('@anthropic-ai/sdk') as {
        APIError: new (s: number, e: unknown, m: string, h: unknown) => Error;
      };
      mockCreate.mockRejectedValueOnce(
        new APIError(500, undefined, 'Internal server error', undefined),
      );

      const provider = new AnthropicProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        /server error/i,
      );
    });

    it('should throw LLMProviderError for overloaded API (529)', async () => {
      const { APIError } = await import('@anthropic-ai/sdk') as {
        APIError: new (s: number, e: unknown, m: string, h: unknown) => Error;
      };
      mockCreate.mockRejectedValueOnce(
        new APIError(529, undefined, 'Overloaded', undefined),
      );

      const provider = new AnthropicProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        /overloaded/i,
      );
    });

    it('should wrap non-APIError errors as LLMProviderError', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Network failure'));

      const provider = new AnthropicProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        LLMProviderError,
      );
    });

    it('should handle errors during streaming', async () => {
      async function* errorStream(): AsyncIterable<unknown> {
        await Promise.resolve();
        yield {
          type: 'message_start',
          message: { usage: { input_tokens: 5 } },
        };
        throw new Error('Stream interrupted');
      }
      mockCreate.mockResolvedValueOnce(errorStream());

      const provider = new AnthropicProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        LLMProviderError,
      );
    });

    it('should throw LLMProviderError when AbortSignal is already aborted', async () => {
      async function* slowStream(): AsyncIterable<unknown> {
        yield {
          type: 'message_start',
          message: { usage: { input_tokens: 5 } },
        };
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'should not reach' },
        };
      }
      mockCreate.mockResolvedValueOnce(slowStream());

      const controller = new AbortController();
      controller.abort();

      const provider = new AnthropicProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest({ signal: controller.signal }))),
      ).rejects.toThrow(LLMProviderError);
    });
  });

  // ---------------------------------------------------------------------------
  // Token estimation
  // ---------------------------------------------------------------------------

  describe('estimateTokens', () => {
    it('should estimate roughly 1 token per 4 characters', () => {
      const provider = new AnthropicProvider(createConfig());

      // 100 chars -> ~25 tokens
      const text = 'a'.repeat(100);
      expect(provider.estimateTokens(text)).toBe(25);
    });

    it('should return 0 for empty string', () => {
      const provider = new AnthropicProvider(createConfig());
      expect(provider.estimateTokens('')).toBe(0);
    });

    it('should ceil non-exact divisions', () => {
      const provider = new AnthropicProvider(createConfig());
      // 5 chars -> ceil(5/4) = 2 tokens
      expect(provider.estimateTokens('hello')).toBe(2);
    });

    it('should handle long text', () => {
      const provider = new AnthropicProvider(createConfig());
      const text = 'x'.repeat(10_000);
      expect(provider.estimateTokens(text)).toBe(2_500);
    });
  });

  // ---------------------------------------------------------------------------
  // Usage tracking
  // ---------------------------------------------------------------------------

  describe('chat — usage tracking', () => {
    it('should capture input tokens from message_start', async () => {
      const events = [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 42, cache_read_input_tokens: 10 } },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8, input_tokens: null } },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(mockStream(events)));

      const provider = new AnthropicProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));
      const lastChunk = chunks.at(-1);

      expect(lastChunk?.usage?.inputTokens).toBe(42);
      expect(lastChunk?.usage?.outputTokens).toBe(8);
      expect(lastChunk?.usage?.cachedTokens).toBe(10);
    });

    it('should handle missing cache_read_input_tokens', async () => {
      const events = [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 20, cache_read_input_tokens: null } },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, input_tokens: null } },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(mockStream(events)));

      const provider = new AnthropicProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));
      const lastChunk = chunks.at(-1);

      expect(lastChunk?.usage?.cachedTokens).toBeUndefined();
    });
  });
});
