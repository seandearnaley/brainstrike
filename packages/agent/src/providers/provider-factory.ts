import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { createMastraAgentError } from '../mastra/mastra-agent-error';
import type { RuntimeData } from '../types';
import { createLlmHostChatModel, createLocalLanguageModel } from './local';
import { resolveRuntimeBaseUrl } from './local-runtime-discovery';
import {
  assertSafeBearerToken,
  buildRuntimeEndpoint,
  type LocalRuntimeEndpointConfig,
} from './local-runtime-utils';
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

/**
 * Resolve the bearer token for an OpenAI-compatible local runtime client.
 *
 * Both the explicit `apiKey` argument and the runtime-options `apiToken` are
 * routed through `assertSafeBearerToken` so a token containing CR/LF/NUL is
 * rejected at this boundary rather than flowing into the OpenAI SDK's HTTP
 * client (header-injection hardening — keeps parity with
 * `buildRuntimeAuthHeaders`).
 */
function pickApiKey(
  explicit: string | undefined,
  config: LocalRuntimeEndpointConfig | undefined
): string | undefined {
  if (explicit && explicit.trim().length > 0) {
    return assertSafeBearerToken(explicit);
  }
  const token = config?.apiToken;
  if (token && token.trim().length > 0) {
    return assertSafeBearerToken(token);
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
  runtime?: Pick<RuntimeData, 'localLlmHostClient' | 'providerOptions'>
): MastraModelConfig {
  const supportedProviders = listProviders().map(
    (entry) => entry.id
  ) as readonly SupportedProvider[];
  if (!isSupportedProvider(provider)) {
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      context: { provider, supportedProviders },
      detail: `Unsupported provider: ${provider}`,
    });
  }

  const validatedProvider = provider;
  const modelName = model ?? PROVIDER_DEFAULT_MODELS[validatedProvider];
  if (!modelName) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { provider },
      detail: `No default model configured for provider: ${provider}`,
    });
  }

  switch (validatedProvider) {
    case 'openai': {
      // INVARIANT: the default `openaiProvider(modelName)` callable routes to the
      // Responses API (`/v1/responses`). `createProviderNativeWebSearchTool` in
      // native-web-search.ts builds `openai.tools.webSearch()` from an
      // INDEPENDENT `createOpenAI()` instance (decoupled from this factory) and
      // silently assumes that same Responses surface. If this case is ever
      // repointed at `.chat(modelName)` (chat-completions) or an
      // OpenAI-compatible base URL, the native web-search tool must move with
      // it — see the matching invariant comment in native-web-search.ts.
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
      //
      // Always pass an explicit `apiKey`. When the user has not configured a
      // token we substitute the conventional dummy value `'ollama'` so the
      // OpenAI SDK does NOT fall back to `process.env.OPENAI_API_KEY`. Without
      // this substitution a user with `OPENAI_API_KEY` set in their
      // environment and a remote `baseUrl` (LAN GPU box, tunnel, etc.) would
      // silently leak their OpenAI key as a `Bearer` header to that remote
      // host. Ollama and LM Studio ignore the bearer value when auth is
      // disabled, so the dummy is harmless on the wire.
      const ollamaOptions = runtime?.providerOptions?.ollama;
      const baseURL = resolveLocalRuntimeBaseUrl('ollama', ollamaOptions?.baseUrl);
      const resolvedKey = pickApiKey(apiKey, ollamaOptions);
      const ollamaProvider = createOpenAI({
        apiKey: resolvedKey ?? 'ollama',
        baseURL,
      });
      return ollamaProvider(modelName);
    }

    case 'lmstudio': {
      // LM Studio exposes OpenAI-compatible routes. Defaults to 127.0.0.1:1234
      // and supports an optional bearer token on 0.4.0+ servers that enabled
      // `Require API clients to provide a valid API token` in Settings > Server.
      //
      // See the `ollama` case above for why we always pass an explicit
      // `apiKey` (preventing OPENAI_API_KEY env-var leakage to remote hosts).
      const lmStudioOptions = runtime?.providerOptions?.lmstudio;
      const baseURL = resolveLocalRuntimeBaseUrl('lmstudio', lmStudioOptions?.baseUrl);
      const resolvedKey = pickApiKey(apiKey, lmStudioOptions);
      const lmStudioProvider = createOpenAI({
        apiKey: resolvedKey ?? 'lmstudio',
        baseURL,
      });
      return lmStudioProvider(modelName);
    }

    case 'local': {
      // Host-injected client (desktop main): proxy generation to the hidden
      // llm-host renderer. Without a client (web/browser renderer), run the
      // in-process backend — that path requires a browser environment.
      const hostClient = runtime?.localLlmHostClient;
      if (hostClient) {
        return createLlmHostChatModel(
          modelName,
          hostClient,
          runtime?.providerOptions?.local
        ) as MastraModelConfig;
      }
      return createLocalLanguageModel(
        modelName,
        runtime?.providerOptions?.local
      ) as MastraModelConfig;
    }

    default:
      throw createMastraAgentError('mastra_agent_unsupported_provider', {
        context: { provider, supportedProviders },
        detail: `Unsupported provider: ${provider}`,
      });
  }
}

/**
 * Create a hosted embedding model instance for Mastra semantic recall.
 *
 * Local/browser embedders are intentionally excluded here: desktop local
 * embeddings must stay in the renderer host, while this factory runs in the
 * hosted Mastra memory path.
 */
export function createEmbeddingProvider(
  provider: SupportedProvider | string,
  apiKey: string | undefined,
  model: string
): MastraEmbeddingModel<string> {
  const supportedProviders = listProviders().map(
    (entry) => entry.id
  ) as readonly SupportedProvider[];
  if (!isSupportedProvider(provider)) {
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      context: { provider, supportedProviders },
      detail: `Unsupported embedding provider: ${provider}`,
    });
  }

  switch (provider) {
    case 'openai': {
      const openaiProvider = createOpenAI(apiKey ? { apiKey } : undefined);
      // @ai-sdk/provider@4.x's EmbeddingModelV4 is not yet in @mastra/core's
      // MastraEmbeddingModel union (which caps at EmbeddingModelV2|V3 as of
      // 1.49.0 -- Mastra's AI SDK v7/V4 support, PR #18477, only covers
      // language models). V3 and V4 are structurally identical apart from
      // the `specificationVersion` literal ('v3' vs 'v4'), so this cast is
      // safe pending an upstream Mastra embedding-model update. See
      // docs/dependency-updates-breaking-changes.md.
      return openaiProvider.embeddingModel(model) as unknown as MastraEmbeddingModel<string>;
    }

    case 'google': {
      const googleProvider = createGoogleGenerativeAI(apiKey ? { apiKey } : undefined);
      // Same upstream gap as the openai branch above.
      return googleProvider.embeddingModel(model) as unknown as MastraEmbeddingModel<string>;
    }

    case 'anthropic':
    case 'openrouter':
    case 'cohere':
    case 'voyage':
    case 'ollama':
    case 'lmstudio':
    case 'local':
      throw createMastraAgentError('mastra_agent_unsupported_provider', {
        context: { provider, supportedProviders },
        detail: `Mastra semantic recall embedder is not supported for provider: ${provider}`,
      });

    default:
      throw createMastraAgentError('mastra_agent_unsupported_provider', {
        context: { provider, supportedProviders },
        detail: `Unsupported embedding provider: ${provider}`,
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
