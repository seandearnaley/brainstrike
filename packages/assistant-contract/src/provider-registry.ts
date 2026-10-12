import providerCatalog from './provider-catalog.json' with { type: 'json' };
import { parseProviderCatalog } from './provider-catalog-schema.js';
import type { AnthropicEffort, OpenAiReasoningEffort } from './runtime-data.js';

export const STANDARD_EMBEDDING_DIMENSION = 768;

export type ProviderRuntime = 'hosted' | 'gateway' | 'local' | 'browser';

export type ProviderModelType = 'llm' | 'embedding';

export interface ProviderCapabilities {
  embeddings: boolean;
  llm: boolean;
  streaming: boolean;
}

/**
 * Whether a model accepts image (vision) input parts. Drives the composer
 * attachment gate and the picker model metadata. 'unknown' is RESERVED for
 * dynamically discovered local-runtime models whose endpoint reports no
 * capability signal — statically registered models must commit to
 * 'supported' or 'unsupported' (pinned by provider-registry-vision.test.ts)
 * so the attachment gate never guesses.
 */
export type ModelVisionSupport = 'supported' | 'unsupported' | 'unknown';
export type ModelModality = 'audio' | 'image' | 'text' | 'video';

/**
 * Provider-native deferred-tool search capability declared by the exact model
 * route. Gateway aliases do not inherit this from the underlying vendor.
 */
export type NativeToolSearchCapability = 'anthropic' | 'openai';

export type TokenizerEncoding = 'o200k_base';

export type TokenMeasurementCapability =
  | {
      /**
       * The selected provider/model pair has an explicit local tokenizer
       * implementation whose model mapping is verified.
       */
      mode: 'exact-selected-model';
      tokenizer: TokenizerEncoding;
    }
  | {
      /**
       * A deliberately declared reference encoding. Useful for directional
       * measurement, but never represented as the selected model's exact count.
       */
      mode: 'declared-compatible-reference';
      tokenizer: TokenizerEncoding;
    }
  | {
      /**
       * Always-available deterministic measurement and the independent safety
       * envelope. This is selected for every undeclared provider/model pair.
       */
      charactersPerToken: 4;
      mode: 'deterministic-serialized-character-backstop';
    };

type TokenizerBackedMeasurementCapability = Exclude<
  TokenMeasurementCapability,
  { mode: 'deterministic-serialized-character-backstop' }
>;

interface BaseModelDefinition {
  /**
   * Flag a sensible default for the given model type.
   */
  default?: boolean;
  /**
   * Provider-specific model identifier (as accepted by the upstream API).
   */
  id: string;
  /**
   * Optional human-friendly label when the upstream ID is cryptic.
   */
  label?: string;
}

export interface LlmModelDefinition extends BaseModelDefinition {
  /**
   * Direct Anthropic's vendor-documented OFFERED effort ladder. Recorded per
   * model, never derived from the SDK enum or the model name. Absence is
   * authoritative: no effort parameter, while legacy budget thinking remains
   * available. Kept separate from the OpenAI-vocabulary `reasoning` block.
   */
  anthropicReasoning?: {
    readonly defaultEffort: AnthropicEffort;
    /**
     * Whether thinking has no off state on this row (BST-1706): the vendor
     * rejects `thinking.type: 'disabled'`, so only the effort is
     * configurable. Mirrors the required `mandatory` on the OpenAI-vocabulary
     * `reasoning` block.
     */
    readonly mandatory: boolean;
    readonly supportedEfforts: readonly AnthropicEffort[];
  };
  /**
   * Bedrock-only: which `providerOptions.bedrock.reasoningConfig` dialect this
   * route accepts. Absence is authoritative — the route exposes no reasoning
   * controls. Declared per model rather than derived, because the dialects do
   * not follow vendor lines and sending the wrong one is a hard 400:
   *
   * - `adaptive` — `{type:'adaptive', maxReasoningEffort, display}`. Required
   *   by the newer Claude routes, which REJECT `thinking.type:'enabled'`.
   * - `budget-tokens` — legacy `{type:'enabled', budgetTokens}` extended
   *   thinking, for Claude routes without adaptive support.
   * - `max-reasoning-effort` — `{type:'enabled', maxReasoningEffort}`, the
   *   Amazon Nova extended-thinking shape (no token budget exists there).
   *
   * Pinned by `bedrock-reasoning-dialect-contract.spec.ts` against
   * `getModelCapabilities()` from **`@ai-sdk/anthropic/internal`** — that is
   * the real source of truth; `@ai-sdk/amazon-bedrock` imports the same table
   * rather than owning one. So an **`@ai-sdk/anthropic`** bump can move a
   * route between dialects even when the Bedrock package is untouched; the pin
   * fails a test instead of failing in production. The pin also asserts
   * `isKnownModel`, because that table DEFAULTS an unrecognized id to
   * adaptive — without the assertion a typo'd id would pass silently.
   */
  bedrockReasoning?: 'adaptive' | 'budget-tokens' | 'max-reasoning-effort';
  /**
   * Total context window in tokens (input + output). REQUIRED: adding a model
   * without it is a compile error — this drives the thread context meter and
   * the auto-derived agent input token budget. Use the provider's documented
   * standard tier (not beta/extended tiers).
   */
  contextWindow: number;
  /** Exact documented input modalities when the route publishes them. */
  inputModalities?: readonly ModelModality[];
  /**
   * Provider's documented maximum output tokens, when known. Used to reserve
   * output headroom in the input-budget derivation.
   */
  maxOutputTokens?: number;
  /**
   * Provider-native tool-search protocol supported by this exact model route.
   * Absence is authoritative: callers may choose a declared non-native adapter,
   * but must never infer native support from the provider name.
   */
  nativeToolSearch?: NativeToolSearchCapability;
  /** Exact documented output modalities when the route publishes them. */
  outputModalities?: readonly ModelModality[];
  /**
   * Approx. USD price per 1,000,000 tokens. Static display estimate only; provider-reported
   * billed cost remains authoritative. Omit when pricing is unknown or when a local/keyless
   * model has no billing surface. Explicit zeroes are permitted only when current provider
   * evidence supports a reviewed free hosted route; they stay distinct from "cost unavailable."
   */
  pricing?: {
    /** Published USD per 1M cache-read tokens, including automatic provider caching. */
    cacheReadPerMTok?: number;
    /** Published USD per 1M cache-write tokens; absence means the rate is unknown. */
    cacheWritePerMTok?: number;
    inputPerMTok: number;
    /**
     * Gateway long-context surcharge bands (BST-1708): upstream
     * `pricing.overrides` entries keyed by `min_prompt_tokens`, recorded
     * per-MTok. `computeCost` applies the highest tier at or below the
     * request's total input tokens; cache classes use a tier's cache rates
     * when declared, else the base rates above.
     */
    longContextTiers?: readonly {
      readonly minPromptTokens: number;
      readonly inputPerMTok: number;
      readonly outputPerMTok: number;
      readonly cacheReadPerMTok?: number;
      readonly cacheWritePerMTok?: number;
    }[];
    outputPerMTok: number;
  };
  /**
   * Prompt-cache breakpoint DIALECT this exact route accepts, and the sole
   * input to prompt-caching wrapper selection in the provider factory
   * (`packages/agent/src/providers/prompt-caching.ts`). Absence is
   * authoritative: a route that does not declare a dialect is sent no cache
   * breakpoints at all. NEVER infer the dialect from a provider name or a
   * model-id substring — the Bedrock catalog is heterogeneous (Claude and
   * Nova accept `bedrock` cache points; Llama and DeepSeek accept none).
   *
   * - `anthropic` — first-party Messages API `cache_control: {type:'ephemeral'}`.
   * - `bedrock` — Converse API `cachePoint: {type:'default'}`.
   */
  promptCaching?: 'anthropic' | 'bedrock';
  /**
   * Authoritative per-model reasoning controls when the provider publishes
   * them. The UI and request boundary both enforce these values so a
   * provider-wide saved setting cannot become an invalid model request.
   */
  reasoning?: {
    /**
     * Effort the zero-configuration Auto profile sends, when it must differ
     * from `defaultEffort`. Recorded per model rather than derived — see
     * `resolveOpenRouterAutoRuntimeProfile`. `'none'` switches Auto reasoning
     * off deliberately and visibly.
     */
    autoEffort?: OpenAiReasoningEffort;
    defaultEffort?: OpenAiReasoningEffort;
    defaultEnabled?: boolean;
    mandatory: boolean;
    supportedEfforts: readonly OpenAiReasoningEffort[];
    /**
     * Vendor-documented completion window sized for thinking + answer, for
     * models whose reasoning tokens stream into the output budget. Recorded
     * from the vendor's official docs (cite them at the model entry) — never
     * derived, and catalog-only: OpenRouter does not publish it, so it must
     * survive live-metadata merges (`mergeOpenRouterAutoProfileModel`). Used
     * in place of the coding output ceiling whenever reasoning is active —
     * see `resolveOpenRouterOutputWindow` (BST-1170).
     */
    vendorDefaultOutputTokens?: number;
  };
  /**
   * Some providers restrict streaming; surface this so the UI can badge support.
   */
  supportsStreaming?: boolean;
  /**
   * Curated one-line marketing copy for the composer model menu (e.g. "Best
   * mix of smarts and speed"). REGISTRY-ONLY composer copy source — the DB
   * model-catalog tagline column feeds the db-explorer, not this menu. Omit
   * rather than invent copy: a model without a tagline renders name-only.
   */
  tagline?: string;
  /**
   * Optional explicit local tokenizer declaration. Absence is meaningful: the
   * runtime uses the deterministic serialized-character backstop and never
   * guesses from a model-name substring.
   */
  tokenMeasurement?: TokenizerBackedMeasurementCapability;
  type: 'llm';
  /**
   * Image-input support. REQUIRED: adding a model without it is a compile
   * error — this gates the composer attachment affordance per selected model.
   * Declare the capability of the route actually used (e.g. a gateway route
   * mirrors its underlying model).
   */
  vision: ModelVisionSupport;
}

export interface EmbeddingModelDefinition extends BaseModelDefinition {
  /**
   * Known discrete dimensions offered by this model (if fixed).
   */
  availableDimensions?: readonly number[];
  /**
   * Canonical output dimensionality when no overrides are supplied.
   */
  defaultDimension: number;
  /**
   * Name of the parameter used to tune embedding dimension. Used by workers.
   */
  dimensionParameter?: 'dimensions' | 'output_dimensionality' | 'output_dimension';
  /**
   * Indicates whether the provider exposes a parameter to customise the dimension.
   */
  supportsCustomDimensions?: boolean;
  /**
   * Whether the model can natively (or via parameterisation) produce the project
   * standard 768 dimensional vectors.
   */
  supportsStandardDimension: boolean;
  type: 'embedding';
}

export type ProviderModelDefinition = LlmModelDefinition | EmbeddingModelDefinition;

/**
 * How a provider authenticates. `'none'` marks the keyless local runtimes
 * (their optional bearer token is a transport concern, not an authType).
 * `'oauth_subscription'` is carried by `openai-codex` (BST-1356, ChatGPT
 * subscription sign-in) and `'aws'` by `bedrock` (BST-1350).
 * Keyless-ness DERIVES from `authType === 'none'` — never hand-listed.
 */
export type ProviderAuthType = 'api_key' | 'oauth_subscription' | 'aws' | 'none';

export interface ProviderDefinition {
  authType: ProviderAuthType;
  capabilities: ProviderCapabilities;
  /**
   * Historical env names this provider once resolved (BST-1361). NEVER
   * consulted for authentication. They remain in the desktop `.env`
   * allow-list (an unrecognized name rejects the WHOLE file, so removal
   * would brick existing user files) and in the child-env credential
   * scrubber forever (a credential-shaped var must never leak to children).
   * When set, they surface a visible rename warning via
   * `detectDeprecatedProviderEnvVars`.
   */
  deprecatedEnvKeys?: readonly string[];
  displayName: string;
  /**
   * The provider's "get an API key" page. Required in practice for
   * `api_key` providers (pinned by provider-registry-auth.test.ts).
   */
  docsUrl?: string;
  /**
   * Environment variable keys (most preferred first) for secret discovery.
   * Exactly two per api_key provider (BST-1361): the app-scoped
   * `BRAINSTRIKE_<PROVIDER>_API_KEY` override first, then the
   * vendor-standard name.
   */
  envKeys?: readonly string[];
  id: ProviderId;
  /**
   * Vendor-documented stable key prefix (e.g. "sk-ant-..."). Omit when the
   * vendor documents no stable format — never guessed.
   */
  keyFormatHint?: string;
  /**
   * Provider-specific key guidance rendered verbatim in Settings (e.g.
   * google's Gemini-vs-Vertex note). Registry metadata, not a UI branch.
   */
  keyNotes?: string;
  /**
   * Ordered list of models covering both chat and embeddings.
   */
  models: readonly ProviderModelDefinition[];
  runtime: ProviderRuntime;
}

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'cohere'
  | 'voyage'
  | 'bedrock'
  | 'openai-codex'
  | 'local'
  | 'ollama'
  | 'lmstudio';

/**
 * The provider/model catalog, parsed from `provider-catalog.json` at module
 * load (BST-1650). The data used to be a 1,600-line TypeScript literal in this
 * file, checked by `tsc`; `resolveJsonModule` widens JSON literals, so
 * `parseProviderCatalog` is what replaced that check. It THROWS here rather
 * than serving a partial catalog.
 *
 * This annotation is load-bearing: it is the compile-time proof that the
 * schema still produces exactly `ProviderDefinition`, so a schema that drifts
 * from the interfaces fails `type-check` instead of shipping.
 */
const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = parseProviderCatalog(providerCatalog);

const PROVIDER_BY_ID = Object.fromEntries(
  PROVIDER_DEFINITIONS.map((provider) => [provider.id, provider])
) as Record<ProviderId, ProviderDefinition>;

const EXACT_TOKEN_MEASUREMENT_BY_PROVIDER_MODEL = new Map<
  string,
  TokenizerBackedMeasurementCapability
>([
  [
    'openai\u0000gpt-4o',
    {
      mode: 'exact-selected-model',
      tokenizer: 'o200k_base',
    },
  ],
]);

const DETERMINISTIC_TOKEN_MEASUREMENT_BACKSTOP: TokenMeasurementCapability = {
  charactersPerToken: 4,
  mode: 'deterministic-serialized-character-backstop',
};

export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDER_DEFINITIONS;
}

/**
 * Resolve measurement by an exact provider/model tuple. Dynamic or unknown
 * routes remain measurable through the deterministic backstop, but they never
 * inherit tokenizer semantics from substrings such as `openai/` or `gpt-`.
 */
export function resolveTokenMeasurementCapability(
  providerId: string,
  modelId: string
): TokenMeasurementCapability {
  const exactCapability = EXACT_TOKEN_MEASUREMENT_BY_PROVIDER_MODEL.get(
    `${providerId}\u0000${modelId}`
  );
  if (exactCapability) {
    return exactCapability;
  }

  const provider = PROVIDER_DEFINITIONS.find((definition) => definition.id === providerId);
  const model = provider?.models.find(
    (definition) => definition.type === 'llm' && definition.id === modelId
  );
  if (model?.type === 'llm' && model.tokenMeasurement) {
    return model.tokenMeasurement;
  }
  return DETERMINISTIC_TOKEN_MEASUREMENT_BACKSTOP;
}

export function getProviderDefinition(provider: ProviderId): ProviderDefinition {
  return PROVIDER_BY_ID[provider];
}

/**
 * Non-throwing counterpart to {@link getProviderDefinition} for callers whose
 * provider id is NOT statically guaranteed to be a registry member (e.g. a
 * persona pin's config-supplied provider, PR #2513 review finding 1).
 * `getProviderDefinition`'s signature promises a definition but returns
 * `undefined` at runtime for out-of-union ids — deref that and a TypeError
 * escapes into caller error handling. Use this when "unknown provider" has a
 * defined fallback.
 */
export function findProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return (PROVIDER_BY_ID as Record<string, ProviderDefinition | undefined>)[providerId];
}

export function listProviderModels(provider: ProviderId, type?: ProviderModelType) {
  const definition = getProviderDefinition(provider);
  if (!type) {
    return definition.models;
  }
  return definition.models.filter((model) => model.type === type);
}

export function listProviderLlmModels(provider: ProviderId): readonly LlmModelDefinition[] {
  return listProviderModels(provider, 'llm') as readonly LlmModelDefinition[];
}

export function listProviderEmbeddingModels(
  provider: ProviderId
): readonly EmbeddingModelDefinition[] {
  return listProviderModels(provider, 'embedding') as readonly EmbeddingModelDefinition[];
}

export function getProviderEnvKeys(provider: ProviderId): readonly string[] {
  return getProviderDefinition(provider).envKeys ?? [];
}

/**
 * Historical env names this provider once resolved (BST-1361). Allow-listed
 * and scrubbed but NEVER consulted for authentication — see
 * {@link ProviderDefinition.deprecatedEnvKeys}.
 */
export function getProviderDeprecatedEnvKeys(provider: ProviderId): readonly string[] {
  return getProviderDefinition(provider).deprecatedEnvKeys ?? [];
}

const BRAINSTRIKE_ENV_KEY_PREFIX = 'BRAINSTRIKE_';

/**
 * The app-scoped `BRAINSTRIKE_<PROVIDER>_API_KEY` override name (BST-1361).
 * Role-based, not positional: the override IS the `BRAINSTRIKE_`-prefixed
 * member of the canonical pair (pinned by provider-env-deprecation.test.ts).
 * `undefined` for keyless providers.
 */
export function getProviderOverrideEnvKey(provider: ProviderId): string | undefined {
  return getProviderEnvKeys(provider).find((name) => name.startsWith(BRAINSTRIKE_ENV_KEY_PREFIX));
}

/**
 * The vendor-standard env name (e.g. `OPENAI_API_KEY`) — the non-override
 * member of the canonical pair (BST-1361). `undefined` for keyless providers.
 */
export function getProviderVendorEnvKey(provider: ProviderId): string | undefined {
  return getProviderEnvKeys(provider).find((name) => !name.startsWith(BRAINSTRIKE_ENV_KEY_PREFIX));
}

export function providerSupportsStandardEmbeddingDimension(provider: ProviderId): boolean {
  if (!getProviderDefinition(provider).capabilities.embeddings) {
    return false;
  }
  return listProviderEmbeddingModels(provider).some((model) => model.supportsStandardDimension);
}

export function resolveDefaultModel(
  provider: ProviderId,
  type: ProviderModelType = 'llm'
): string | undefined {
  const models = listProviderModels(provider, type);
  const explicitlyFlagged = models.find((model) => model.default);
  if (explicitlyFlagged) {
    return explicitlyFlagged.id;
  }
  return models.at(0)?.id;
}

/**
 * Resolve a single LLM model definition. Throws on unknown provider/model —
 * token budgeting must never silently guess a context window.
 */
/**
 * Non-throwing counterpart to {@link getLlmModelDefinition}: returns
 * `undefined` instead of throwing for a provider/model pair absent from the
 * static registry (e.g. an OpenRouter metadata-only / auto-profile model, or
 * a persisted preference from a retired catalog entry). Callers that must
 * treat an unknown model as a hard error should use `getLlmModelDefinition`;
 * callers that have a defined fallback for "unknown" (e.g. budget defaults)
 * should use this instead of try/catch-as-control-flow.
 */
export function findLlmModelDefinition(
  providerId: ProviderId,
  modelId: string
): LlmModelDefinition | undefined {
  const provider: ProviderDefinition | undefined = getProviderDefinition(providerId);
  if (!provider) {
    return;
  }
  const model = provider.models.find(
    (definition) => definition.type === 'llm' && definition.id === modelId
  );
  return model?.type === 'llm' ? model : undefined;
}

export function getLlmModelDefinition(providerId: ProviderId, modelId: string): LlmModelDefinition {
  // O(1) map lookup; the type says it can't miss, but guard against
  // out-of-union runtime ids (e.g. persisted prefs from an older build).
  const model = findLlmModelDefinition(providerId, modelId);
  if (!model) {
    throw new Error(`Unknown LLM model id for provider ${providerId}: ${modelId}`);
  }
  return model;
}
