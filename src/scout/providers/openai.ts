// @meridian/scout — OpenAI provider adapter
// Implements Section 5.2.4 (LLM Provider Abstraction) and Section 5.2.5 (Tool Use Translation).
// Also provides shared streaming logic reused by OpenRouter (Section 5.2.4).

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import type { ProviderConfig } from './provider.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough bytes-per-token for estimation (~4 chars/token for GPT models). */
const CHARS_PER_TOKEN = 4;

/** Default max context tokens for GPT-4o class models. */
const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

// ---------------------------------------------------------------------------
// Tool use translation (Section 5.2.5)
// ---------------------------------------------------------------------------

/**
 * Outbound: Converts Meridian ToolDefinition[] to OpenAI ChatCompletionTool[] format.
 * Gear actions become `functions` entries in the `tools` array.
 */
export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object' as const,
        ...tool.inputSchema,
      },
    },
  }));
}

/**
 * Inbound: Parses an OpenAI tool call into a Meridian ToolCall.
 */
export function parseOpenAIToolCall(toolCall: {
  id: string;
  name: string;
  arguments: string;
}): ToolCall {
  let input: Record<string, unknown> = {};
  try {
    input = toolCall.arguments
      ? (JSON.parse(toolCall.arguments) as Record<string, unknown>)
      : {};
  } catch {
    // Malformed JSON — pass empty input
  }
  return { id: toolCall.id, name: toolCall.name, input };
}

// ---------------------------------------------------------------------------
// OpenAI message translation
// ---------------------------------------------------------------------------

/**
 * Converts Meridian ChatMessage[] to OpenAI API format.
 * OpenAI supports the system role natively, so no extraction is needed.
 */
export function toOpenAIMessages(
  messages: ChatMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Maps OpenAI SDK errors to Meridian error types.
 */
export function mapOpenAIError(error: unknown): LLMProviderError {
  if (error instanceof OpenAI.APIError) {
    const status = error.status as number | undefined;
    const message = error.message || 'Unknown OpenAI API error';

    if (status === 401) {
      return new LLMProviderError(
        `OpenAI authentication failed: ${message}`,
        { cause: error },
      );
    }
    if (status === 429) {
      return new LLMProviderError(
        `OpenAI rate limit exceeded: ${message}`,
        { cause: error },
      );
    }
    if (status !== undefined && status >= 500) {
      return new LLMProviderError(
        `OpenAI server error (${status}): ${message}`,
        { cause: error },
      );
    }

    return new LLMProviderError(
      `OpenAI API error (${String(status)}): ${message}`,
      { cause: error },
    );
  }

  if (error instanceof Error) {
    return new LLMProviderError(
      `OpenAI provider error: ${error.message}`,
      { cause: error },
    );
  }

  return new LLMProviderError('Unknown OpenAI provider error');
}

// ---------------------------------------------------------------------------
// Shared streaming logic (used by both OpenAI and OpenRouter)
// ---------------------------------------------------------------------------

/**
 * Core streaming chat logic for OpenAI-compatible APIs.
 * Extracted as a standalone generator so OpenRouter can reuse it.
 */
export async function* openAIStreamingChat(
  client: OpenAI,
  request: ChatRequest,
): AsyncIterable<ChatChunk> {
  const messages = toOpenAIMessages(request.messages);

  const params: OpenAI.ChatCompletionCreateParamsStreaming = {
    model: request.model,
    messages,
    max_completion_tokens: request.maxTokens ?? 4096,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.stopSequences?.length
      ? { stop: request.stopSequences }
      : {}),
  };

  // Outbound tool use translation (Section 5.2.5)
  if (request.tools?.length) {
    params.tools = toOpenAITools(request.tools);
  }

  let stream: AsyncIterable<ChatCompletionChunk>;
  try {
    stream = await client.chat.completions.create(params, {
      signal: request.signal ?? undefined,
    });
  } catch (error: unknown) {
    throw mapOpenAIError(error);
  }

  // Track tool calls being built across streaming chunks
  const pendingToolCalls: Map<
    number,
    { id: string; name: string; argParts: string[] }
  > = new Map();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    for await (const chunk of stream) {
      if (request.signal?.aborted) {
        throw new LLMProviderError('LLM request aborted');
      }

      // Usage-only chunk (final chunk with stream_options.include_usage)
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }

      const choice = chunk.choices[0];
      if (!choice) {
        continue;
      }

      const delta = choice.delta;

      // Text content
      if (delta.content) {
        yield { content: delta.content, done: false };
      }

      // Tool calls (accumulate partial arguments)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          if (tc.id) {
            // Start of a new tool call
            pendingToolCalls.set(index, {
              id: tc.id,
              name: tc.function?.name ?? '',
              argParts: tc.function?.arguments
                ? [tc.function.arguments]
                : [],
            });
          } else {
            // Continuation of existing tool call
            const pending = pendingToolCalls.get(index);
            if (pending) {
              if (tc.function?.name) {
                pending.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                pending.argParts.push(tc.function.arguments);
              }
            }
          }
        }
      }

      // Finish reason — emit accumulated tool calls
      if (choice.finish_reason && pendingToolCalls.size > 0) {
        const toolCalls: ToolCall[] = [];
        for (const [, pending] of pendingToolCalls) {
          const argStr = pending.argParts.join('');
          let input: Record<string, unknown> = {};
          try {
            input = argStr
              ? (JSON.parse(argStr) as Record<string, unknown>)
              : {};
          } catch {
            // Malformed JSON — pass empty input
          }
          toolCalls.push({
            id: pending.id,
            name: pending.name,
            input,
          });
        }
        yield { content: '', done: false, toolCalls };
        pendingToolCalls.clear();
      }
    }

    // Final done chunk with usage
    yield {
      content: '',
      done: true,
      usage: { inputTokens, outputTokens },
    };
  } catch (error: unknown) {
    if (error instanceof LLMProviderError) {
      throw error;
    }
    throw mapOpenAIError(error);
  }
}

/**
 * Shared token estimation for OpenAI-compatible models (~4 chars/token).
 */
export function openAIEstimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// OpenAI provider adapter
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly id: string;
  readonly name = 'openai';
  readonly maxContextTokens: number;

  private readonly client: OpenAI;

  constructor(config: ProviderConfig) {
    this.id = `openai:${config.model}`;
    this.maxContextTokens =
      config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

    // Single persistent connection per provider (Section 11.2).
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  /**
   * Streaming chat completion. Yields ChatChunk objects as the LLM responds.
   * Supports tool use translation and AbortSignal cancellation.
   */
  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    yield* openAIStreamingChat(this.client, request);
  }

  /**
   * Rough token count estimation (~4 chars/token for GPT models).
   */
  estimateTokens(text: string): number {
    return openAIEstimateTokens(text);
  }
}
