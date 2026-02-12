// @meridian/scout — Provider factory (Section 5.2.4)
// Creates LLM provider instances from configuration.

import type { LLMProvider } from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import { AnthropicProvider } from './anthropic.js';
import type { ProviderConfig, ProviderType } from './provider.js';

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Creates an LLMProvider from a ProviderConfig.
 * In v0.1, only the Anthropic provider is supported.
 * Other providers (openai, google, ollama, openrouter) are deferred to v0.2 (Phase 9).
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider(config);

    case 'openai':
    case 'google':
    case 'ollama':
    case 'openrouter':
      throw new LLMProviderError(
        `Provider "${config.type}" is not yet supported. Only "anthropic" is available in v0.1.`,
      );

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
  const valid: ProviderType[] = ['anthropic', 'openai', 'google', 'ollama', 'openrouter'];
  if (valid.includes(provider as ProviderType)) {
    return provider as ProviderType;
  }
  throw new LLMProviderError(`Unknown provider: "${provider}"`);
}

// Re-exports
export { AnthropicProvider } from './anthropic.js';
export type { ProviderConfig, ProviderType } from './provider.js';
export { withStreamingTimeouts } from './provider.js';
export { toAnthropicTools, toAnthropicMessages, parseToolUseBlock } from './anthropic.js';
