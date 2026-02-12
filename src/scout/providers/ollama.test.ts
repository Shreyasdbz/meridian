import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatChunk, ChatRequest, ToolDefinition } from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import {
  OllamaProvider,
  toOllamaTools,
  toOllamaMessages,
  parseOllamaToolCall,
  buildStructuredOutputPrompt,
  parseStructuredOutput,
  resetToolCallCounter,
} from './ollama.js';
import type { ProviderConfig } from './provider.js';

// ---------------------------------------------------------------------------
// Mock Ollama SDK
// ---------------------------------------------------------------------------

const mockChat = vi.fn();

vi.mock('ollama', () => {
  return {
    Ollama: class MockOllama {
      chat = mockChat;
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    type: 'ollama',
    model: 'llama3',
    ...overrides,
  };
}

function createRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'llama3',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

/** Creates an async iterable from chat response chunks. */
async function* toAsync(
  chunks: Array<{
    message?: { content?: string; tool_calls?: unknown[] };
    done?: boolean;
    prompt_eval_count?: number;
    eval_count?: number;
  }>,
): AsyncIterable<unknown> {
  await Promise.resolve();
  for (const chunk of chunks) {
    yield chunk;
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

// ---------------------------------------------------------------------------
// toOllamaTools — outbound tool use translation
// ---------------------------------------------------------------------------

describe('toOllamaTools', () => {
  it('should convert ToolDefinitions to Ollama tool format', () => {
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

    const result = toOllamaTools(tools);

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

  it('should handle empty tools array', () => {
    expect(toOllamaTools([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseOllamaToolCall — inbound tool use translation
// ---------------------------------------------------------------------------

describe('parseOllamaToolCall', () => {
  beforeEach(() => {
    resetToolCallCounter();
  });

  it('should parse an Ollama tool call with pre-parsed arguments', () => {
    const result = parseOllamaToolCall({
      function: {
        name: 'file_read',
        arguments: { path: '/tmp/test.txt' },
      },
    });

    expect(result).toEqual({
      id: 'ollama-tc-0',
      name: 'file_read',
      input: { path: '/tmp/test.txt' },
    });
  });

  it('should generate sequential synthetic IDs', () => {
    const first = parseOllamaToolCall({
      function: { name: 'tool1', arguments: {} },
    });
    const second = parseOllamaToolCall({
      function: { name: 'tool2', arguments: {} },
    });

    expect(first.id).toBe('ollama-tc-0');
    expect(second.id).toBe('ollama-tc-1');
  });

  it('should handle null arguments gracefully', () => {
    const result = parseOllamaToolCall({
      function: {
        name: 'noop',
        arguments: null as unknown as Record<string, unknown>,
      },
    });
    expect(result.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// toOllamaMessages — message translation
// ---------------------------------------------------------------------------

describe('toOllamaMessages', () => {
  it('should convert messages preserving all roles', () => {
    const result = toOllamaMessages([
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
    expect(toOllamaMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildStructuredOutputPrompt — fallback mode
// ---------------------------------------------------------------------------

describe('buildStructuredOutputPrompt', () => {
  it('should include tool descriptions in the prompt', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'file_read',
        description: 'Read a file',
        inputSchema: { properties: { path: { type: 'string' } } },
      },
    ];

    const prompt = buildStructuredOutputPrompt(tools);

    expect(prompt).toContain('file_read');
    expect(prompt).toContain('Read a file');
    expect(prompt).toContain('tool_calls');
    expect(prompt).toContain('JSON');
  });
});

// ---------------------------------------------------------------------------
// parseStructuredOutput — fallback mode parsing
// ---------------------------------------------------------------------------

describe('parseStructuredOutput', () => {
  beforeEach(() => {
    resetToolCallCounter();
  });

  it('should parse valid JSON tool call output', () => {
    const text = JSON.stringify({
      tool_calls: [
        {
          name: 'file_read',
          arguments: { path: '/tmp/test.txt' },
        },
      ],
    });

    const result = parseStructuredOutput(text);

    expect(result).toHaveLength(1);
    expect(result?.[0]?.name).toBe('file_read');
    expect(result?.[0]?.input).toEqual({ path: '/tmp/test.txt' });
  });

  it('should handle markdown code fences', () => {
    const text = '```json\n' + JSON.stringify({
      tool_calls: [{ name: 'test', arguments: {} }],
    }) + '\n```';

    const result = parseStructuredOutput(text);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.name).toBe('test');
  });

  it('should return undefined for plain text', () => {
    const result = parseStructuredOutput('Just a plain text response');
    expect(result).toBeUndefined();
  });

  it('should return undefined for invalid JSON', () => {
    const result = parseStructuredOutput('{invalid json}');
    expect(result).toBeUndefined();
  });

  it('should return undefined for JSON without tool_calls', () => {
    const result = parseStructuredOutput('{"message": "hello"}');
    expect(result).toBeUndefined();
  });

  it('should return undefined for empty tool_calls array', () => {
    const result = parseStructuredOutput('{"tool_calls": []}');
    expect(result).toBeUndefined();
  });

  it('should parse multiple tool calls', () => {
    const text = JSON.stringify({
      tool_calls: [
        { name: 'tool1', arguments: { a: 1 } },
        { name: 'tool2', arguments: { b: 2 } },
      ],
    });

    const result = parseStructuredOutput(text);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider — constructor
// ---------------------------------------------------------------------------

describe('OllamaProvider', () => {
  beforeEach(() => {
    mockChat.mockReset();
    resetToolCallCounter();
  });

  describe('constructor', () => {
    it('should set provider id with model name', () => {
      const provider = new OllamaProvider(createConfig());
      expect(provider.id).toBe('ollama:llama3');
    });

    it('should set name to "ollama"', () => {
      const provider = new OllamaProvider(createConfig());
      expect(provider.name).toBe('ollama');
    });

    it('should use default max context tokens when not specified', () => {
      const provider = new OllamaProvider(createConfig());
      expect(provider.maxContextTokens).toBe(8_192);
    });

    it('should use custom max context tokens when specified', () => {
      const provider = new OllamaProvider(
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
      mockChat.mockResolvedValueOnce(
        toAsync([
          { message: { content: 'Hello' }, done: false },
          { message: { content: ' world' }, done: false },
          {
            message: { content: '' },
            done: true,
            prompt_eval_count: 10,
            eval_count: 5,
          },
        ]),
      );

      const provider = new OllamaProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(2);
      expect(textChunks[0]?.content).toBe('Hello');
      expect(textChunks[1]?.content).toBe(' world');

      const lastChunk = chunks.at(-1);
      expect(lastChunk?.done).toBe(true);
      expect(lastChunk?.usage?.inputTokens).toBe(10);
      expect(lastChunk?.usage?.outputTokens).toBe(5);
    });

    it('should pass temperature and stop sequences in options', async () => {
      mockChat.mockResolvedValueOnce(
        toAsync([
          { message: { content: '' }, done: true, prompt_eval_count: 5, eval_count: 2 },
        ]),
      );

      const provider = new OllamaProvider(createConfig());
      await collectChunks(
        provider.chat(
          createRequest({
            temperature: 0.5,
            stopSequences: ['STOP'],
          }),
        ),
      );

      const callArgs = mockChat.mock.calls[0]?.[0] as Record<string, unknown>;
      const options = callArgs.options as Record<string, unknown>;
      expect(options.temperature).toBe(0.5);
      expect(options.stop).toEqual(['STOP']);
    });
  });

  // ---------------------------------------------------------------------------
  // Native tool use
  // ---------------------------------------------------------------------------

  describe('chat — native tool use', () => {
    it('should yield tool calls from native tool_calls in response', async () => {
      mockChat.mockResolvedValueOnce(
        toAsync([
          { message: { content: '' }, done: false },
          {
            message: {
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'file_read',
                    arguments: { path: '/tmp/test.txt' },
                  },
                },
              ],
            },
            done: true,
            prompt_eval_count: 20,
            eval_count: 10,
          },
        ]),
      );

      const tools: ToolDefinition[] = [
        {
          name: 'file_read',
          description: 'Read a file',
          inputSchema: { properties: { path: { type: 'string' } } },
        },
      ];

      const provider = new OllamaProvider(createConfig());
      const chunks = await collectChunks(
        provider.chat(createRequest({ tools })),
      );

      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);
      expect(toolChunk).toBeDefined();
      expect(toolChunk?.toolCalls).toHaveLength(1);
      expect(toolChunk?.toolCalls?.[0]?.name).toBe('file_read');
      expect(toolChunk?.toolCalls?.[0]?.input).toEqual({
        path: '/tmp/test.txt',
      });
    });

    it('should pass tools to Ollama in native mode', async () => {
      mockChat.mockResolvedValueOnce(
        toAsync([
          { message: { content: '' }, done: true, prompt_eval_count: 5, eval_count: 2 },
        ]),
      );

      const tools: ToolDefinition[] = [
        {
          name: 'file_read',
          description: 'Read a file',
          inputSchema: {
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ];

      const provider = new OllamaProvider(createConfig());
      await collectChunks(provider.chat(createRequest({ tools })));

      const callArgs = mockChat.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.tools).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Structured output fallback mode
  // ---------------------------------------------------------------------------

  describe('chat — structured output fallback', () => {
    it('should inject tool schema into system prompt in fallback mode', async () => {
      mockChat.mockResolvedValueOnce(
        toAsync([
          { message: { content: '' }, done: true, prompt_eval_count: 5, eval_count: 2 },
        ]),
      );

      const tools: ToolDefinition[] = [
        {
          name: 'file_read',
          description: 'Read a file',
          inputSchema: { properties: { path: { type: 'string' } } },
        },
      ];

      const provider = new OllamaProvider(
        createConfig({ metadata: { useStructuredOutput: true } }),
      );
      await collectChunks(provider.chat(createRequest({ tools })));

      const callArgs = mockChat.mock.calls[0]?.[0] as Record<string, unknown>;
      // Should NOT pass tools in fallback mode
      expect(callArgs.tools).toBeUndefined();
      // Should inject tool schema into messages
      const messages = callArgs.messages as Array<{ role: string; content: string }>;
      const systemMsg = messages.find((m) => m.role === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg?.content).toContain('file_read');
      expect(systemMsg?.content).toContain('tool_calls');
    });

    it('should parse structured output text as tool calls', async () => {
      const toolCallJson = JSON.stringify({
        tool_calls: [
          { name: 'file_read', arguments: { path: '/tmp/test.txt' } },
        ],
      });

      mockChat.mockResolvedValueOnce(
        toAsync([
          { message: { content: toolCallJson }, done: false },
          {
            message: { content: '' },
            done: true,
            prompt_eval_count: 10,
            eval_count: 8,
          },
        ]),
      );

      const tools: ToolDefinition[] = [
        {
          name: 'file_read',
          description: 'Read a file',
          inputSchema: { properties: { path: { type: 'string' } } },
        },
      ];

      const provider = new OllamaProvider(
        createConfig({ metadata: { useStructuredOutput: true } }),
      );
      const chunks = await collectChunks(
        provider.chat(createRequest({ tools })),
      );

      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);
      expect(toolChunk).toBeDefined();
      expect(toolChunk?.toolCalls?.[0]?.name).toBe('file_read');
    });

    it('should not parse as tool calls in native mode', async () => {
      const toolCallJson = JSON.stringify({
        tool_calls: [
          { name: 'file_read', arguments: { path: '/tmp/test.txt' } },
        ],
      });

      mockChat.mockResolvedValueOnce(
        toAsync([
          { message: { content: toolCallJson }, done: false },
          {
            message: { content: '' },
            done: true,
            prompt_eval_count: 10,
            eval_count: 8,
          },
        ]),
      );

      // Native mode (no useStructuredOutput)
      const provider = new OllamaProvider(createConfig());
      const chunks = await collectChunks(
        provider.chat(
          createRequest({
            tools: [
              {
                name: 'file_read',
                description: 'Read a file',
                inputSchema: { properties: { path: { type: 'string' } } },
              },
            ],
          }),
        ),
      );

      // Should NOT have parsed tool calls from text
      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);
      expect(toolChunk).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('chat — error handling', () => {
    it('should throw LLMProviderError for connection errors', async () => {
      mockChat.mockRejectedValueOnce(new Error('fetch failed'));

      const provider = new OllamaProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(/connection failed/i);
    });

    it('should throw LLMProviderError for model not found', async () => {
      mockChat.mockRejectedValueOnce(
        new Error('model "nonexistent" not found'),
      );

      const provider = new OllamaProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(/model not found/i);
    });

    it('should wrap generic errors as LLMProviderError', async () => {
      mockChat.mockRejectedValueOnce(new Error('Something went wrong'));

      const provider = new OllamaProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(LLMProviderError);
    });

    it('should handle errors during streaming', async () => {
      async function* errorStream(): AsyncIterable<unknown> {
        await Promise.resolve();
        yield { message: { content: 'start' }, done: false };
        throw new Error('Stream interrupted');
      }
      mockChat.mockResolvedValueOnce(errorStream());

      const provider = new OllamaProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(LLMProviderError);
    });

    it('should throw LLMProviderError when AbortSignal is already aborted', async () => {
      async function* slowStream(): AsyncIterable<unknown> {
        yield { message: { content: 'Hello' }, done: false };
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { message: { content: 'more' }, done: false };
      }
      mockChat.mockResolvedValueOnce(slowStream());

      const controller = new AbortController();
      controller.abort();

      const provider = new OllamaProvider(createConfig());

      await expect(
        collectChunks(
          provider.chat(createRequest({ signal: controller.signal })),
        ),
      ).rejects.toThrow(LLMProviderError);
    });
  });

  // ---------------------------------------------------------------------------
  // Token estimation
  // ---------------------------------------------------------------------------

  describe('estimateTokens', () => {
    it('should estimate roughly 1 token per 4 characters', () => {
      const provider = new OllamaProvider(createConfig());
      expect(provider.estimateTokens('a'.repeat(100))).toBe(25);
    });

    it('should return 0 for empty string', () => {
      const provider = new OllamaProvider(createConfig());
      expect(provider.estimateTokens('')).toBe(0);
    });

    it('should ceil non-exact divisions', () => {
      const provider = new OllamaProvider(createConfig());
      expect(provider.estimateTokens('hello')).toBe(2);
    });
  });
});
