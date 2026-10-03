import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  assertSafeBearerToken,
  buildRuntimeEndpoint,
  type LocalRuntimeEndpointConfig,
  resolveRuntimeBaseUrl,
} from '@brainstrike/local-runtime';
import {
  type MastraModelConfig,
  ModelRouterLanguageModel,
  type OpenAICompatibleConfig,
} from '@mastra/core/llm';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { createMastraAgentError } from '../mastra/mastra-agent-error';
import type { RuntimeData } from '../types';
import { resolveBedrockModelId } from './bedrock-model-id';
import { resolveCodexModelId } from './codex-model-id';
import { createLlmHostChatModel } from './local/llm-host-chat-model';
import type { LocalLanguageModelSettings } from './local/local-language-model';
import { OpenRouterStrictContentGateway } from './openrouter-strict-content';
import { wrapModelWithDeclaredPromptCaching } from './prompt-caching';
import { wrapModelWithCallTransform } from './prompt-transform-proxy';
import {
  apiKeyAuthInput,
  assertExactlyOneAwsCredential,
  assertValidProviderAuthInput,
  bearerApiKeyOnly,
  type ProviderAuthInput,
  type ProviderFetchOptions,
  providerFetchOptions,
  requireAwsAuthInput,
  requireCustomFetchAuthInput,
} from './provider-auth-input';
import {
  isSupportedProvider,
  listProviders,
  PROVIDER_DEFAULT_MODELS,
  providerAuthType,
  type SupportedProvider,
} from './types';

export type LocalLanguageModelFactory = (
  modelId: string,
  settings?: LocalLanguageModelSettings
) => unknown;

let localLanguageModelFactory: LocalLanguageModelFactory | undefined;

export type ConcreteLanguageModel = Exclude<MastraModelConfig, string | OpenAICompatibleConfig>;
const PERSISTENT_MEMORY_LANGUAGE_MODEL_PROVIDERS = new Set<SupportedProvider>([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'local',
]);

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
 * Build the AI SDK `create*` settings object from projected auth options,
 * preserving the pre-BST-1352 `apiKey ? { apiKey } : undefined` shape exactly
 * when nothing was projected.
 */
function sdkFactorySettings(options: ProviderFetchOptions): ProviderFetchOptions | undefined {
  if (options.apiKey === undefined && options.fetch === undefined) {
    return;
  }
  return options;
}

/** Error-context helper: only computed when a throw actually happens (E4). */
function listSupportedProviderIds(): readonly SupportedProvider[] {
  return listProviders().map((entry) => entry.id) as readonly SupportedProvider[];
}

/**
 * Create a language model instance for the specified provider
 *
 * @param provider - The AI provider to use
 * @param auth - Optional auth input (BST-1352 union; `api_key` matches the old
 *   string parameter — SDK-side environment variables apply when omitted)
 * @param model - Optional model name (uses provider-specific default if not provided)
 * @returns A language model instance configured for the provider
 * @throws Error if the provider is not supported or the auth input is invalid
 */
export function createProvider(
  provider: SupportedProvider | string,
  auth?: ProviderAuthInput,
  model?: string,
  runtime?: Pick<RuntimeData, 'localLlmHostClient' | 'providerOptions'>
): MastraModelConfig {
  // Shape validation (aws region) happens BEFORE provider dispatch so a
  // malformed input fails identically on every provider case.
  assertValidProviderAuthInput(auth);
  if (!isSupportedProvider(provider)) {
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      context: { provider, supportedProviders: listSupportedProviderIds() },
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
      const openaiProvider = createOpenAI(
        sdkFactorySettings(providerFetchOptions(auth, validatedProvider))
      );
      return openaiProvider(modelName);
    }

    case 'openai-codex': {
      // BST-1356 (legal gate BST-1351). Same OpenAI Responses SDK surface as
      // the `openai` case above, but EVERY byte of authentication lives in the
      // injected fetch closure: it strips the SDK's dummy authorization,
      // attaches the subscription bearer from the desktop provider-auth
      // engine, and rewrites the request onto OpenAI's Codex backend.
      //
      // The narrow is load-bearing, not defensive: without it an `api_key`
      // input would reach `createOpenAI` and quietly bill the user's METERED
      // platform account for traffic they asked to draw on their subscription.
      const codexAuth = requireCustomFetchAuthInput(auth, validatedProvider);
      const codexProvider = createOpenAI(
        sdkFactorySettings(providerFetchOptions(codexAuth, validatedProvider))
      );
      // Catalog ids are `codex/`-prefixed (the models table's id is a global
      // primary key); the Codex backend wants the bare id.
      //
      // BST-1918: `store` must be false BEFORE the SDK serializes the request.
      // The codex-fetch rewrite to `store:false` runs after serialization, too
      // late: the SDK has already built `item_reference`s for earlier reasoning
      // that OpenAI never stored and left out its encrypted content. With
      // `store:false` set here the SDK sends reasoning inline and adds
      // `include: ['reasoning.encrypted_content']` itself.
      return wrapModelWithCallTransform(
        codexProvider(resolveCodexModelId(modelName)),
        (params) => ({
          ...params,
          providerOptions: {
            ...params.providerOptions,
            openai: { ...params.providerOptions?.['openai'], store: false },
          },
        })
      );
    }

    case 'anthropic': {
      const anthropicProvider = createAnthropic(
        sdkFactorySettings(providerFetchOptions(auth, validatedProvider))
      );
      // BST-587: every hosted Anthropic request carries a tail cache breakpoint
      // so multi-step agent runs cache-read the shared prefix. The wrapper
      // composes with EVERY auth kind, custom_fetch included — the Proxy
      // intercepts doStream/doGenerate regardless of how the model was built.
      // BST-1354 made the SELECTION registry-driven; every Anthropic model row
      // declares `promptCaching: 'anthropic'`, so behavior here is unchanged.
      return wrapModelWithDeclaredPromptCaching(
        validatedProvider,
        modelName,
        anthropicProvider(modelName)
      );
    }

    case 'google': {
      const googleProvider = createGoogle(
        sdkFactorySettings(providerFetchOptions(auth, validatedProvider))
      );
      return googleProvider(modelName);
    }

    case 'openrouter': {
      // Route through Mastra's official OpenRouter model-router provider. Its
      // stream schema preserves OpenRouter's providerMetadata (including exact
      // billed cost); the generic OpenAI-compatible client discards that data.
      //
      // Constructed here (not left as a bare descriptor for Mastra to
      // materialize) so model resolution goes through the strict-content
      // gateway: replayed assistant turns that carry only tool calls
      // serialize as `content: null`, which Alibaba-hosted qwen/* models
      // reject with a 400 — see openrouter-strict-content.ts.
      // Constructed per call so the request's already-resolved credential
      // (BRAINSTRIKE_* override, vendor env name, or stored keychain key) is
      // threaded into the gateway's getApiKey — never re-derived from a
      // hardcoded env read (BST-1361). The key comes off the BST-1352 auth
      // seam: descriptor config, no fetch seam, so `bearerApiKeyOnly` throws
      // typed on custom_fetch/aws instead of silently dropping them.
      const apiKey = bearerApiKeyOnly(auth, validatedProvider);
      return new ModelRouterLanguageModel(
        {
          id: `openrouter/${modelName}`,
          ...(apiKey ? { apiKey } : {}),
        },
        [new OpenRouterStrictContentGateway(apiKey)]
      );
    }

    case 'bedrock': {
      // The aws auth input is REQUIRED — a bearer key alone (api_key kind) or
      // absent auth carries no region, and region is mandatory (typed
      // failure, never a silent default).
      const awsAuth = requireAwsAuthInput(auth, validatedProvider);
      // EXACTLY ONE credential form, bearer (BST-1350) or credential chain
      // (BST-1353) — with neither, the AI SDK signs with AMBIENT env
      // credentials, i.e. an identity the user never chose.
      //
      // REDUNDANT BY DESIGN, and measured to be so: `createProvider` always
      // runs `assertValidProviderAuthInput` first, so removing EITHER call
      // alone breaks no test (verified by mutation during the #2524 rebase);
      // only removing BOTH does. Kept as a local invariant at the single
      // point of use, because this is the line where a missing credential
      // becomes a silently mis-signed AWS request. Do not delete it as "dead
      // code" — the pre-dispatch validator is generic over the whole union,
      // this one is the Bedrock case's own contract.
      assertExactlyOneAwsCredential(awsAuth);
      // SDK settings ride the SAME providerFetchOptions seam as every other
      // AI SDK factory case (PR #2522 review, finding 9) — a future
      // fetch-carrying auth kind composes without a bespoke branch here. The
      // credential provider is added beside it (it is Bedrock-only, so it
      // stays out of the generic projection); the AI SDK prefers `apiKey`
      // over `credentialProvider` when both are set, which is precisely why
      // the XOR above is enforced instead of relied upon.
      const bedrockProvider = createAmazonBedrock({
        ...providerFetchOptions(awsAuth, validatedProvider),
        ...(awsAuth.credentialProvider === undefined
          ? {}
          : { credentialProvider: awsAuth.credentialProvider }),
        region: awsAuth.region,
      });
      // The catalog stores UNPREFIXED Bedrock model ids; the cross-region
      // inference-profile prefix is a per-request routing concern derived
      // from the request's region (see bedrock-model-id.ts).
      //
      // BST-1354: capability lookup uses the UNPREFIXED catalog id, while the
      // SDK model is built from the ROUTED id — the prefix selects a
      // cross-region profile, it does not change what the model supports.
      return wrapModelWithDeclaredPromptCaching(
        validatedProvider,
        modelName,
        bedrockProvider(resolveBedrockModelId(modelName, awsAuth.region))
      );
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
      const resolvedKey = pickApiKey(bearerApiKeyOnly(auth, validatedProvider), ollamaOptions);
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
      const resolvedKey = pickApiKey(bearerApiKeyOnly(auth, validatedProvider), lmStudioOptions);
      return {
        apiKey: resolvedKey ?? 'lmstudio',
        id: `lmstudio/${modelName}`,
        url,
      };
    }

    case 'local': {
      // The built-in local model never consumes a bearer key; the narrow runs
      // (and its result is discarded) so custom_fetch/aws still fail typed
      // instead of being silently ignored on this keyless case.
      bearerApiKeyOnly(auth, validatedProvider);
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
        context: { provider, supportedProviders: listSupportedProviderIds() },
        detail: `Unsupported provider: ${provider}`,
      });
  }
}

/**
 * Resolve any supported provider configuration into a concrete language model.
 *
 * Mastra's agent runtime accepts model-router descriptors, but persistent
 * memory must never receive one: a descriptor can defer credential lookup back
 * to Mastra instead of using Brainstrike's explicit env/keychain resolution.
 */
export function createLanguageModelProvider(
  provider: SupportedProvider | string,
  apiKey?: string,
  model?: string,
  runtime?: Pick<RuntimeData, 'localLlmHostClient' | 'providerOptions'>
): ConcreteLanguageModel {
  if (
    !(isSupportedProvider(provider) && PERSISTENT_MEMORY_LANGUAGE_MODEL_PROVIDERS.has(provider))
  ) {
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      context: { provider },
      detail: `Persistent memory does not support provider: ${provider}`,
    });
  }
  // Registry-derived (PR #2513 review, finding 7): within the persistent-
  // memory allowlist above, `local` is the only `authType: 'none'` member
  // (ollama/lmstudio are excluded from persistent memory entirely), so this
  // is behavior-identical to the previous `provider !== 'local'` check.
  if (providerAuthType(provider) !== 'none' && !apiKey?.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { provider },
      detail: `Persistent memory provider "${provider}" requires an explicit API key.`,
    });
  }

  // Persistent memory stays on the resolved-string surface; the ONE
  // string→union adapter wraps it for the factory seam (BST-1352).
  const modelConfig = createProvider(provider, apiKeyAuthInput(apiKey), model, runtime);
  if (isConcreteLanguageModel(modelConfig)) {
    return modelConfig;
  }
  if (isOpenAICompatibleConfig(modelConfig)) {
    return new ModelRouterLanguageModel(modelConfig);
  }
  throw createMastraAgentError('mastra_agent_runtime_init_failed', {
    context: { provider },
    detail: `Persistent memory provider "${provider}" did not produce a concrete language model or an explicit router configuration.`,
  });
}

function isConcreteLanguageModel(
  modelConfig: MastraModelConfig
): modelConfig is ConcreteLanguageModel {
  return (
    typeof modelConfig === 'object' &&
    modelConfig !== null &&
    'doGenerate' in modelConfig &&
    'doStream' in modelConfig
  );
}

function isOpenAICompatibleConfig(
  modelConfig: MastraModelConfig
): modelConfig is OpenAICompatibleConfig {
  return (
    typeof modelConfig === 'object' &&
    modelConfig !== null &&
    'id' in modelConfig &&
    typeof modelConfig.id === 'string'
  );
}

/**
 * Present a current @ai-sdk embedding model (specification 'v4') as spec 'v3'
 * for Mastra memory. V3 and V4 are structurally identical apart from the
 * `specificationVersion` literal, but the literal is LOAD-BEARING inside
 * @mastra/memory: its embed dispatch switches on it ('v3' → embedMany3,
 * 'v2' → embedMany2, anything else → a legacy v1-only pipeline that throws
 * "AI SDK 4 only supports … v1"). A raw 'v4' model therefore fails every
 * observational-memory VECTOR retrieval cycle and semantic-recall embed
 * (BST-940 field failure, debug bundle 2026-07-27). Same facade technique
 * @mastra/memory itself uses internally (`asEmbeddingModelV3`).
 */
function asSpecV3EmbeddingModel(model: unknown): MastraEmbeddingModel<string> {
  return new Proxy(model as object, {
    get(target, prop) {
      if (prop === 'specificationVersion') {
        return 'v3';
      }
      // Bind methods (and run getters) against the TARGET, not the proxy:
      // an embedding model whose method reads `this.#private` or checks its
      // own identity must never observe the facade as `this`.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as MastraEmbeddingModel<string>;
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
  if (!isSupportedProvider(provider)) {
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      context: { provider, supportedProviders: listSupportedProviderIds() },
      detail: `Unsupported embedding provider: ${provider}`,
    });
  }

  switch (provider) {
    case 'openai': {
      const openaiProvider = createOpenAI(apiKey ? { apiKey } : undefined);
      return asSpecV3EmbeddingModel(openaiProvider.embeddingModel(model));
    }

    case 'google': {
      const googleProvider = createGoogle(apiKey ? { apiKey } : undefined);
      return asSpecV3EmbeddingModel(googleProvider.embeddingModel(model));
    }

    case 'anthropic':
    case 'openrouter':
    case 'cohere':
    case 'voyage':
    // Bedrock exposes embedding models upstream, but Brainstrike's Bedrock
    // phase 1 is LLM-only (registry capabilities.embeddings: false) — an
    // explicit throw, never a silent degrade (BST-1350).
    case 'bedrock':
    // The ChatGPT subscription grants no embeddings endpoint (registry
    // capabilities.embeddings: false) — explicit throw, never a silent
    // degrade to the metered platform API (BST-1356).
    case 'openai-codex':
    case 'ollama':
    case 'lmstudio':
    case 'local':
      throw createMastraAgentError('mastra_agent_unsupported_provider', {
        context: { provider, supportedProviders: listSupportedProviderIds() },
        detail: `Mastra semantic recall embedder is not supported for provider: ${provider}`,
      });

    default:
      throw createMastraAgentError('mastra_agent_unsupported_provider', {
        context: { provider, supportedProviders: listSupportedProviderIds() },
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
