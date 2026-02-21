import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createMastraAgentError } from '../mastra/mastra-agent-error';
import { createLocalLanguageModel } from './local';
import {
  isSupportedProvider,
  listProviders,
  PROVIDER_DEFAULT_MODELS,
  type SupportedProvider,
} from './types';

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
): MastraModelConfig {
  const supportedProviders = listProviders().map(
    (entry) => entry.id
  ) as readonly SupportedProvider[];
  if (!isSupportedProvider(provider)) {
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      detail: `Unsupported provider: ${provider}`,
      context: { provider, supportedProviders },
    });
  }

  const validatedProvider = provider;
  const modelName = model ?? PROVIDER_DEFAULT_MODELS[validatedProvider];
  if (!modelName) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: `No default model configured for provider: ${provider}`,
      context: { provider },
    });
  }

  switch (validatedProvider) {
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

    case 'ollama': {
      // Ollama exposes OpenAI-compatible routes on localhost.
      const ollamaProvider = createOpenAI({
        baseURL: 'http://127.0.0.1:11434/v1',
        ...(apiKey ? { apiKey } : {}),
      });
      return ollamaProvider(modelName);
    }

    case 'lmstudio': {
      // LM Studio exposes OpenAI-compatible routes on localhost.
      const lmStudioProvider = createOpenAI({
        baseURL: 'http://localhost:1234/v1',
        ...(apiKey ? { apiKey } : {}),
      });
      return lmStudioProvider(modelName);
    }

    case 'local': {
      // Local models use Transformers.js running in-browser via WebGPU/WASM
      return createLocalLanguageModel(modelName) as MastraModelConfig;
    }

    default:
      throw createMastraAgentError('mastra_agent_unsupported_provider', {
        detail: `Unsupported provider: ${provider}`,
        context: { provider, supportedProviders },
      });
  }
}

/**
 * Get the default model name for a provider
 */
export function getDefaultModel(provider: SupportedProvider | string): string {
  if (isSupportedProvider(provider)) {
    return PROVIDER_DEFAULT_MODELS[provider] ?? '';
  }
  return PROVIDER_DEFAULT_MODELS.openai ?? '';
}
