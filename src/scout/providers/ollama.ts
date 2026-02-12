// @meridian/scout — Ollama provider adapter
// Implements Section 5.2.4 (LLM Provider Abstraction) and Section 5.2.5 (Tool Use Translation).
// Includes fallback mode for models without native tool calling (Section 5.2.5).

import { Ollama } from 'ollama';

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

/** Rough bytes-per-token for estimation (~4 chars/token for typical LLMs). */
const CHARS_PER_TOKEN = 4;

/** Default max context tokens for Ollama models. */
const DEFAULT_MAX_CONTEXT_TOKENS = 8_192;

/** Default Ollama host. */
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

// ---------------------------------------------------------------------------
// Tool use translation (Section 5.2.5)
// ---------------------------------------------------------------------------

/**
 * Outbound: Converts Meridian ToolDefinition[] to Ollama tool format.
 * Ollama uses an OpenAI-compatible tool format with type: 'function'.
 */
export function toOllamaTools(
  tools: ToolDefinition[],
): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        ...tool.inputSchema,
      },
    },
  }));
}

/**
 * Inbound: Parses an Ollama tool call into a Meridian ToolCall.
 * Ollama returns arguments as already-parsed objects (not JSON strings).
 */
let toolCallCounter = 0;

export function parseOllamaToolCall(toolCall: {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}): ToolCall {
  // Runtime guard: Ollama may deliver null/undefined args in edge cases
  const args: unknown = toolCall.function.arguments;
  return {
    id: `ollama-tc-${toolCallCounter++}`,
    name: toolCall.function.name,
    input:
      typeof args === 'object' && args !== null
        ? (args as Record<string, unknown>)
        : {},
  };
}

/**
 * Reset the tool call counter (for testing).
 */
export function resetToolCallCounter(): void {
  toolCallCounter = 0;
}

// ---------------------------------------------------------------------------
// Ollama message translation
// ---------------------------------------------------------------------------

/**
 * Converts Meridian ChatMessage[] to Ollama message format.
 * Ollama supports system, user, and assistant roles natively.
 */
export function toOllamaMessages(
  messages: ChatMessage[],
): Array<{ role: string; content: string }> {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

// ---------------------------------------------------------------------------
// Structured output fallback (Section 5.2.5)
// ---------------------------------------------------------------------------

/**
 * Builds the structured output system prompt for models without native tool calling.
 * Includes the plan JSON Schema and explicit instructions to produce conforming JSON.
 */
export function buildStructuredOutputPrompt(
  tools: ToolDefinition[],
): string {
  const toolDescriptions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: { type: 'object', ...tool.inputSchema },
  }));

  return [
    'You have access to the following tools. When you need to use a tool,',
    'respond ONLY with a JSON object in this exact format:',
    '',
    '```json',
    '{',
    '  "tool_calls": [',
    '    {',
    '      "name": "<tool_name>",',
    '      "arguments": { <parameters as key-value pairs> }',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Available tools:',
    JSON.stringify(toolDescriptions, null, 2),
    '',
    'If you do not need to use a tool, respond with plain text.',
    'When using tools, output ONLY the JSON — no additional text.',
  ].join('\n');
}

/**
 * Attempts to parse accumulated text as structured tool call output.
 * Returns parsed tool calls or undefined if the text is not valid JSON.
 */
export function parseStructuredOutput(
  text: string,
): ToolCall[] | undefined {
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();

  if (!cleaned.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const calls = parsed.tool_calls;

    if (!Array.isArray(calls) || calls.length === 0) {
      return undefined;
    }

    return (calls as Array<{ name: string; arguments: unknown }>).map(
      (tc) => ({
        id: `ollama-tc-${toolCallCounter++}`,
        name: tc.name,
        input:
          typeof tc.arguments === 'object' && tc.arguments !== null
            ? (tc.arguments as Record<string, unknown>)
            : {},
      }),
    );
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Maps Ollama errors to Meridian error types.
 */
function mapOllamaError(error: unknown): LLMProviderError {
  if (error instanceof Error) {
    const message = error.message || 'Unknown Ollama error';

    // Connection errors
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('fetch failed')
    ) {
      return new LLMProviderError(
        `Ollama connection failed (is Ollama running?): ${message}`,
        { cause: error },
      );
    }

    // Model not found
    if (message.includes('not found') || message.includes('pull')) {
      return new LLMProviderError(
        `Ollama model not found: ${message}`,
        { cause: error },
      );
    }

    return new LLMProviderError(`Ollama provider error: ${message}`, {
      cause: error,
    });
  }

  return new LLMProviderError('Unknown Ollama provider error');
}

// ---------------------------------------------------------------------------
// Ollama provider adapter
// ---------------------------------------------------------------------------

export class OllamaProvider implements LLMProvider {
  readonly id: string;
  readonly name = 'ollama';
  readonly maxContextTokens: number;

  private readonly client: Ollama;
  private readonly useStructuredOutput: boolean;

  constructor(config: ProviderConfig) {
    this.id = `ollama:${config.model}`;
    this.maxContextTokens =
      config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

    // Structured output fallback for models without native tool calling
    this.useStructuredOutput =
      config.metadata?.useStructuredOutput === true;

    this.client = new Ollama({
      host: config.baseUrl ?? DEFAULT_OLLAMA_HOST,
    });
  }

  /**
   * Streaming chat completion. Yields ChatChunk objects as the LLM responds.
   * When useStructuredOutput is true and tools are provided, falls back to
   * structured-output prompting mode (Section 5.2.5).
   */
  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const hasTools =
      request.tools !== undefined && request.tools.length > 0;
    const usesFallback = hasTools && this.useStructuredOutput;

    const messages = toOllamaMessages(request.messages);

    // In structured output mode, inject tool schema into system prompt
    if (usesFallback && request.tools) {
      const structuredPrompt = buildStructuredOutputPrompt(request.tools);
      // Prepend structured output instructions to existing system messages
      const systemIdx = messages.findIndex((m) => m.role === 'system');
      const systemMsg = messages[systemIdx];
      if (systemIdx >= 0 && systemMsg) {
        systemMsg.content = `${structuredPrompt}\n\n${systemMsg.content}`;
      } else {
        messages.unshift({ role: 'system', content: structuredPrompt });
      }
    }

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const response = await this.client.chat({
        model: request.model,
        messages,
        stream: true,
        // Only pass tools in native mode
        ...(hasTools && !usesFallback && request.tools
          ? { tools: toOllamaTools(request.tools) }
          : {}),
        options: {
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          ...(request.stopSequences?.length
            ? { stop: request.stopSequences }
            : {}),
          ...(request.maxTokens !== undefined
            ? { num_predict: request.maxTokens }
            : {}),
        },
      });

      let accumulatedText = '';

      for await (const chunk of response) {
        if (request.signal?.aborted) {
          // Abort the stream if available
          if ('abort' in response && typeof response.abort === 'function') {
            (response as unknown as { abort: () => void }).abort();
          }
          throw new LLMProviderError('LLM request aborted');
        }

        // Text content
        if (chunk.message.content) {
          if (usesFallback) {
            // In fallback mode, accumulate text for parsing
            accumulatedText += chunk.message.content;
          }
          yield { content: chunk.message.content, done: false };
        }

        // Native tool calls (only in non-fallback mode)
        if (
          !usesFallback &&
          chunk.message.tool_calls &&
          chunk.message.tool_calls.length > 0
        ) {
          const toolCalls: ToolCall[] = chunk.message.tool_calls.map(
            (tc) =>
              parseOllamaToolCall(
                tc as {
                  function: {
                    name: string;
                    arguments: Record<string, unknown>;
                  };
                },
              ),
          );
          yield { content: '', done: false, toolCalls };
        }

        // Capture token counts from the final chunk
        if (chunk.done) {
          inputTokens = chunk.prompt_eval_count;
          outputTokens = chunk.eval_count;
        }
      }

      // In fallback mode, attempt to parse accumulated text as tool calls
      if (usesFallback && accumulatedText) {
        const parsedCalls = parseStructuredOutput(accumulatedText);
        if (parsedCalls) {
          yield { content: '', done: false, toolCalls: parsedCalls };
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
      throw mapOllamaError(error);
    }
  }

  /**
   * Rough token count estimation (~4 chars/token).
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
