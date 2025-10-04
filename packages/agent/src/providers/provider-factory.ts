import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { MastraLanguageModel } from '@mastra/core/agent';
import type { SupportedProvider } from './types';

/**
 * Default model for each provider
 */
const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  google: 'gemini-2.5-flash',
  openrouter: 'gpt-4o-mini',
};

/**
 * Create a language model instance for the specified provider
 *
 * @param provider - The AI provider to use
 * @param apiKey - Optional API key (uses environment variables if not provided)
 * @param model - Optional model name (uses provider-specific default if not provided)
 * @returns A language model instance configured for the provider
 * @throws Error if the provider is not supported or API key is missing
 */
export function createProvider(
  provider: SupportedProvider | string,
  apiKey?: string,
  model?: string
): MastraLanguageModel {
  const modelName = model ?? DEFAULT_MODELS[provider as SupportedProvider];

  switch (provider) {
    case 'openai': {
      const openaiProvider = createOpenAI(apiKey ? { apiKey } : undefined);
      return openaiProvider(modelName);
    }

    case 'anthropic': {
      const anthropicProvider = createAnthropic(apiKey ? { apiKey } : undefined);
      return anthropicProvider(modelName);
    }

    case 'google': {
      const googleProvider = createGoogleGenerativeAI(apiKey ? { apiKey } : undefined);
      return googleProvider(modelName);
    }

    case 'openrouter': {
      // OpenRouter uses OpenAI-compatible API
      const openrouterProvider = createOpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        ...(apiKey ? { apiKey } : {}),
      });
      return openrouterProvider(modelName);
    }

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Get the default model name for a provider
 */
export function getDefaultModel(provider: SupportedProvider | string): string {
  return DEFAULT_MODELS[provider as SupportedProvider] ?? DEFAULT_MODELS.openai;
}
