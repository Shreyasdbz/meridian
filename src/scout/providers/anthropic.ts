// @meridian/scout — Anthropic provider adapter
// Implements Section 5.2.4 (LLM Provider Abstraction) and Section 5.2.5 (Tool Use Translation).

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  RawMessageStreamEvent,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';

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

/** Rough bytes-per-token for estimation (Anthropic averages ~4 chars/token). */
const CHARS_PER_TOKEN = 4;

/** Default max context tokens for Claude models. */
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

// ---------------------------------------------------------------------------
// Tool use translation (Section 5.2.5)
// ---------------------------------------------------------------------------

/**
 * Outbound: Converts Meridian ToolDefinition[] to Anthropic Tool[] format.
 * Gear actions become `tools` entries with `input_schema`.
 */
export function toAnthropicTools(tools: ToolDefinition[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      ...tool.inputSchema,
    },
  }));
}

/**
 * Inbound: Extracts ToolCall[] from Anthropic content_block_start events.
 * Accumulates partial JSON from input_json_delta events and parses on block stop.
 */
export function parseToolUseBlock(block: {
  id: string;
  name: string;
  input: unknown;
}): ToolCall {
  return {
    id: block.id,
    name: block.name,
    input: (typeof block.input === 'object' && block.input !== null
      ? block.input
      : {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Anthropic message translation
// ---------------------------------------------------------------------------

/**
 * Converts Meridian ChatMessage[] to Anthropic API format.
 * The system message is extracted and passed as the top-level `system` param.
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: MessageParam[];
} {
  let system: string | undefined;
  const apiMessages: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Anthropic uses a top-level system parameter, not a message role.
      // Concatenate multiple system messages (unlikely but handle gracefully).
      system = system ? `${system}\n\n${msg.content}` : msg.content;
    } else {
      apiMessages.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return { system, messages: apiMessages };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Maps Anthropic SDK errors to Meridian error types.
 */
function mapAnthropicError(error: unknown): LLMProviderError {
  if (error instanceof Anthropic.APIError) {
    const status = error.status as number | undefined;
    const message = error.message || 'Unknown Anthropic API error';

    if (status === 401) {
      return new LLMProviderError(`Anthropic authentication failed: ${message}`, { cause: error });
    }
    if (status === 429) {
      return new LLMProviderError(`Anthropic rate limit exceeded: ${message}`, { cause: error });
    }
    if (status === 529) {
      return new LLMProviderError(`Anthropic API overloaded: ${message}`, { cause: error });
    }
    if (status !== undefined && status >= 500) {
      return new LLMProviderError(`Anthropic server error (${status}): ${message}`, { cause: error });
    }

    return new LLMProviderError(`Anthropic API error (${String(status)}): ${message}`, { cause: error });
  }

  if (error instanceof Error) {
    return new LLMProviderError(`Anthropic provider error: ${error.message}`, { cause: error });
  }

  return new LLMProviderError('Unknown Anthropic provider error');
}

// ---------------------------------------------------------------------------
// Anthropic provider adapter
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly name = 'anthropic';
  readonly maxContextTokens: number;

  private readonly client: Anthropic;

  constructor(config: ProviderConfig) {
    this.id = `anthropic:${config.model}`;
    this.maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

    // Single persistent connection per provider (Section 11.2).
    // The Anthropic SDK reuses the underlying HTTP connection.
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  /**
   * Streaming chat completion. Yields ChatChunk objects as the LLM responds.
   * Supports tool use translation and AbortSignal cancellation.
   */
  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const { system, messages } = toAnthropicMessages(request.messages);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: true,
      ...(system !== undefined ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.stopSequences?.length ? { stop_sequences: request.stopSequences } : {}),
    };

    // Outbound tool use translation (Section 5.2.5)
    if (request.tools?.length) {
      params.tools = toAnthropicTools(request.tools);
    }

    let stream: AsyncIterable<RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(params, {
        signal: request.signal ?? null,
      });
    } catch (error: unknown) {
      throw mapAnthropicError(error);
    }

    // Track tool use blocks being built across streaming events
    const pendingToolCalls: Map<number, { id: string; name: string; jsonParts: string[] }> =
      new Map();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedTokens: number | undefined;

    try {
      for await (const event of stream) {
        if (request.signal?.aborted) {
          throw new LLMProviderError('LLM request aborted');
        }

        switch (event.type) {
          case 'message_start': {
            // Capture initial usage from the message_start event
            const usage = event.message.usage;
            inputTokens = usage.input_tokens;
            cachedTokens = usage.cache_read_input_tokens ?? undefined;
            break;
          }

          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              // Start accumulating tool call
              pendingToolCalls.set(event.index, {
                id: block.id,
                name: block.name,
                jsonParts: [],
              });
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;

            if (delta.type === 'text_delta') {
              yield {
                content: delta.text,
                done: false,
              };
            } else if (delta.type === 'input_json_delta') {
              // Accumulate partial JSON for tool call input
              const pending = pendingToolCalls.get(event.index);
              if (pending) {
                pending.jsonParts.push(delta.partial_json);
              }
            }
            break;
          }

          case 'content_block_stop': {
            // If this was a tool use block, finalize it
            const pending = pendingToolCalls.get(event.index);
            if (pending) {
              const jsonStr = pending.jsonParts.join('');
              let input: Record<string, unknown> = {};
              try {
                input = jsonStr ? (JSON.parse(jsonStr) as Record<string, unknown>) : {};
              } catch {
                // Malformed JSON from tool call — pass empty input
              }

              yield {
                content: '',
                done: false,
                toolCalls: [{
                  id: pending.id,
                  name: pending.name,
                  input,
                }],
              };

              pendingToolCalls.delete(event.index);
            }
            break;
          }

          case 'message_delta': {
            // Capture final usage
            const usage = event.usage;
            outputTokens = usage.output_tokens;
            if (usage.input_tokens !== null) {
              inputTokens = usage.input_tokens;
            }
            break;
          }

          case 'message_stop': {
            // Final chunk with usage summary
            yield {
              content: '',
              done: true,
              usage: {
                inputTokens,
                outputTokens,
                cachedTokens,
              },
            };
            break;
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof LLMProviderError) {
        throw error;
      }
      throw mapAnthropicError(error);
    }
  }

  /**
   * Rough token count estimation. Uses character-based heuristic (~4 chars/token).
   * Accurate counting requires the API's countTokens endpoint (used when precision matters).
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
