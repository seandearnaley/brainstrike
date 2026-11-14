import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import { CHATGPT_PLAN_RESOURCE } from '@brainstrike/assistant-contract';
import {
  isSupportedProvider,
  listProviders,
  PROVIDER_DEFAULT_MODELS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import {
  type IdentifiedModelConfig,
  type MastraModelConfig,
  ModelRouterLanguageModel,
  type OpenAICompatibleConfig,
} from '@mastra/core/llm';
import { createMastraAgentError } from '../mastra-boundary/mastra-agent-error.ts';
import { resolveBedrockModelId } from './bedrock-model-id.ts';
import { chatGptPlanModel, chatGptWireModelId } from './chatgpt-plan-model.ts';
import { OpenRouterStrictContentGateway } from './openrouter-strict-content.ts';
import { wrapModelWithDeclaredPromptCaching } from './prompt-caching.ts';
import {
  apiKeyAuthInput,
  assertExactlyOneAwsCredential,
  assertValidProviderAuthInput,
  bearerApiKeyOnly,
  type ProviderAuthInput,
  type ProviderFetchOptions,
  providerFetchOptions,
  requireAccessTokenAuthInput,
  requireAwsAuthInput,
} from './provider-auth-input.ts';

/** The factory's actual public outputs; routers have a distinct stream-shaped generate API. */
export type ProviderModelConfiguration =
  | ReturnType<ReturnType<typeof createOpenAI>>
  | ReturnType<ReturnType<typeof createAnthropic>>
  | ReturnType<ReturnType<typeof createGoogle>>
  | ReturnType<ReturnType<typeof createAmazonBedrock>>
  | LanguageModelV2
  | ModelRouterLanguageModel;

/** Preserve the existing Mastra consumer's vendored SDK declaration boundary. */
function toMastraModelConfiguration(model: ProviderModelConfiguration): MastraModelConfig {
  if (
    'specificationVersion' in model &&
    model.specificationVersion === 'v2' &&
    !(model instanceof ModelRouterLanguageModel)
  ) {
    // Both represent the public V2 model. Mastra vendors an older mutable JSON
    // declaration; the current provider permits readonly JSON. No runtime copy.
    // https://github.com/vercel/ai/tree/main/packages/provider/src/language-model/v2
    // Remove this declaration bridge when the existing Mastra/provider pins agree.
    return model as unknown as Extract<MastraModelConfig, { specificationVersion: 'v2' }>;
  }
  return model;
}

/** A model object; Mastra 1.78's `{ model, id }` label wraps one but is not one. */
export type ConcreteLanguageModel = Exclude<
  MastraModelConfig,
  string | OpenAICompatibleConfig | IdentifiedModelConfig
>;
const PERSISTENT_MEMORY_LANGUAGE_MODEL_PROVIDERS = new Set<SupportedProvider>([
  'openai',
  'anthropic',
  'google',
  'openrouter',
]);

/**
 * Build the AI SDK `create*` settings object from projected auth options,
 * preserving the pre-BST-1352 `apiKey ? { apiKey } : undefined` shape exactly
 * when nothing was projected.
 */
function sdkFactorySettings(options: ProviderFetchOptions): ProviderFetchOptions | undefined {
  if (options.apiKey === undefined) {
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
  model?: string
): ProviderModelConfiguration {
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

    case 'chatgpt': {
      // Sign in with ChatGPT (ADR-0038): the public Responses API, paid by the
      // signed-in account's plan. The SDK asks the host's closure for the
      // token before each request, so a token renewed mid-run is the one sent.
      const { accessToken } = requireAccessTokenAuthInput(auth, validatedProvider);
      // The base URL is pinned: left to the SDK, `OPENAI_BASE_URL` would send
      // the person's ChatGPT token wherever the environment points.
      return chatGptPlanModel(
        createOpenAI({ apiKey: accessToken, baseURL: CHATGPT_PLAN_RESOURCE })(
          chatGptWireModelId(modelName)
        ),
        modelName
      );
    }

    case 'anthropic': {
      const anthropicProvider = createAnthropic(
        sdkFactorySettings(providerFetchOptions(auth, validatedProvider))
      );
      // BST-587: every hosted Anthropic request carries a tail cache breakpoint
      // so multi-step agent runs cache-read the shared prefix. The wrapper
      // composes with every auth kind — the Proxy intercepts
      // doStream/doGenerate regardless of how the model was built.
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
      // seam: descriptor config, so `bearerApiKeyOnly` throws typed on aws
      // instead of silently dropping it.
      const apiKey = bearerApiKeyOnly(auth, validatedProvider);
      // Claude and Alibaba-served Qwen routes need an explicit cache_control
      // on OpenRouter; the registry row's `promptCaching` dialect selects it.
      return wrapModelWithDeclaredPromptCaching(
        validatedProvider,
        modelName,
        new ModelRouterLanguageModel(
          {
            id: `openrouter/${modelName}`,
            ...(apiKey ? { apiKey } : {}),
          },
          [new OpenRouterStrictContentGateway(apiKey)]
        )
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
      // AI SDK factory case (PR #2522 review, finding 9). The
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
  model?: string
): ConcreteLanguageModel {
  if (
    !(isSupportedProvider(provider) && PERSISTENT_MEMORY_LANGUAGE_MODEL_PROVIDERS.has(provider))
  ) {
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      context: { provider },
      detail: `Persistent memory does not support provider: ${provider}`,
    });
  }
  if (!apiKey?.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { provider },
      detail: `Persistent memory provider "${provider}" requires an explicit API key.`,
    });
  }

  // Persistent memory stays on the resolved-string surface; the ONE
  // string→union adapter wraps it for the factory seam (BST-1352).
  const modelConfig = toMastraModelConfiguration(
    createProvider(provider, apiKeyAuthInput(apiKey), model)
  );
  if (isConcreteLanguageModel(modelConfig)) {
    return modelConfig;
  }
  throw createMastraAgentError('mastra_agent_runtime_init_failed', {
    context: { provider },
    detail: `Persistent memory provider "${provider}" did not produce a concrete language model.`,
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
