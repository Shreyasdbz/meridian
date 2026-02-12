// @meridian/scout — Google Gemini provider adapter
// Implements Section 5.2.4 (LLM Provider Abstraction) and Section 5.2.5 (Tool Use Translation).

import {
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  SchemaType,
} from '@google/generative-ai';
import type {
  Content,
  FunctionDeclaration,
  FunctionDeclarationsTool,
  GenerativeModel,
} from '@google/generative-ai';

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

/** Rough bytes-per-token for estimation (~4 chars/token for Gemini models). */
const CHARS_PER_TOKEN = 4;

/** Default max context tokens for Gemini models. */
const DEFAULT_MAX_CONTEXT_TOKENS = 1_000_000;

// ---------------------------------------------------------------------------
// Tool use translation (Section 5.2.5)
// ---------------------------------------------------------------------------

/**
 * Maps a simple JSON Schema type string to the Google SchemaType enum.
 */
function mapSchemaType(type: string): SchemaType {
  switch (type) {
    case 'string':
      return SchemaType.STRING;
    case 'number':
      return SchemaType.NUMBER;
    case 'integer':
      return SchemaType.INTEGER;
    case 'boolean':
      return SchemaType.BOOLEAN;
    case 'array':
      return SchemaType.ARRAY;
    case 'object':
      return SchemaType.OBJECT;
    default:
      return SchemaType.STRING;
  }
}

/**
 * Converts a JSON Schema property to Google's FunctionDeclarationSchemaProperty.
 * Handles nested objects and arrays recursively.
 */
function convertSchemaProperty(
  prop: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (prop.type) {
    result.type = mapSchemaType(prop.type as string);
  }
  if (prop.description) {
    result.description = prop.description;
  }
  if (prop.enum) {
    result.enum = prop.enum;
  }

  // Handle nested object properties
  if (prop.properties && typeof prop.properties === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      prop.properties as Record<string, Record<string, unknown>>,
    )) {
      properties[key] = convertSchemaProperty(value);
    }
    result.properties = properties;
  }

  // Handle array items
  if (prop.items && typeof prop.items === 'object') {
    result.items = convertSchemaProperty(
      prop.items as Record<string, unknown>,
    );
  }

  if (prop.required) {
    result.required = prop.required;
  }

  return result;
}

/**
 * Outbound: Converts Meridian ToolDefinition[] to Google FunctionDeclarationsTool format.
 * Gear actions become FunctionDeclaration entries.
 */
export function toGoogleTools(
  tools: ToolDefinition[],
): FunctionDeclarationsTool[] {
  const declarations: FunctionDeclaration[] = tools.map((tool) => {
    const decl: FunctionDeclaration = {
      name: tool.name,
      description: tool.description,
    };

    // Convert inputSchema to Google's parameter format
    if (
      tool.inputSchema.properties &&
      typeof tool.inputSchema.properties === 'object'
    ) {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        tool.inputSchema.properties as Record<
          string,
          Record<string, unknown>
        >,
      )) {
        properties[key] = convertSchemaProperty(value);
      }

      // Type assertion needed: we dynamically construct Google's Schema
      // from Meridian's JSON Schema format via convertSchemaProperty().
      decl.parameters = {
        type: SchemaType.OBJECT,
        properties,
        ...(tool.inputSchema.required
          ? { required: tool.inputSchema.required as string[] }
          : {}),
      } as unknown as FunctionDeclaration['parameters'];
    }

    return decl;
  });

  return [{ functionDeclarations: declarations }];
}

/**
 * Inbound: Converts a Google FunctionCall to a Meridian ToolCall.
 * Google does not provide tool call IDs, so we generate synthetic ones.
 */
let toolCallCounter = 0;

export function parseGoogleFunctionCall(funcCall: {
  name: string;
  args: Record<string, unknown>;
}): ToolCall {
  // Runtime guard: Google SDK may deliver null/undefined args in edge cases
  const args: unknown = funcCall.args;
  return {
    id: `google-tc-${toolCallCounter++}`,
    name: funcCall.name,
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
// Google message translation
// ---------------------------------------------------------------------------

/**
 * Converts Meridian ChatMessage[] to Google Content[] format.
 * Returns the system instruction separately (Google uses a separate parameter).
 * Google uses 'model' instead of 'assistant' for the role.
 */
export function toGoogleMessages(messages: ChatMessage[]): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = systemInstruction
        ? `${systemInstruction}\n\n${msg.content}`
        : msg.content;
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }

  return { systemInstruction, contents };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Maps Google Generative AI SDK errors to Meridian error types.
 */
function mapGoogleError(error: unknown): LLMProviderError {
  if (error instanceof GoogleGenerativeAIFetchError) {
    const status = error.status;
    const message = error.message || 'Unknown Google AI API error';

    if (status === 401 || status === 403) {
      return new LLMProviderError(
        `Google AI authentication failed: ${message}`,
        { cause: error },
      );
    }
    if (status === 429) {
      return new LLMProviderError(
        `Google AI rate limit exceeded: ${message}`,
        { cause: error },
      );
    }
    if (status !== undefined && status >= 500) {
      return new LLMProviderError(
        `Google AI server error (${status}): ${message}`,
        { cause: error },
      );
    }

    return new LLMProviderError(
      `Google AI API error (${String(status)}): ${message}`,
      { cause: error },
    );
  }

  if (error instanceof Error) {
    return new LLMProviderError(
      `Google AI provider error: ${error.message}`,
      { cause: error },
    );
  }

  return new LLMProviderError('Unknown Google AI provider error');
}

// ---------------------------------------------------------------------------
// Google provider adapter
// ---------------------------------------------------------------------------

export class GoogleProvider implements LLMProvider {
  readonly id: string;
  readonly name = 'google';
  readonly maxContextTokens: number;

  private readonly genAI: GoogleGenerativeAI;

  constructor(config: ProviderConfig) {
    this.id = `google:${config.model}`;
    this.maxContextTokens =
      config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

    if (!config.apiKey) {
      throw new LLMProviderError('Google AI API key is required');
    }

    this.genAI = new GoogleGenerativeAI(config.apiKey);
  }

  /**
   * Streaming chat completion. Yields ChatChunk objects as the LLM responds.
   * Supports tool use translation and AbortSignal cancellation.
   */
  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const { systemInstruction, contents } = toGoogleMessages(
      request.messages,
    );

    // Build the model with tools and system instruction
    const modelParams: Record<string, unknown> = {
      model: request.model,
    };

    if (request.tools && request.tools.length > 0) {
      modelParams.tools = toGoogleTools(request.tools);
    }

    if (systemInstruction) {
      modelParams.systemInstruction = systemInstruction;
    }

    const model: GenerativeModel = this.genAI.getGenerativeModel(
      modelParams as { model: string },
    );

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const result = await model.generateContentStream(
        {
          contents,
          generationConfig: {
            ...(request.maxTokens !== undefined
              ? { maxOutputTokens: request.maxTokens }
              : {}),
            ...(request.temperature !== undefined
              ? { temperature: request.temperature }
              : {}),
            ...(request.stopSequences?.length
              ? { stopSequences: request.stopSequences }
              : {}),
          },
        },
        { signal: request.signal },
      );

      for await (const chunk of result.stream) {
        if (request.signal?.aborted) {
          throw new LLMProviderError('LLM request aborted');
        }

        // Extract usage if available
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount;
          outputTokens = chunk.usageMetadata.candidatesTokenCount;
        }

        // Process candidates
        const candidate = chunk.candidates?.[0];
        if (!candidate) {
          continue;
        }

        for (const part of candidate.content.parts) {
          // Text content
          if (part.text) {
            yield { content: part.text, done: false };
          }

          // Function calls
          if (part.functionCall) {
            yield {
              content: '',
              done: false,
              toolCalls: [
                parseGoogleFunctionCall(
                  part.functionCall as {
                    name: string;
                    args: Record<string, unknown>;
                  },
                ),
              ],
            };
          }
        }
      }

      // Try to get final usage from the aggregated response
      try {
        const finalResponse = await result.response;
        if (finalResponse.usageMetadata) {
          inputTokens = finalResponse.usageMetadata.promptTokenCount;
          outputTokens =
            finalResponse.usageMetadata.candidatesTokenCount;
        }
      } catch {
        // Response may not be available; usage from stream chunks is sufficient
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
      throw mapGoogleError(error);
    }
  }

  /**
   * Rough token count estimation (~4 chars/token for Gemini models).
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
