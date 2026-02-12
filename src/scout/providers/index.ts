// @meridian/scout — Provider factory (Section 5.2.4)
// Creates LLM provider instances from configuration.

import type { LLMProvider } from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import type { ProviderConfig, ProviderType } from './provider.js';

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Creates an LLMProvider from a ProviderConfig.
 * Supports all configured providers: anthropic, openai, google, ollama, openrouter.
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider(config);

    case 'openai':
      return new OpenAIProvider(config);

    case 'google':
      return new GoogleProvider(config);

    case 'ollama':
      return new OllamaProvider(config);

    case 'openrouter':
      return new OpenRouterProvider(config);

    default:
      throw new LLMProviderError(
        `Unknown provider type: "${config.type as string}"`,
      );
  }
}

/**
 * Detects provider type from a ScoutConfig. Validates the provider name.
 */
export function resolveProviderType(provider: string): ProviderType {
  const valid: ProviderType[] = [
    'anthropic',
    'openai',
    'google',
    'ollama',
    'openrouter',
  ];
  if (valid.includes(provider as ProviderType)) {
    return provider as ProviderType;
  }
  throw new LLMProviderError(`Unknown provider: "${provider}"`);
}

// Re-exports
export { AnthropicProvider } from './anthropic.js';
export {
  toAnthropicTools,
  toAnthropicMessages,
  parseToolUseBlock,
} from './anthropic.js';

export { OpenAIProvider } from './openai.js';
export {
  toOpenAITools,
  toOpenAIMessages,
  parseOpenAIToolCall,
  openAIStreamingChat,
  openAIEstimateTokens,
} from './openai.js';

export { GoogleProvider } from './google.js';
export {
  toGoogleTools,
  toGoogleMessages,
  parseGoogleFunctionCall,
  resetToolCallCounter as resetGoogleToolCallCounter,
} from './google.js';

export { OllamaProvider } from './ollama.js';
export {
  toOllamaTools,
  toOllamaMessages,
  parseOllamaToolCall,
  buildStructuredOutputPrompt,
  parseStructuredOutput,
  resetToolCallCounter as resetOllamaToolCallCounter,
} from './ollama.js';

export { OpenRouterProvider } from './openrouter.js';

export type { ProviderConfig, ProviderType } from './provider.js';
export { withStreamingTimeouts } from './provider.js';
