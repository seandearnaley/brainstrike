import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { createMastraAgentError } from '../mastra/mastra-agent-error';
import type { RuntimeData } from '../types';
import { wrapAnthropicModelWithPromptCaching } from './anthropic-prompt-caching';
import { createLlmHostChatModel } from './local/llm-host-chat-model';
import type { LocalLanguageModelSettings } from './local/local-language-model';
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

export type LocalLanguageModelFactory = (
  modelId: string,
  settings?: LocalLanguageModelSettings
) => unknown;

let localLanguageModelFactory: LocalLanguageModelFactory | undefined;

/**
 * Register the browser-only Transformers model factory.
 *
 * The root `@brainstrike/agent` entrypoint performs this registration. Narrow
 * server entrypoints deliberately do not, so importing the hosted runtime can
 * never pull Hugging Face/ONNX packages into a Node function trace.
 */
export function registerLocalLanguageModelFactory(factory: LocalLanguageModelFactory): void {
  localLanguageModelFactory = factory;
}

function resolveLocalRuntimeBaseUrl(
  runtime: 'ollama' | 'lmstudio',
  override: string | undefined
): string {
  // Mastra's OpenAI-compatible model config expects a `/v1`-suffixed URL; the
  // shared resolver returns a canonical origin without `/v1`, so append it here.
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
 * rejected at this boundary rather than flowing into Mastra's compatible HTTP
 * adapter (header-injection hardening — keeps parity with
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
      // BST-587: every hosted Anthropic request carries a tail cache breakpoint
      // so multi-step agent runs cache-read the shared prefix.
      return wrapAnthropicModelWithPromptCaching(anthropicProvider(modelName));
    }

    case 'google': {
      const googleProvider = createGoogleGenerativeAI(apiKey ? { apiKey } : undefined);
      return googleProvider(modelName);
    }

    case 'openrouter': {
      // Route through Mastra's official OpenRouter model-router provider. Its
      // stream schema preserves OpenRouter's providerMetadata (including exact
      // billed cost); the generic OpenAI-compatible client discards that data.
      return {
        id: `openrouter/${modelName}`,
        ...(apiKey ? { apiKey } : {}),
      };
    }

    case 'ollama': {
      // Ollama exposes OpenAI-compatible routes. Defaults to 127.0.0.1:11434
      // but users can override via `runtime.providerOptions.ollama.baseUrl`
      // (to reach a LAN GPU box) and supply an `apiToken` for Ollama Turbo.
      //
      // Always pass an explicit `apiKey`. When the user has not configured a
      // token we substitute the conventional dummy value `'ollama'` so the
      // compatible adapter does NOT fall back to `process.env.OPENAI_API_KEY`. Without
      // this substitution a user with `OPENAI_API_KEY` set in their
      // environment and a remote `baseUrl` (LAN GPU box, tunnel, etc.) would
      // silently leak their OpenAI key as a `Bearer` header to that remote
      // host. Ollama and LM Studio ignore the bearer value when auth is
      // disabled, so the dummy is harmless on the wire.
      const ollamaOptions = runtime?.providerOptions?.ollama;
      const url = resolveLocalRuntimeBaseUrl('ollama', ollamaOptions?.baseUrl);
      const resolvedKey = pickApiKey(apiKey, ollamaOptions);
      return {
        apiKey: resolvedKey ?? 'ollama',
        id: `ollama/${modelName}`,
        url,
      };
    }

    case 'lmstudio': {
      // LM Studio exposes OpenAI-compatible routes. Defaults to 127.0.0.1:1234
      // and supports an optional bearer token on 0.4.0+ servers that enabled
      // `Require API clients to provide a valid API token` in Settings > Server.
      //
      // See the `ollama` case above for why we always pass an explicit
      // `apiKey` (preventing OPENAI_API_KEY env-var leakage to remote hosts).
      const lmStudioOptions = runtime?.providerOptions?.lmstudio;
      const url = resolveLocalRuntimeBaseUrl('lmstudio', lmStudioOptions?.baseUrl);
      const resolvedKey = pickApiKey(apiKey, lmStudioOptions);
      return {
        apiKey: resolvedKey ?? 'lmstudio',
        id: `lmstudio/${modelName}`,
        url,
      };
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
      if (!localLanguageModelFactory) {
        throw createMastraAgentError('mastra_agent_runtime_init_failed', {
          context: { model: modelName, provider: validatedProvider },
          detail:
            'The in-process local model factory is unavailable from this agent entrypoint. Import the root @brainstrike/agent entrypoint before selecting the local provider.',
        });
      }
      return localLanguageModelFactory(
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
  if (!isSupportedProvider(provider)) {
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      context: { provider, supportedProviders: listProviders().map((entry) => entry.id) },
      detail: `Unsupported provider: ${provider}`,
    });
  }
  return PROVIDER_DEFAULT_MODELS[provider] ?? '';
}
