import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createMastraAgentError } from '../mastra/mastra-agent-error';
import type { RuntimeData } from '../types';
import { createLocalLanguageModel } from './local';
import { resolveRuntimeBaseUrl } from './local-runtime-discovery';
import { buildRuntimeEndpoint, type LocalRuntimeEndpointConfig } from './local-runtime-utils';
import {
  isSupportedProvider,
  listProviders,
  PROVIDER_DEFAULT_MODELS,
  type SupportedProvider,
} from './types';

function resolveLocalRuntimeBaseUrl(
  runtime: 'ollama' | 'lmstudio',
  override: string | undefined
): string {
  // The `createOpenAI` client expects a `/v1`-suffixed base URL; the shared
  // resolver returns a canonical origin without `/v1`, so append it here.
  // `resolveRuntimeBaseUrl` already normalizes the override internally, so we
  // pass the raw input through without an extra normalization pass.
  const origin = resolveRuntimeBaseUrl(runtime, override);
  return buildRuntimeEndpoint(origin, '/v1');
}

function pickApiKey(explicit: string | undefined, config: LocalRuntimeEndpointConfig | undefined) {
  const trimmed = explicit?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  const token = config?.apiToken?.trim();
  if (token && token.length > 0) {
    return token;
  }
  return;
}

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
  model?: string,
  runtime?: Pick<RuntimeData, 'providerOptions'>
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
      // Ollama exposes OpenAI-compatible routes. Defaults to 127.0.0.1:11434
      // but users can override via `runtime.providerOptions.ollama.baseUrl`
      // (to reach a LAN GPU box) and supply an `apiToken` for Ollama Turbo.
      const ollamaOptions = runtime?.providerOptions?.ollama;
      const baseURL = resolveLocalRuntimeBaseUrl('ollama', ollamaOptions?.baseUrl);
      const resolvedKey = pickApiKey(apiKey, ollamaOptions);
      const ollamaProvider = createOpenAI({
        baseURL,
        ...(resolvedKey ? { apiKey: resolvedKey } : {}),
      });
      return ollamaProvider(modelName);
    }

    case 'lmstudio': {
      // LM Studio exposes OpenAI-compatible routes. Defaults to 127.0.0.1:1234
      // and supports an optional bearer token on 0.4.0+ servers that enabled
      // `Require API clients to provide a valid API token` in Settings > Server.
      const lmStudioOptions = runtime?.providerOptions?.lmstudio;
      const baseURL = resolveLocalRuntimeBaseUrl('lmstudio', lmStudioOptions?.baseUrl);
      const resolvedKey = pickApiKey(apiKey, lmStudioOptions);
      const lmStudioProvider = createOpenAI({
        baseURL,
        ...(resolvedKey ? { apiKey: resolvedKey } : {}),
      });
      return lmStudioProvider(modelName);
    }

    case 'local': {
      return createLocalLanguageModel(
        modelName,
        runtime?.providerOptions?.local
      ) as MastraModelConfig;
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
