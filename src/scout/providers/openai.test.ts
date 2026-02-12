import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatChunk, ChatRequest, ToolDefinition } from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import {
  OpenAIProvider,
  toOpenAITools,
  toOpenAIMessages,
  parseOpenAIToolCall,
} from './openai.js';
import type { ProviderConfig } from './provider.js';

// ---------------------------------------------------------------------------
// Mock OpenAI SDK
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();

vi.mock('openai', () => {
  class OpenAIError extends Error {}

  class APIError extends OpenAIError {
    readonly status: number | undefined;
    readonly headers: unknown;
    readonly error: unknown;
    readonly code: string | null | undefined;
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
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    type: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4o',
    ...overrides,
  };
}

function createRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

/** Creates an async iterable from an array of stream chunks. */
async function* toAsync(events: unknown[]): AsyncIterable<unknown> {
  await Promise.resolve();
  for (const event of events) {
    yield event;
  }
}

/** Collects all chunks from an async iterable. */
async function collectChunks(
  iterable: AsyncIterable<ChatChunk>,
): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Helper to get mock call params. */
function getCallParams(): Record<string, unknown> {
  const calls = mockCreate.mock.calls as unknown[][];
  expect(calls.length).toBeGreaterThan(0);
  return calls[0]?.[0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// toOpenAITools — outbound tool use translation
// ---------------------------------------------------------------------------

describe('toOpenAITools', () => {
  it('should convert a ToolDefinition to OpenAI function tool format', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'file_read',
        description: 'Read a file from disk',
        inputSchema: {
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path'],
        },
      },
    ];

    const result = toOpenAITools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'file_read',
        description: 'Read a file from disk',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
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
        description: 'GET request',
        inputSchema: { properties: { url: { type: 'string' } } },
      },
    ];

    const result = toOpenAITools(tools);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('function.name', 'file_read');
    expect(result[1]).toHaveProperty('function.name', 'http_get');
  });

  it('should handle empty tools array', () => {
    expect(toOpenAITools([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseOpenAIToolCall — inbound tool use translation
// ---------------------------------------------------------------------------

describe('parseOpenAIToolCall', () => {
  it('should parse valid tool call', () => {
    const result = parseOpenAIToolCall({
      id: 'call_abc123',
      name: 'file_read',
      arguments: '{"path": "/tmp/test.txt"}',
    });

    expect(result).toEqual({
      id: 'call_abc123',
      name: 'file_read',
      input: { path: '/tmp/test.txt' },
    });
  });

  it('should handle malformed JSON arguments', () => {
    const result = parseOpenAIToolCall({
      id: 'call_bad',
      name: 'test_tool',
      arguments: '{invalid json',
    });

    expect(result.input).toEqual({});
  });

  it('should handle empty arguments string', () => {
    const result = parseOpenAIToolCall({
      id: 'call_empty',
      name: 'noop',
      arguments: '',
    });

    expect(result.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// toOpenAIMessages — message translation
// ---------------------------------------------------------------------------

describe('toOpenAIMessages', () => {
  it('should convert messages preserving system role', () => {
    const result = toOpenAIMessages([
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);

    expect(result).toEqual([
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('should handle empty messages array', () => {
    expect(toOpenAIMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider — constructor
// ---------------------------------------------------------------------------

describe('OpenAIProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe('constructor', () => {
    it('should set provider id with model name', () => {
      const provider = new OpenAIProvider(createConfig());
      expect(provider.id).toBe('openai:gpt-4o');
    });

    it('should set name to "openai"', () => {
      const provider = new OpenAIProvider(createConfig());
      expect(provider.name).toBe('openai');
    });

    it('should use default max context tokens when not specified', () => {
      const provider = new OpenAIProvider(createConfig());
      expect(provider.maxContextTokens).toBe(128_000);
    });

    it('should use custom max context tokens when specified', () => {
      const provider = new OpenAIProvider(
        createConfig({ maxContextTokens: 32_000 }),
      );
      expect(provider.maxContextTokens).toBe(32_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming text response
  // ---------------------------------------------------------------------------

  describe('chat — streaming text', () => {
    it('should yield text chunks from a streaming response', async () => {
      const events = [
        {
          id: 'chatcmpl-1',
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
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

      const provider = new OpenAIProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(2);
      expect(textChunks[0]?.content).toBe('Hello');
      expect(textChunks[1]?.content).toBe(' world');

      // Last chunk should be done with usage
      const lastChunk = chunks.at(-1);
      expect(lastChunk?.done).toBe(true);
      expect(lastChunk?.usage?.inputTokens).toBe(10);
      expect(lastChunk?.usage?.outputTokens).toBe(5);
    });

    it('should set stream: true and include_usage in request', async () => {
      mockCreate.mockResolvedValueOnce(
        toAsync([
          { id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { id: '1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        ]),
      );

      const provider = new OpenAIProvider(createConfig());
      await collectChunks(provider.chat(createRequest()));

      const params = getCallParams();
      expect(params.stream).toBe(true);
      expect(params.stream_options).toEqual({ include_usage: true });
    });

    it('should pass temperature and stop sequences', async () => {
      mockCreate.mockResolvedValueOnce(
        toAsync([
          { id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { id: '1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        ]),
      );

      const provider = new OpenAIProvider(createConfig());
      await collectChunks(
        provider.chat(
          createRequest({
            temperature: 0.5,
            stopSequences: ['STOP', 'END'],
          }),
        ),
      );

      const params = getCallParams();
      expect(params.temperature).toBe(0.5);
      expect(params.stop).toEqual(['STOP', 'END']);
    });

    it('should default max_completion_tokens to 4096', async () => {
      mockCreate.mockResolvedValueOnce(
        toAsync([
          { id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { id: '1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        ]),
      );

      const provider = new OpenAIProvider(createConfig());
      await collectChunks(provider.chat(createRequest()));

      expect(getCallParams().max_completion_tokens).toBe(4096);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool use translation (streaming)
  // ---------------------------------------------------------------------------

  describe('chat — tool use', () => {
    it('should pass tools in OpenAI format', async () => {
      mockCreate.mockResolvedValueOnce(
        toAsync([
          { id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { id: '1', choices: [], usage: { prompt_tokens: 15, completion_tokens: 10 } },
        ]),
      );

      const tools: ToolDefinition[] = [
        {
          name: 'file_read',
          description: 'Read a file',
          inputSchema: { properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ];

      const provider = new OpenAIProvider(createConfig());
      await collectChunks(provider.chat(createRequest({ tools })));

      const params = getCallParams();
      expect(params.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'file_read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        },
      ]);
    });

    it('should yield tool calls accumulated from streaming chunks', async () => {
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
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'file_read', arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"/tmp/test.txt"}' },
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

      const provider = new OpenAIProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);
      expect(toolChunk).toBeDefined();
      expect(toolChunk?.toolCalls).toHaveLength(1);
      expect(toolChunk?.toolCalls?.[0]).toEqual({
        id: 'call_abc',
        name: 'file_read',
        input: { path: '/tmp/test.txt' },
      });
    });

    it('should handle interleaved text and tool use', async () => {
      const events = [
        {
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              delta: { content: 'Let me read that file.' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_xyz',
                    type: 'function',
                    function: {
                      name: 'file_read',
                      arguments: '{"path":"/etc/hosts"}',
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
          usage: { prompt_tokens: 25, completion_tokens: 15 },
        },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(events));

      const provider = new OpenAIProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0]?.content).toBe('Let me read that file.');

      const toolChunks = chunks.filter((c) => c.toolCalls !== undefined);
      expect(toolChunks).toHaveLength(1);
    });

    it('should handle malformed JSON in tool call arguments', async () => {
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
                    id: 'call_bad',
                    type: 'function',
                    function: { name: 'test', arguments: '{bad json' },
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
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ];
      mockCreate.mockResolvedValueOnce(toAsync(events));

      const provider = new OpenAIProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);
      expect(toolChunk?.toolCalls?.[0]?.input).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('chat — error handling', () => {
    it('should throw LLMProviderError for authentication errors (401)', async () => {
      const { default: OpenAI } = (await import('openai')) as {
        default: { APIError: new (s: number, e: unknown, m: string, h: unknown) => Error };
      };
      mockCreate.mockRejectedValueOnce(
        new OpenAI.APIError(401, undefined, 'Invalid API key', undefined),
      );

      const provider = new OpenAIProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        /authentication failed/i,
      );
    });

    it('should throw LLMProviderError for rate limit errors (429)', async () => {
      const { default: OpenAI } = (await import('openai')) as {
        default: { APIError: new (s: number, e: unknown, m: string, h: unknown) => Error };
      };
      mockCreate.mockRejectedValueOnce(
        new OpenAI.APIError(429, undefined, 'Rate limited', undefined),
      );

      const provider = new OpenAIProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        LLMProviderError,
      );
    });

    it('should throw LLMProviderError for server errors (500)', async () => {
      const { default: OpenAI } = (await import('openai')) as {
        default: { APIError: new (s: number, e: unknown, m: string, h: unknown) => Error };
      };
      mockCreate.mockRejectedValueOnce(
        new OpenAI.APIError(500, undefined, 'Internal server error', undefined),
      );

      const provider = new OpenAIProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        /server error/i,
      );
    });

    it('should wrap non-APIError errors as LLMProviderError', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Network failure'));

      const provider = new OpenAIProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        LLMProviderError,
      );
    });

    it('should handle errors during streaming', async () => {
      async function* errorStream(): AsyncIterable<unknown> {
        await Promise.resolve();
        yield {
          id: '1',
          choices: [{ index: 0, delta: { content: 'start' }, finish_reason: null }],
        };
        throw new Error('Stream interrupted');
      }
      mockCreate.mockResolvedValueOnce(errorStream());

      const provider = new OpenAIProvider(createConfig());

      await expect(collectChunks(provider.chat(createRequest()))).rejects.toThrow(
        LLMProviderError,
      );
    });

    it('should throw LLMProviderError when AbortSignal is already aborted', async () => {
      async function* slowStream(): AsyncIterable<unknown> {
        yield {
          id: '1',
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        };
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield {
          id: '1',
          choices: [{ index: 0, delta: { content: 'more' }, finish_reason: null }],
        };
      }
      mockCreate.mockResolvedValueOnce(slowStream());

      const controller = new AbortController();
      controller.abort();

      const provider = new OpenAIProvider(createConfig());

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
      const provider = new OpenAIProvider(createConfig());
      expect(provider.estimateTokens('a'.repeat(100))).toBe(25);
    });

    it('should return 0 for empty string', () => {
      const provider = new OpenAIProvider(createConfig());
      expect(provider.estimateTokens('')).toBe(0);
    });

    it('should ceil non-exact divisions', () => {
      const provider = new OpenAIProvider(createConfig());
      expect(provider.estimateTokens('hello')).toBe(2);
    });
  });
});
