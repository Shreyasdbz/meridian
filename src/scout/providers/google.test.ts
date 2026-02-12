import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatChunk, ChatRequest, ToolDefinition } from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import {
  GoogleProvider,
  toGoogleTools,
  toGoogleMessages,
  parseGoogleFunctionCall,
  resetToolCallCounter,
} from './google.js';
import type { ProviderConfig } from './provider.js';

// ---------------------------------------------------------------------------
// Mock Google Generative AI SDK
// ---------------------------------------------------------------------------

const mockGenerateContentStream = vi.fn();

vi.mock('@google/generative-ai', () => {
  // Re-create the SchemaType enum
  const SchemaType = {
    STRING: 'string',
    NUMBER: 'number',
    INTEGER: 'integer',
    BOOLEAN: 'boolean',
    ARRAY: 'array',
    OBJECT: 'object',
  };

  class GoogleGenerativeAIError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GoogleGenerativeAIError';
    }
  }

  class GoogleGenerativeAIFetchError extends GoogleGenerativeAIError {
    readonly status: number | undefined;
    readonly statusText: string | undefined;
    constructor(message: string, status?: number, statusText?: string) {
      super(message);
      this.name = 'GoogleGenerativeAIFetchError';
      this.status = status;
      this.statusText = statusText;
    }
  }

  return {
    SchemaType,
    GoogleGenerativeAI: class MockGoogleGenerativeAI {
      getGenerativeModel() {
        return {
          generateContentStream: mockGenerateContentStream,
        };
      }
    },
    GoogleGenerativeAIFetchError,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    type: 'google',
    apiKey: 'test-key',
    model: 'gemini-2.0-flash',
    ...overrides,
  };
}

function createRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

/** Creates a mock stream result with async generator. */
function createMockStreamResult(
  chunks: Array<{
    candidates?: Array<{
      content?: { parts: Array<{ text?: string; functionCall?: unknown }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount: number;
      candidatesTokenCount: number;
      totalTokenCount: number;
    };
  }>,
  finalResponse?: unknown,
): { stream: AsyncGenerator; response: Promise<unknown> } {
  async function* makeStream(): AsyncGenerator {
    await Promise.resolve();
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  return {
    stream: makeStream(),
    response: Promise.resolve(
      finalResponse ?? chunks[chunks.length - 1] ?? {},
    ),
  };
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
// toGoogleTools — outbound tool use translation
// ---------------------------------------------------------------------------

describe('toGoogleTools', () => {
  it('should convert ToolDefinitions to Google FunctionDeclarationsTool format', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'file_read',
        description: 'Read a file from disk',
        inputSchema: {
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
      },
    ];

    const result = toGoogleTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]?.functionDeclarations).toHaveLength(1);
    expect(result[0]?.functionDeclarations?.[0]?.name).toBe('file_read');
    expect(result[0]?.functionDeclarations?.[0]?.description).toBe(
      'Read a file from disk',
    );
  });

  it('should convert multiple tools into a single FunctionDeclarationsTool', () => {
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

    const result = toGoogleTools(tools);
    expect(result).toHaveLength(1);
    expect(result[0]?.functionDeclarations).toHaveLength(2);
  });

  it('should handle empty tools array', () => {
    const result = toGoogleTools([]);
    expect(result).toHaveLength(1);
    expect(result[0]?.functionDeclarations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseGoogleFunctionCall — inbound tool use translation
// ---------------------------------------------------------------------------

describe('parseGoogleFunctionCall', () => {
  beforeEach(() => {
    resetToolCallCounter();
  });

  it('should convert a Google FunctionCall to a Meridian ToolCall', () => {
    const result = parseGoogleFunctionCall({
      name: 'file_read',
      args: { path: '/tmp/test.txt' },
    });

    expect(result).toEqual({
      id: 'google-tc-0',
      name: 'file_read',
      input: { path: '/tmp/test.txt' },
    });
  });

  it('should generate sequential synthetic IDs', () => {
    const first = parseGoogleFunctionCall({
      name: 'tool1',
      args: {},
    });
    const second = parseGoogleFunctionCall({
      name: 'tool2',
      args: {},
    });

    expect(first.id).toBe('google-tc-0');
    expect(second.id).toBe('google-tc-1');
  });

  it('should handle null args gracefully', () => {
    const result = parseGoogleFunctionCall({
      name: 'noop',
      args: null as unknown as Record<string, unknown>,
    });
    expect(result.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// toGoogleMessages — message translation
// ---------------------------------------------------------------------------

describe('toGoogleMessages', () => {
  it('should extract system message and convert roles', () => {
    const result = toGoogleMessages([
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);

    expect(result.systemInstruction).toBe('You are a helper.');
    expect(result.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there!' }] },
    ]);
  });

  it('should handle messages with no system prompt', () => {
    const result = toGoogleMessages([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.systemInstruction).toBeUndefined();
    expect(result.contents).toHaveLength(1);
  });

  it('should concatenate multiple system messages', () => {
    const result = toGoogleMessages([
      { role: 'system', content: 'First instruction.' },
      { role: 'system', content: 'Second instruction.' },
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.systemInstruction).toBe(
      'First instruction.\n\nSecond instruction.',
    );
  });

  it('should handle empty messages array', () => {
    const result = toGoogleMessages([]);
    expect(result.systemInstruction).toBeUndefined();
    expect(result.contents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GoogleProvider — constructor
// ---------------------------------------------------------------------------

describe('GoogleProvider', () => {
  beforeEach(() => {
    mockGenerateContentStream.mockReset();
    resetToolCallCounter();
  });

  describe('constructor', () => {
    it('should set provider id with model name', () => {
      const provider = new GoogleProvider(createConfig());
      expect(provider.id).toBe('google:gemini-2.0-flash');
    });

    it('should set name to "google"', () => {
      const provider = new GoogleProvider(createConfig());
      expect(provider.name).toBe('google');
    });

    it('should use default max context tokens when not specified', () => {
      const provider = new GoogleProvider(createConfig());
      expect(provider.maxContextTokens).toBe(1_000_000);
    });

    it('should throw if no API key is provided', () => {
      expect(
        () => new GoogleProvider(createConfig({ apiKey: undefined })),
      ).toThrow(LLMProviderError);
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming text response
  // ---------------------------------------------------------------------------

  describe('chat — streaming text', () => {
    it('should yield text chunks from a streaming response', async () => {
      mockGenerateContentStream.mockResolvedValueOnce(
        createMockStreamResult([
          {
            candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
          },
          {
            candidates: [{ content: { parts: [{ text: ' world' }] } }],
          },
          {
            candidates: [{ content: { parts: [{ text: '!' }] } }],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
            },
          },
        ]),
      );

      const provider = new GoogleProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(3);
      expect(textChunks[0]?.content).toBe('Hello');
      expect(textChunks[1]?.content).toBe(' world');
      expect(textChunks[2]?.content).toBe('!');

      const lastChunk = chunks.at(-1);
      expect(lastChunk?.done).toBe(true);
      expect(lastChunk?.usage?.inputTokens).toBe(10);
      expect(lastChunk?.usage?.outputTokens).toBe(5);
    });

    it('should handle empty candidates gracefully', async () => {
      mockGenerateContentStream.mockResolvedValueOnce(
        createMockStreamResult([
          { candidates: [] },
          {
            candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
          },
        ]),
      );

      const provider = new GoogleProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0]?.content).toBe('Hello');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool use translation (streaming)
  // ---------------------------------------------------------------------------

  describe('chat — tool use', () => {
    it('should yield tool calls from function call parts', async () => {
      mockGenerateContentStream.mockResolvedValueOnce(
        createMockStreamResult([
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: 'file_read',
                        args: { path: '/tmp/test.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 10,
              totalTokenCount: 30,
            },
          },
        ]),
      );

      const provider = new GoogleProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const toolChunk = chunks.find((c) => c.toolCalls !== undefined);
      expect(toolChunk).toBeDefined();
      expect(toolChunk?.toolCalls).toHaveLength(1);
      expect(toolChunk?.toolCalls?.[0]?.name).toBe('file_read');
      expect(toolChunk?.toolCalls?.[0]?.input).toEqual({
        path: '/tmp/test.txt',
      });
    });

    it('should handle interleaved text and function calls', async () => {
      mockGenerateContentStream.mockResolvedValueOnce(
        createMockStreamResult([
          {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Let me read that.' }],
                },
              },
            ],
          },
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: 'file_read',
                        args: { path: '/etc/hosts' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]),
      );

      const provider = new GoogleProvider(createConfig());
      const chunks = await collectChunks(provider.chat(createRequest()));

      const textChunks = chunks.filter((c) => c.content !== '');
      expect(textChunks).toHaveLength(1);

      const toolChunks = chunks.filter((c) => c.toolCalls !== undefined);
      expect(toolChunks).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('chat — error handling', () => {
    it('should throw LLMProviderError for authentication errors', async () => {
      const { GoogleGenerativeAIFetchError } = (await import(
        '@google/generative-ai'
      )) as { GoogleGenerativeAIFetchError: new (m: string, s?: number) => Error };
      mockGenerateContentStream.mockRejectedValueOnce(
        new GoogleGenerativeAIFetchError('Forbidden', 403),
      );

      const provider = new GoogleProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(/authentication failed/i);
    });

    it('should throw LLMProviderError for rate limit errors', async () => {
      const { GoogleGenerativeAIFetchError } = (await import(
        '@google/generative-ai'
      )) as { GoogleGenerativeAIFetchError: new (m: string, s?: number) => Error };
      mockGenerateContentStream.mockRejectedValueOnce(
        new GoogleGenerativeAIFetchError('Too many requests', 429),
      );

      const provider = new GoogleProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(LLMProviderError);
    });

    it('should throw LLMProviderError for server errors', async () => {
      const { GoogleGenerativeAIFetchError } = (await import(
        '@google/generative-ai'
      )) as { GoogleGenerativeAIFetchError: new (m: string, s?: number) => Error };
      mockGenerateContentStream.mockRejectedValueOnce(
        new GoogleGenerativeAIFetchError('Internal error', 500),
      );

      const provider = new GoogleProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(/server error/i);
    });

    it('should wrap non-SDK errors as LLMProviderError', async () => {
      mockGenerateContentStream.mockRejectedValueOnce(
        new Error('Network failure'),
      );

      const provider = new GoogleProvider(createConfig());

      await expect(
        collectChunks(provider.chat(createRequest())),
      ).rejects.toThrow(LLMProviderError);
    });

    it('should handle errors during streaming', async () => {
      async function* errorStream(): AsyncGenerator {
        await Promise.resolve();
        yield {
          candidates: [{ content: { parts: [{ text: 'start' }] } }],
        };
        throw new Error('Stream interrupted');
      }

      const rejectedResponse = Promise.reject(new Error('Stream interrupted'));
      // Prevent unhandled rejection — the provider will catch this.
      rejectedResponse.catch(() => {});

      mockGenerateContentStream.mockResolvedValueOnce({
        stream: errorStream(),
        response: rejectedResponse,
      });

      const provider = new GoogleProvider(createConfig());

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
      const provider = new GoogleProvider(createConfig());
      expect(provider.estimateTokens('a'.repeat(100))).toBe(25);
    });

    it('should return 0 for empty string', () => {
      const provider = new GoogleProvider(createConfig());
      expect(provider.estimateTokens('')).toBe(0);
    });

    it('should ceil non-exact divisions', () => {
      const provider = new GoogleProvider(createConfig());
      expect(provider.estimateTokens('hello')).toBe(2);
    });
  });
});
