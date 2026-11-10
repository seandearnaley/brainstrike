import type { ModelVendorId } from './model-vendors.ts';
import providerCatalog from './provider-catalog.json' with { type: 'json' };
import { parseProviderCatalog } from './provider-catalog-schema.ts';
import type { AnthropicEffort, OpenAiReasoningEffort } from './runtime-data.ts';

/**
 * Where a provider's inference runs: `hosted` is a vendor API, `gateway` a
 * routing API in front of several vendors.
 */
export type ProviderRuntime = 'hosted' | 'gateway';

export interface ProviderCapabilities {
  streaming: boolean;
}

/**
 * Whether a model accepts image (vision) input parts. Drives the composer
 * attachment gate and the picker model metadata. Every registered model
 * commits to one value so the attachment gate never guesses.
 */
export type ModelVisionSupport = 'supported' | 'unsupported';
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

export interface ProviderCatalogPresentation {
  readonly enabled: boolean;
  readonly icon: string | null;
  readonly name: string;
  readonly sortOrder: number;
}
export interface ModelCatalogPresentation extends ProviderCatalogPresentation {
  readonly bestFor: readonly string[] | null;
  readonly capabilities?: { readonly toolCalling?: boolean; readonly contextWindow?: number };
  readonly description: string | null;
  readonly parameters: Readonly<Record<string, unknown>> | null;
  readonly tagline: string | null;
}

interface BaseModelDefinition {
  readonly catalog?: ModelCatalogPresentation;
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
   * Bedrock-only (BST-1807): the route always thinks, as the direct row's
   * `anthropicReasoning.mandatory` says. Present only beside the `adaptive`
   * dialect. Its `display` defaults to `omitted`, so the request carries
   * `{type:'adaptive', display}` at every effort, Auto included, or the
   * show-reasoning preference (and Opus 5.5's between-tool-call progress
   * text, which arrives as thinking) is hidden.
   */
  bedrockReasoningMandatory?: true;
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
   * billed cost remains authoritative. Omit when pricing is unknown. Explicit zeroes are
   * permitted only when current provider evidence supports a reviewed free hosted route;
   * they stay distinct from "cost unavailable."
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
   * - `openrouter` — OpenRouter's request-level `cache_control`, for gateway
   *   routes whose upstream needs explicit breakpoints (Anthropic).
   * - `openrouter-breakpoints` — `cache_control` on OpenRouter content blocks,
   *   for upstreams with no request-level form (Alibaba-served Qwen).
   */
  promptCaching?: 'anthropic' | 'bedrock' | 'openrouter' | 'openrouter-breakpoints';
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
   * model-catalog tagline column feeds the Model Catalog's descriptions, not
   * this menu. Omit rather than invent
   * copy: a model without a tagline renders name-only.
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
   * Who made the model, whichever route serves it: `anthropic` for Claude on
   * Anthropic's API, OpenRouter and Bedrock alike. REQUIRED and declared per
   * row; never read from the model ID's prefix.
   */
  vendor: ModelVendorId;
  /**
   * Image-input support. REQUIRED: adding a model without it is a compile
   * error — this gates the composer attachment affordance per selected model.
   * Declare the capability of the route actually used (e.g. a gateway route
   * mirrors its underlying model).
   */
  vision: ModelVisionSupport;
}

export type ProviderModelDefinition = LlmModelDefinition;

/**
 * How a provider authenticates. `'aws'` is carried by `bedrock` (BST-1350).
 */
export type ProviderAuthType = 'api_key' | 'aws';

export interface ProviderDefinition {
  authType: ProviderAuthType;
  capabilities: ProviderCapabilities;
  readonly catalog?: ProviderCatalogPresentation;
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
   * Ordered list of the provider's chat models.
   */
  models: readonly ProviderModelDefinition[];
  /**
   * What the provider bills (USD) for each search its native web search tool
   * runs, beside the tokens its results add. Only the providers whose search
   * the host swaps in for the catalog tool declare it (`native-web-search.ts`).
   */
  nativeWebSearchUsdPerCall?: number;
  runtime: ProviderRuntime;
}

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'bedrock';

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
  const model = provider?.models.find((definition) => definition.id === modelId);
  if (model?.tokenMeasurement) {
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

export function listProviderLlmModels(provider: ProviderId): readonly LlmModelDefinition[] {
  return getProviderDefinition(provider).models;
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
 */
export function getProviderOverrideEnvKey(provider: ProviderId): string | undefined {
  return getProviderEnvKeys(provider).find((name) => name.startsWith(BRAINSTRIKE_ENV_KEY_PREFIX));
}

/**
 * The vendor-standard env name (e.g. `OPENAI_API_KEY`) — the non-override
 * member of the canonical pair (BST-1361).
 */
export function getProviderVendorEnvKey(provider: ProviderId): string | undefined {
  return getProviderEnvKeys(provider).find((name) => !name.startsWith(BRAINSTRIKE_ENV_KEY_PREFIX));
}

export function resolveDefaultModel(provider: ProviderId): string | undefined {
  const models = listProviderLlmModels(provider);
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
  return provider.models.find((definition) => definition.id === modelId);
}

/** A catalogued model's maker; undefined for a model the catalog doesn't list. */
export function findModelVendor(providerId: string, modelId: string): ModelVendorId | undefined {
  return findProviderDefinition(providerId)?.models.find((definition) => definition.id === modelId)
    ?.vendor;
}

/** A catalogued model's label, else its raw id. */
export function resolveModelLabel(providerId: string, modelId: string): string {
  const model = findProviderDefinition(providerId)?.models.find(
    (definition) => definition.id === modelId
  );
  return model?.label ?? modelId;
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
