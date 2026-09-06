import { GEMMA4_E2B_MODEL_ID } from './local-llm.js';
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
    /**
     * USD per 1M prompt-cache READ tokens. Declared only on routes that bill
     * cache reads at their own published rate — the first-party Anthropic
     * models (0.1× input) and the Bedrock routes that accept explicit cache
     * points (Anthropic-on-Bedrock 0.1× input; Amazon Nova 0.25× input).
     */
    cacheReadPerMTok?: number;
    /**
     * USD per 1M prompt-cache WRITE tokens. Declared only where the vendor
     * bills cache writes at a PREMIUM over the input rate (Anthropic
     * first-party and Anthropic-on-Bedrock: 1.25× input). Deliberately absent
     * for Amazon Nova, which bills cache writes at the ordinary input rate —
     * absence means "no premium", never "unknown".
     */
    cacheWritePerMTok?: number;
    inputPerMTok: number;
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

const OPENAI_O200K_REFERENCE: TokenizerBackedMeasurementCapability = {
  mode: 'declared-compatible-reference',
  tokenizer: 'o200k_base',
};

const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    authType: 'api_key',
    capabilities: {
      embeddings: true,
      llm: true,
      streaming: true,
    },
    deprecatedEnvKeys: [
      'BS_OPENAI_API_KEY',
      'AI_OPENAI_API_KEY',
      'OPENAI_API_KEY_V1',
      'OPENAI_API_KEY_V2',
    ],
    displayName: 'OpenAI',
    docsUrl: 'https://platform.openai.com/api-keys',
    // Model IDs per OpenAI docs:
    // https://platform.openai.com/docs/guides/latest-model
    // https://platform.openai.com/docs/models
    envKeys: ['BRAINSTRIKE_OPENAI_API_KEY', 'OPENAI_API_KEY'],
    id: 'openai',
    keyFormatHint: 'sk-...',
    models: [
      {
        contextWindow: 1_050_000,
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 5, outputPerMTok: 30 },
        supportsStreaming: true,
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_050_000,
        default: true,
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 2.5, outputPerMTok: 15 },
        supportsStreaming: true,
        tagline: 'Most capable for everyday work',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_050_000,
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 1, outputPerMTok: 6 },
        supportsStreaming: true,
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.5-pro',
        label: 'GPT-5.5 Pro',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 15, outputPerMTok: 120 },
        supportsStreaming: true,
        tagline: 'For your toughest challenges',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.4-pro',
        label: 'GPT-5.4 Pro',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 15, outputPerMTok: 120 },
        supportsStreaming: true,
        tagline: 'For your toughest challenges',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 0.25, outputPerMTok: 2 },
        supportsStreaming: true,
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.4-nano',
        label: 'GPT-5.4 Nano',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok: 0.05, outputPerMTok: 0.4 },
        supportsStreaming: true,
        tagline: 'Fastest for lightweight tasks',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.2-pro',
        label: 'GPT-5.2 Pro',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 15, outputPerMTok: 120 },
        supportsStreaming: true,
        tagline: 'For your toughest challenges',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        default: true,
        defaultDimension: 1536,
        dimensionParameter: 'dimensions',
        id: 'text-embedding-3-small',
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        type: 'embedding',
      },
      {
        defaultDimension: 3072,
        dimensionParameter: 'dimensions',
        id: 'text-embedding-3-large',
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        type: 'embedding',
      },
    ],
    runtime: 'hosted',
  },
  {
    authType: 'api_key',
    capabilities: {
      embeddings: false,
      llm: true,
      streaming: true,
    },
    deprecatedEnvKeys: ['AI_ANTHROPIC_API_KEY'],
    displayName: 'Anthropic',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    // Model aliases per Anthropic docs:
    // https://www.anthropic.com/claude/sonnet
    // https://www.anthropic.com/claude/haiku
    // https://www.anthropic.com/claude/opus
    envKeys: ['BRAINSTRIKE_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
    id: 'anthropic',
    keyFormatHint: 'sk-ant-...',
    models: [
      {
        // Vendor OFFERED ladder and default; retrieved 2026-09-04:
        // https://platform.claude.com/docs/en/build-with-claude/effort
        // https://platform.claude.com/docs/en/about-claude/models/overview
        anthropicReasoning: {
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        contextWindow: 1_000_000,
        id: 'claude-fable-5',
        label: 'Claude Fable 5',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'anthropic',
        pricing: {
          cacheReadPerMTok: 1,
          cacheWritePerMTok: 12.5,
          inputPerMTok: 10,
          outputPerMTok: 50,
        },
        promptCaching: 'anthropic',
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // Vendor OFFERED ladder and default; retrieved 2026-09-04:
        // https://platform.claude.com/docs/en/build-with-claude/effort
        // https://platform.claude.com/docs/en/about-claude/models/overview
        anthropicReasoning: {
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        contextWindow: 1_000_000,
        id: 'claude-opus-5',
        label: 'Claude Opus 5',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'anthropic',
        pricing: {
          cacheReadPerMTok: 0.5,
          cacheWritePerMTok: 6.25,
          inputPerMTok: 5,
          outputPerMTok: 25,
        },
        promptCaching: 'anthropic',
        supportsStreaming: true,
        tagline: 'For complex agentic coding and enterprise work',
        type: 'llm',
        vision: 'supported',
      },
      {
        // Vendor OFFERED ladder and default; retrieved 2026-09-04:
        // https://platform.claude.com/docs/en/build-with-claude/effort
        // https://platform.claude.com/docs/en/about-claude/models/overview
        anthropicReasoning: {
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        contextWindow: 200_000,
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        maxOutputTokens: 64_000,
        nativeToolSearch: 'anthropic',
        pricing: {
          cacheReadPerMTok: 0.5,
          cacheWritePerMTok: 6.25,
          inputPerMTok: 5,
          outputPerMTok: 25,
        },
        promptCaching: 'anthropic',
        supportsStreaming: true,
        tagline: 'For your toughest challenges',
        type: 'llm',
        vision: 'supported',
      },
      {
        // Vendor OFFERED ladder and default; retrieved 2026-09-04:
        // https://platform.claude.com/docs/en/build-with-claude/effort
        // https://platform.claude.com/docs/en/about-claude/models/overview
        anthropicReasoning: {
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        contextWindow: 1_000_000,
        default: true,
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'anthropic',
        // Anthropic introductory rate through 2026-08-31.
        pricing: {
          cacheReadPerMTok: 0.2,
          cacheWritePerMTok: 2.5,
          inputPerMTok: 2,
          outputPerMTok: 10,
        },
        promptCaching: 'anthropic',
        supportsStreaming: true,
        tagline: 'Best mix of smarts and speed',
        type: 'llm',
        vision: 'supported',
      },
      {
        // Vendor OFFERED ladder and default; retrieved 2026-09-04:
        // https://platform.claude.com/docs/en/build-with-claude/effort
        // https://platform.claude.com/docs/en/about-claude/models/overview
        anthropicReasoning: {
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'max'],
        },
        contextWindow: 200_000,
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        maxOutputTokens: 64_000,
        nativeToolSearch: 'anthropic',
        pricing: {
          cacheReadPerMTok: 0.3,
          cacheWritePerMTok: 3.75,
          inputPerMTok: 3,
          outputPerMTok: 15,
        },
        promptCaching: 'anthropic',
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // No effort ladder: the overview table says effort is unsupported;
        // thinking uses the legacy enabled + budget_tokens form. Retrieved 2026-09-04:
        // https://platform.claude.com/docs/en/build-with-claude/effort
        // https://platform.claude.com/docs/en/about-claude/models/overview
        contextWindow: 200_000,
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        maxOutputTokens: 64_000,
        nativeToolSearch: 'anthropic',
        pricing: {
          cacheReadPerMTok: 0.1,
          cacheWritePerMTok: 1.25,
          inputPerMTok: 1,
          outputPerMTok: 5,
        },
        promptCaching: 'anthropic',
        supportsStreaming: true,
        tagline: 'Fastest for lightweight tasks',
        type: 'llm',
        vision: 'supported',
      },
    ],
    runtime: 'hosted',
  },
  {
    authType: 'api_key',
    capabilities: {
      embeddings: true,
      llm: true,
      streaming: true,
    },
    deprecatedEnvKeys: ['GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
    displayName: 'Google AI Studio',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    // Gemini 3 model IDs + embeddings docs:
    // https://ai.google.dev/gemini-api/docs/gemini-3
    // https://ai.google.dev/gemini-api/docs/embeddings
    envKeys: ['BRAINSTRIKE_GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    id: 'google',
    // Google publishes no stable key prefix, so there is no keyFormatHint.
    keyNotes: 'Use a Gemini API key from Google AI Studio. Vertex AI keys are not supported yet.',
    models: [
      {
        // Direct Google GA route and introductory pricing through 2026-12-31,
        // revalidated 2026-08-20:
        // https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
        // https://ai.google.dev/gemini-api/docs/models
        // https://ai.google.dev/gemini-api/docs/latest-model
        // https://ai.google.dev/gemini-api/docs/changelog
        // https://ai.google.dev/gemini-api/docs/pricing (BST-1339).
        contextWindow: 1_048_576,
        id: 'gemini-3.7-flash',
        label: 'Gemini 3.7 Flash',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.75, outputPerMTok: 3.75 },
        supportsStreaming: true,
        tagline: 'Fast multimodal reasoning for complex agentic workflows',
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        default: true,
        id: 'gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        tagline: 'Best mix of smarts and speed',
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro (Preview)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 2, outputPerMTok: 12 },
        supportsStreaming: true,
        tagline: 'For your toughest challenges',
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-3.1-flash-lite',
        label: 'Gemini 3.1 Flash Lite',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
        supportsStreaming: true,
        tagline: 'Fastest for lightweight tasks',
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash Lite',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
        supportsStreaming: true,
        tagline: 'Fastest for lightweight tasks',
        type: 'llm',
        vision: 'supported',
      },
      {
        default: true,
        defaultDimension: 3072,
        // Gemini embeddings use outputDimensionality in JSON; this value is a UI hint.
        dimensionParameter: 'output_dimensionality',
        id: 'gemini-embedding-001',
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        type: 'embedding',
      },
      {
        defaultDimension: 3072,
        // Auto-normalizes truncated outputs (unlike 001). JSON param is
        // outputDimensionality; this value is a UI hint.
        dimensionParameter: 'output_dimensionality',
        id: 'gemini-embedding-2',
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        type: 'embedding',
      },
    ],
    runtime: 'hosted',
  },
  {
    authType: 'api_key',
    capabilities: {
      embeddings: false,
      llm: true,
      streaming: true,
    },
    deprecatedEnvKeys: ['AI_OPENROUTER_API_KEY'],
    displayName: 'OpenRouter',
    docsUrl: 'https://openrouter.ai/settings/keys',
    // OpenRouter uses provider-prefixed model slugs (examples in docs):
    // https://openrouter.ai/docs/guides/routing/auto-model-selection
    envKeys: ['BRAINSTRIKE_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
    id: 'openrouter',
    keyFormatHint: 'sk-or-v1-...',
    // Curated current subset from OpenRouter's model catalog. Provider-reported
    // billed cost is authoritative at runtime; these rates are display estimates.
    models: [
      {
        // Official Qwen release material owns the Qwen3.8 Flash identity,
        // text/image/video input, text output, optional xhigh/medium/low
        // reasoning ladder, and xhigh default. OpenRouter Models API owns the
        // fixed route's 1M/131,072 ceilings, tools/structured-output support,
        // and gateway pricing, retrieved 2026-08-30 (BST-1516). The output fact
        // is a hard maximum, not a default combined reasoning + answer window.
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.8-flash',
        inputModalities: ['text', 'image', 'video'],
        label: 'Qwen3.8 Flash (OpenRouter)',
        maxOutputTokens: 131_072,
        outputModalities: ['text'],
        pricing: { inputPerMTok: 0.15, outputPerMTok: 0.47 },
        reasoning: {
          defaultEffort: 'xhigh',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // Official Z.AI GLM-5.3 release/model/thinking docs, retrieved
        // 2026-08-22, own the API ID, text-only modality, native 1M/128K
        // limits, and mandatory max/high/low reasoning ladder with max default.
        // OpenRouter Models and endpoint APIs own this fixed route's effective
        // 1,048,576/131,072 ceilings and gateway pricing (BST-1414). The 128K
        // fact is a hard maximum, not a distinct default combined reasoning +
        // answer reservation, so vendorDefaultOutputTokens remains absent.
        contextWindow: 1_048_576,
        id: 'z-ai/glm-5.3',
        label: 'GLM-5.3 (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 1.4, outputPerMTok: 4.4 },
        reasoning: {
          defaultEffort: 'max',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['max', 'high', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        // Anonymous stealth-preview identity, route, modalities, context/output
        // limits, reasoning controls, tool/structured-output support, and zero
        // gateway pricing: OpenRouter Models and endpoint APIs, revalidated
        // 2026-08-22 (BST-1399). Revalidate the preview rate when this route
        // leaves stealth. OpenRouter does not identify the vendor, so there is
        // no vendor-authoritative default output window to record; Auto honors
        // the mandatory published max effort under the generic coding ceiling.
        contextWindow: 1_048_576,
        id: 'stealth/ox-alpha',
        label: 'Ox Alpha (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        reasoning: {
          defaultEffort: 'max',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['max', 'high', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // Capabilities and limits: official Qwen model card at commit
        // 1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0. Route, max completion,
        // and gateway pricing: OpenRouter Models API, retrieved 2026-08-15
        // (BST-1302).
        contextWindow: 262_144,
        id: 'qwen/qwen3.8-27b',
        label: 'Qwen3.8 27B (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.45, outputPerMTok: 3.2 },
        reasoning: {
          // Auto intentionally follows Qwen's documented xhigh default. The
          // official ladder skips high: xhigh, medium, low. No paid route smoke
          // was available (BST-1302), and Qwen publishes recommended maxima for
          // separate reasoning/final output rather than a distinct default
          // thinking+answer reservation, so vendorDefaultOutputTokens is absent.
          defaultEffort: 'xhigh',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // Identity, modalities, context extension, mandatory thinking, and
        // effort levels: official Qwen model card at revision 207bd685,
        // retrieved 2026-08-15. Route, effective gateway limits, and pricing:
        // OpenRouter Models API, retrieved 2026-08-15 (BST-1306).
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.8-2.4t-a95b',
        label: 'Qwen3.8 2.4T A95B (OpenRouter)',
        maxOutputTokens: 262_144,
        pricing: { inputPerMTok: 2, outputPerMTok: 6 },
        reasoning: {
          // Qwen requires thinking for every interaction. Its official effort
          // ladder deliberately skips `high`; Auto follows the xhigh default.
          defaultEffort: 'xhigh',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['xhigh', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        // Vendor identity, modalities, limits, and tool/structured-output support:
        // official Alibaba Cloud Model Studio model page, retrieved 2026-08-15.
        // Route, gateway pricing, and reasoning controls: OpenRouter Models API,
        // retrieved 2026-08-15 (BST-1309). Cache prices are omitted because this
        // static schema has no cache-price fields.
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.8-max',
        label: 'Qwen3.8 Max (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 2, outputPerMTok: 6 },
        reasoning: {
          // Unlike the sibling Qwen routes, OpenRouter explicitly advertises
          // `high` and `minimal` for Max; preserve the route's five-rung ladder.
          // Alibaba documents 131,072 as a maximum, not a distinct default
          // thinking+answer window, so there is no vendorDefaultOutputTokens fact.
          defaultEffort: 'xhigh',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'minimal'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // Identity, GA status, text modality, optional reasoning, and native
        // context: official NVIDIA model card at revision d468880b, retrieved
        // 2026-08-17. Route, effective hosted limits, and gateway pricing:
        // OpenRouter Models API, retrieved 2026-08-17 (BST-1343).
        contextWindow: 262_144,
        id: 'nvidia/nemotron-3.5-lightning',
        label: 'Nemotron 3.5 Lightning (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.08, outputPerMTok: 0.2 },
        // NVIDIA documents reasoning as optional on/off but publishes no effort
        // ladder. Declare only the explicit `none` control so offline menus and
        // persisted model-switch settings preserve the verified off state.
        reasoning: { mandatory: false, supportedEfforts: ['none'] },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        // Capabilities and limits: official Google model page, last updated
        // 2026-08-13. Route and gateway pricing: OpenRouter Models API,
        // retrieved 2026-08-14 (BST-1265).
        contextWindow: 1_048_576,
        id: 'google/gemini-3.7-flash',
        label: 'Gemini 3.7 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.375, outputPerMTok: 1.875 },
        reasoning: {
          // OpenRouter explicitly reports both mandatory=true and
          // default_enabled=true. Preserve both so Auto uses the gateway's
          // declared medium default rather than inferring one. Google documents
          // 65,536 as a maximum, not a distinct default thinking+answer window,
          // so there is no vendorDefaultOutputTokens fact to record.
          defaultEffort: 'medium',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['high', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 262_144,
        id: 'inclusionai/ling-3.0-flash:free',
        label: 'Ling 3.0 Flash Free (OpenRouter)',
        maxOutputTokens: 32_768,
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 1_048_576,
        id: 'poolside/laguna-s-2.1',
        label: 'Laguna S 2.1 (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.1, outputPerMTok: 0.2 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 262_144,
        id: 'poolside/laguna-xs-2.1',
        label: 'Laguna XS 2.1 (OpenRouter)',
        maxOutputTokens: 32_768,
        pricing: { inputPerMTok: 0.06, outputPerMTok: 0.12 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 1_048_576,
        id: 'google/gemini-3.6-flash',
        label: 'Gemini 3.6 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 1.5, outputPerMTok: 7.5 },
        reasoning: {
          defaultEffort: 'medium',
          mandatory: true,
          supportedEfforts: ['high', 'medium', 'low', 'minimal'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'google/gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash Lite (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        reasoning: {
          defaultEffort: 'minimal',
          mandatory: true,
          supportedEfforts: ['high', 'medium', 'low', 'minimal'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // Native 1M context, 128K max output — attributed to Meituan's LongCat
        // API Platform in the 2026-06-30 release coverage. First-party docs
        // (longcat.ai/docs) 404'd at audit time, so this is secondary sourcing:
        // re-confirm against Meituan's console before treating it as settled.
        // Replaces a 1_048_756 context (a transposition of 2^20 matching no
        // published limit) and a 262_144 output ceiling of unknown origin —
        // double the provider figure, and absent from OpenRouter's listing too.
        contextWindow: 1_000_000,
        id: 'meituan/longcat-2.0',
        label: 'LongCat 2.0 (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 1_048_576,
        id: 'thinkingmachines/inkling',
        label: 'Inkling (OpenRouter)',
        // Thinking Machines' model card documents reasoning benchmarks but
        // publishes no effort-level parameter, so nothing is declared here:
        // absence is never guessed as support, and the shipped entry's full
        // effort enum turned the deliberate `unknown` badge into a silent yes.
        // This places Inkling in the same undeclared bucket as 32 of the 38
        // OpenRouter rows (including the default openai/gpt-5.6-terra), where
        // efforts resolve from live OpenRouter metadata rather than this table.
        // Declare efforts here only once the provider publishes them.
        pricing: { inputPerMTok: 1, outputPerMTok: 4.05 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 256_000,
        id: 'kwaipilot/kat-coder-air-v2.5',
        label: 'KAT-Coder Air V2.5 (OpenRouter)',
        maxOutputTokens: 80_000,
        pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 256_000,
        id: 'kwaipilot/kat-coder-pro-v2.5',
        label: 'KAT-Coder Pro V2.5 (OpenRouter)',
        maxOutputTokens: 80_000,
        pricing: { inputPerMTok: 0.74, outputPerMTok: 2.96 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        // Identity, modalities, context, output-limit semantics, mandatory
        // reasoning, and effort levels: official xAI Grok 4.6 docs/release
        // notes, retrieved 2026-08-18. Route and standard gateway pricing:
        // OpenRouter Models API, retrieved 2026-08-18 (BST-1374).
        contextWindow: 500_000,
        id: 'x-ai/grok-4.6',
        label: 'Grok 4.6 (OpenRouter)',
        // xAI documents "No text output limit" and OpenRouter reports null;
        // omit maxOutputTokens rather than inventing a numeric ceiling.
        pricing: { inputPerMTok: 2, outputPerMTok: 6 },
        reasoning: {
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['xhigh', 'high', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 500_000,
        id: 'x-ai/grok-4.5',
        label: 'Grok 4.5 (OpenRouter)',
        pricing: { inputPerMTok: 2, outputPerMTok: 6 },
        reasoning: {
          defaultEffort: 'high',
          mandatory: true,
          supportedEfforts: ['high', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // Identity, lifecycle, modalities, context, streaming, tools, structured
        // output, and mandatory reasoning ladder: official Meta Model API docs
        // and 2026-08-05 release notes. Route, effective gateway limit, default
        // effort, and gateway pricing: OpenRouter Models API, retrieved
        // 2026-08-21 (BST-1383).
        contextWindow: 1_048_576,
        id: 'meta/muse-spark-1.2',
        label: 'Muse Spark 1.2 (OpenRouter)',
        // Meta's direct-provider examples publish a 131,072 output limit, but
        // the fixed OpenRouter route reports max_completion_tokens: null.
        // Omit maxOutputTokens rather than transplanting a provider-local limit.
        // Meta does not document that limit as a distinct default combined
        // thinking+answer window, so vendorDefaultOutputTokens is absent too.
        pricing: { inputPerMTok: 1.25, outputPerMTok: 4.25 },
        reasoning: {
          defaultEffort: 'medium',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'minimal'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'meta/muse-spark-1.1',
        label: 'Muse Spark 1.1 (OpenRouter)',
        pricing: { inputPerMTok: 1.25, outputPerMTok: 4.25 },
        reasoning: {
          defaultEffort: 'medium',
          mandatory: true,
          supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'minimal'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'moonshotai/kimi-k3',
        label: 'Kimi K3 (OpenRouter)',
        // Official maximum max_completion_tokens (platform.kimi.ai K3
        // quickstart, verified 2026-08-05). OpenRouter publishes none.
        maxOutputTokens: 1_048_576,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        reasoning: {
          // Auto deliberately runs below the vendor default: Kimi's `max` spends
          // the whole coding-profile output budget reasoning (BST-833).
          autoEffort: 'low',
          defaultEffort: 'max',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['max', 'high', 'low'],
          // Official K3 contract (platform.kimi.ai/docs/guide/kimi-k3-quickstart,
          // verified 2026-08-05): max_completion_tokens defaults to 131,072
          // (max 1,048,576) — the vendor's operating point for thinking +
          // answer. Moonshot's FIRST-PARTY API cannot disable thinking, but
          // the OpenRouter route declares reasoning optional (mandatory:
          // false, multiple hosts serve this open-weight model); an explicit
          // Off maps to `reasoning.enabled: false` under
          // `provider.require_parameters`, which narrows routing to endpoints
          // honouring it — so a reasoning-off request correctly keeps the
          // coding ceiling instead of this window. OpenRouter publishes no
          // max completion for this route, so the fact lives here (BST-1170).
          vendorDefaultOutputTokens: 131_072,
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_050_000,
        id: 'openai/gpt-5.6-sol',
        label: 'GPT-5.6 Sol (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 5, outputPerMTok: 30 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_050_000,
        default: true,
        id: 'openai/gpt-5.6-terra',
        label: 'GPT-5.6 Terra (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 2.5, outputPerMTok: 15 },
        supportsStreaming: true,
        tagline: 'Most capable for everyday work',
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_050_000,
        id: 'openai/gpt-5.6-luna',
        label: 'GPT-5.6 Luna (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1, outputPerMTok: 6 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_000_000,
        id: 'anthropic/claude-fable-5',
        label: 'Claude Fable 5 (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 10, outputPerMTok: 50 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_000_000,
        id: 'anthropic/claude-sonnet-5',
        label: 'Claude Sonnet 5 (OpenRouter)',
        maxOutputTokens: 128_000,
        // OpenRouter currently reflects Anthropic's introductory rate.
        pricing: { inputPerMTok: 2, outputPerMTok: 10 },
        supportsStreaming: true,
        tagline: 'Best mix of smarts and speed',
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'z-ai/glm-5.2',
        label: 'GLM-5.2 (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.9282, outputPerMTok: 2.9172 },
        reasoning: {
          // No autoEffort: Auto follows the vendor default. Verified live
          // 2026-07-25 at `high` — reasoning visible, 271-line file written,
          // full final answer, 10.3K tokens (BST-833).
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'high'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 1_048_576,
        id: 'minimax/minimax-m3',
        label: 'MiniMax M3 (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro (OpenRouter)',
        maxOutputTokens: 384_000,
        pricing: { inputPerMTok: 0.435, outputPerMTok: 0.87 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 1_048_576,
        id: 'deepseek/deepseek-v4-flash',
        label: 'DeepSeek V4 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.09, outputPerMTok: 0.18 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.7-max',
        label: 'Qwen3.7 Max (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 3.75 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.7-plus',
        label: 'Qwen3.7 Plus (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.32, outputPerMTok: 1.28 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.6-flash',
        label: 'Qwen3.6 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.1875, outputPerMTok: 1.125 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 262_144,
        id: 'qwen/qwen3-coder-next',
        label: 'Qwen3 Coder Next (OpenRouter)',
        pricing: { inputPerMTok: 0.11, outputPerMTok: 0.8 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 262_144,
        id: 'moonshotai/kimi-k2.6',
        label: 'Kimi K2.6 (OpenRouter)',
        pricing: { inputPerMTok: 0.66, outputPerMTok: 3.41 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 262_144,
        id: 'moonshotai/kimi-k2.7-code',
        label: 'Kimi K2.7 Code (OpenRouter)',
        pricing: { inputPerMTok: 0.719, outputPerMTok: 3.49 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.5',
        label: 'GPT-5.5 (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.4',
        label: 'GPT-5.4 (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.4-mini',
        label: 'GPT-5.4 Mini (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 0.25, outputPerMTok: 2 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.3-codex',
        label: 'GPT-5.3 Codex (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.2',
        label: 'GPT-5.2 (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 200_000,
        id: 'anthropic/claude-opus-4.8',
        label: 'Claude Opus 4.8 (OpenRouter)',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 5, outputPerMTok: 25 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 200_000,
        id: 'anthropic/claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6 (OpenRouter)',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 200_000,
        id: 'anthropic/claude-haiku-4.5',
        label: 'Claude Haiku 4.5 (OpenRouter)',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 1, outputPerMTok: 5 },
        supportsStreaming: true,
        tagline: 'Fastest for lightweight tasks',
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'google/gemini-3.5-flash',
        label: 'Gemini 3.5 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'google/gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 2, outputPerMTok: 12 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 1_048_576,
        id: 'google/gemini-2.5-flash',
        label: 'Gemini 2.5 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
    ],
    runtime: 'gateway',
  },
  {
    authType: 'api_key',
    capabilities: {
      embeddings: true,
      llm: false,
      streaming: false,
    },
    deprecatedEnvKeys: ['AI_COHERE_API_KEY'],
    displayName: 'Cohere',
    // Cohere publishes no stable key prefix, so there is no keyFormatHint.
    docsUrl: 'https://dashboard.cohere.com/api-keys',
    envKeys: ['BRAINSTRIKE_COHERE_API_KEY', 'COHERE_API_KEY'],
    id: 'cohere',
    models: [
      {
        availableDimensions: [1024],
        default: true,
        defaultDimension: 1024,
        id: 'embed-english-v3.0',
        supportsStandardDimension: true,
        type: 'embedding',
      },
      {
        availableDimensions: [1024],
        defaultDimension: 1024,
        id: 'embed-multilingual-v3.0',
        supportsStandardDimension: true,
        type: 'embedding',
      },
    ],
    runtime: 'hosted',
  },
  {
    authType: 'api_key',
    capabilities: {
      embeddings: true,
      llm: false,
      streaming: false,
    },
    deprecatedEnvKeys: ['AI_VOYAGE_API_KEY'],
    displayName: 'Voyage AI',
    // Voyage's docs link this dashboard page (docs.voyageai.com, verified
    // 2026-08-18). No stable key prefix is documented, so no keyFormatHint.
    docsUrl: 'https://dashboard.voyageai.com/organization/api-keys',
    envKeys: ['BRAINSTRIKE_VOYAGE_API_KEY', 'VOYAGE_API_KEY'],
    id: 'voyage',
    models: [
      {
        availableDimensions: [1024],
        default: true,
        defaultDimension: 1024,
        id: 'voyage-3',
        supportsStandardDimension: true,
        type: 'embedding',
      },
      {
        availableDimensions: [512],
        defaultDimension: 512,
        id: 'voyage-3-lite',
        supportsStandardDimension: false,
        type: 'embedding',
      },
    ],
    runtime: 'hosted',
  },
  {
    // `authType: 'aws'` covers BOTH live auth forms — the bearer API key
    // (BST-1350) and the AWS credential chain / SigV4 (BST-1353). The stored
    // credential's `mode` discriminates them.
    authType: 'aws',
    capabilities: {
      embeddings: false,
      llm: true,
      streaming: true,
    },
    displayName: 'Amazon Bedrock',
    // AWS's "Generate Amazon Bedrock API keys" console docs page.
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html',
    // BST-1361 two-name scheme: app-scoped override first, then AWS's
    // documented bearer-token variable for Bedrock API keys.
    envKeys: ['BRAINSTRIKE_BEDROCK_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK'],
    id: 'bedrock',
    // AWS documents no stable printable prefix for Bedrock API keys, so there
    // is no keyFormatHint.
    keyNotes:
      'Use an Amazon Bedrock API key (bearer token) from the AWS console. IAM SigV4 credentials and AWS profiles are not supported yet. Requests also need an AWS region: set AWS_REGION or store it with the key.',
    // Model ids/pricing verified against https://models.dev/api.json
    // (amazon-bedrock provider), retrieved 2026-08-18. Ids are stored
    // UNPREFIXED; cross-region inference-profile prefixes (us./eu./…) are
    // applied per request by resolveBedrockModelId in packages/agent.
    // Prompt caching (BST-1354): Bedrock bills explicit `cachePoint` reads and
    // writes at published per-model rates, so the Claude and Nova rows carry
    // cache pricing. AWS documents a maximum of FOUR cache checkpoints per
    // request for every caching-capable route, which is what bounds the
    // wrapper's first-2-system + last-2-non-system placement policy.
    models: [
      {
        bedrockReasoning: 'adaptive',
        contextWindow: 1_000_000,
        id: 'anthropic.claude-fable-5',
        label: 'Claude Fable 5 (Bedrock)',
        maxOutputTokens: 128_000,
        pricing: {
          cacheReadPerMTok: 1,
          cacheWritePerMTok: 12.5,
          inputPerMTok: 10,
          outputPerMTok: 50,
        },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        bedrockReasoning: 'adaptive',
        contextWindow: 1_000_000,
        id: 'anthropic.claude-opus-4-8',
        label: 'Claude Opus 4.8 (Bedrock)',
        maxOutputTokens: 128_000,
        pricing: {
          cacheReadPerMTok: 0.5,
          cacheWritePerMTok: 6.25,
          inputPerMTok: 5,
          outputPerMTok: 25,
        },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        tagline: 'For your toughest challenges',
        type: 'llm',
        vision: 'supported',
      },
      {
        bedrockReasoning: 'adaptive',
        contextWindow: 1_000_000,
        default: true,
        id: 'anthropic.claude-sonnet-5',
        label: 'Claude Sonnet 5 (Bedrock)',
        maxOutputTokens: 128_000,
        // Bedrock mirrors Anthropic's introductory rate (models.dev 2026-08-18).
        pricing: {
          cacheReadPerMTok: 0.2,
          cacheWritePerMTok: 2.5,
          inputPerMTok: 2,
          outputPerMTok: 10,
        },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        tagline: 'Best mix of smarts and speed',
        type: 'llm',
        vision: 'supported',
      },
      {
        bedrockReasoning: 'adaptive',
        // models.dev lists a 1M context for this Bedrock route; the registry
        // pins the vendor's standard tier (200K), consistent with the direct
        // Anthropic and OpenRouter rows for the same model.
        contextWindow: 200_000,
        id: 'anthropic.claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6 (Bedrock)',
        maxOutputTokens: 64_000,
        pricing: {
          cacheReadPerMTok: 0.3,
          cacheWritePerMTok: 3.75,
          inputPerMTok: 3,
          outputPerMTok: 15,
        },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        // The one catalogued Claude-on-Bedrock route without adaptive thinking
        // (installed SDK `getModelCapabilities`), so it keeps the legacy
        // explicit-budget form.
        bedrockReasoning: 'budget-tokens',
        contextWindow: 200_000,
        id: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        label: 'Claude Haiku 4.5 (Bedrock)',
        maxOutputTokens: 64_000,
        pricing: {
          cacheReadPerMTok: 0.1,
          cacheWritePerMTok: 1.25,
          inputPerMTok: 1,
          outputPerMTok: 5,
        },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        tagline: 'Fastest for lightweight tasks',
        type: 'llm',
        vision: 'supported',
      },
      {
        // Nova v1 model cards document explicit cache points (system +
        // messages, 4 checkpoints) but NO reasoning capability, so these rows
        // declare caching without `bedrockReasoning`.
        contextWindow: 300_000,
        id: 'amazon.nova-pro-v1:0',
        label: 'Amazon Nova Pro',
        maxOutputTokens: 8192,
        pricing: { cacheReadPerMTok: 0.2, inputPerMTok: 0.8, outputPerMTok: 3.2 },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 300_000,
        id: 'amazon.nova-lite-v1:0',
        label: 'Amazon Nova Lite',
        maxOutputTokens: 8192,
        pricing: { cacheReadPerMTok: 0.015, inputPerMTok: 0.06, outputPerMTok: 0.24 },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 128_000,
        id: 'amazon.nova-micro-v1:0',
        label: 'Amazon Nova Micro',
        maxOutputTokens: 8192,
        pricing: { cacheReadPerMTok: 0.008_75, inputPerMTok: 0.035, outputPerMTok: 0.14 },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
      {
        // The ONLY Nova route AWS documents extended thinking for
        // (nova2-userguide/extended-thinking.html: `reasoningConfig` with
        // `maxReasoningEffort`, no token budget). models.dev publishes no
        // cache-read rate for it and no Nova 2 model card documents cache
        // points, so it declares reasoning WITHOUT `promptCaching` — absence
        // is the honest record, not an oversight.
        bedrockReasoning: 'max-reasoning-effort',
        contextWindow: 128_000,
        id: 'amazon.nova-2-lite-v1:0',
        label: 'Amazon Nova 2 Lite',
        maxOutputTokens: 4096,
        pricing: { inputPerMTok: 0.33, outputPerMTok: 2.75 },
        supportsStreaming: true,
        type: 'llm',
        // models.dev reports `modalities.input: [text, image, video]`. Do NOT
        // read vision off the sibling `attachment` flag — that field is about
        // file attachments and is false here despite image input working.
        vision: 'supported',
      },
      // amazon.nova-premier is not listed by models.dev for Bedrock
      // (2026-08-18), so it is deliberately absent.
      {
        contextWindow: 1_000_000,
        id: 'meta.llama4-maverick-17b-instruct-v1:0',
        label: 'Llama 4 Maverick (Bedrock)',
        maxOutputTokens: 16_384,
        pricing: { inputPerMTok: 0.24, outputPerMTok: 0.97 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 3_500_000,
        id: 'meta.llama4-scout-17b-instruct-v1:0',
        label: 'Llama 4 Scout (Bedrock)',
        maxOutputTokens: 16_384,
        pricing: { inputPerMTok: 0.17, outputPerMTok: 0.66 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 163_840,
        id: 'deepseek.v3.2',
        label: 'DeepSeek V3.2 (Bedrock)',
        maxOutputTokens: 81_920,
        pricing: { inputPerMTok: 0.62, outputPerMTok: 1.85 },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      },
    ],
    runtime: 'hosted',
  },
  {
    /**
     * OpenAI via a ChatGPT subscription (BST-1356), governed by
     * `docs/OAUTH_LEGAL_REVIEW_GATE.md` — APPROVED WITH CONSTRAINTS. This is
     * the FIRST carrier of `oauth_subscription`.
     *
     * The model set mirrors opencode's `ALLOWED_MODELS`, re-verified against
     * `anomalyco/opencode` `dev` HEAD 0033bb3559 on 2026-08-18 (gate
     * constraint 8). "Pro" reasoning routes and gpt-5.6 are excluded upstream
     * and excluded here.
     *
     * PRICING IS DELIBERATELY OMITTED on every row: usage draws on the user's
     * subscription rather than metered per-token billing, so the UI renders
     * "cost unavailable". A zero price would assert a cost we do not know.
     *
     * `nativeToolSearch` is likewise omitted: the Codex backend is a distinct
     * endpoint from the platform Responses API and its support for OpenAI's
     * native search tool is unverified. Claiming it unverified would be a
     * capability we cannot honor.
     *
     * MODEL IDS ARE `codex/`-PREFIXED. The `models` table's `id` is a GLOBAL
     * primary key (migration 015), so a bare `gpt-5.5` row here would collide
     * with — and on upsert HIJACK — the platform `openai` row of the same id.
     * Every multi-route provider namespaces for this reason (openrouter uses
     * `openai/…`, bedrock uses `anthropic.…`). The prefix is stripped to the
     * bare wire id at request time by `resolveCodexModelId`
     * (packages/agent/src/providers/codex-model-id.ts).
     */
    authType: 'oauth_subscription',
    capabilities: {
      embeddings: false,
      llm: true,
      streaming: true,
    },
    displayName: 'OpenAI (ChatGPT)',
    docsUrl: 'https://developers.openai.com/codex/auth',
    // Subscription auth is interactive-desktop-only (gate constraint 4): no
    // environment variable can authenticate this provider, by construction.
    envKeys: [],
    id: 'openai-codex',
    keyNotes:
      'Sign in with your own ChatGPT Plus or Pro account. Usage draws on your personal subscription quota; commercial or multi-user serving requires platform API keys instead.',
    models: [
      {
        contextWindow: 400_000,
        default: true,
        id: 'codex/gpt-5.5',
        label: 'GPT-5.5',
        maxOutputTokens: 128_000,
        supportsStreaming: true,
        tagline: 'Included with your ChatGPT subscription',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'codex/gpt-5.4',
        label: 'GPT-5.4',
        maxOutputTokens: 128_000,
        supportsStreaming: true,
        tagline: 'Included with your ChatGPT subscription',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        contextWindow: 400_000,
        id: 'codex/gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        maxOutputTokens: 128_000,
        supportsStreaming: true,
        tagline: 'Faster, included with your ChatGPT subscription',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
      {
        // Codex-only route with no direct base-registry row; its family
        // anchor is the base `gpt-5.3-codex` entry (same limits, vision).
        contextWindow: 400_000,
        id: 'codex/gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        maxOutputTokens: 128_000,
        supportsStreaming: true,
        tagline: 'Lightweight coding, included with your ChatGPT subscription',
        tokenMeasurement: OPENAI_O200K_REFERENCE,
        type: 'llm',
        vision: 'supported',
      },
    ],
    runtime: 'hosted',
  },
  {
    authType: 'none',
    capabilities: {
      embeddings: false,
      llm: true,
      streaming: false, // transformers.js generate() is not streaming
    },
    displayName: 'Local (Browser)',
    id: 'local',
    models: [
      {
        // These are the RUNTIME budgets, not Gemma 4 E2B's architectural limits
        // (the model spec lists ~128K context). The local provider runs q4f16
        // weights through transformers.js on WebGPU, where prefilling a large
        // prompt allocates an O(seq^2) attention buffer that exhausts GPU memory
        // and aborts ONNX Runtime (SafeInt overflow / std::bad_alloc) well below
        // the architectural window — empirically in the low thousands of tokens
        // on a typical device. Declaring 131_072/8192 told the context-budget
        // machinery (deriveEffectiveInputBudget -> agentLoop.inputTokenLimit ->
        // Mastra TokenLimiter) and the meter that ~128K was usable, so multi-turn
        // and tool-calling contexts ballooned straight into an OOM crash. These
        // conservative values keep the assembled prompt bounded and cap local
        // generation; a prompt that still exceeds a given device's GPU is caught
        // by the engine-fault reset in llm-host-runtime (recovers + reports
        // instead of poisoning the session). NOTE: this is RUNTIME-only metadata
        // (no DB model-catalog migration). The DB catalog row (migration
        // 028-gemma-local-llm.ts) still carries the DESCRIPTIVE
        // capabilities.contextWindow: 131072, which is intentionally NOT
        // consulted for budgeting — this static registry value is the sole
        // budget source for the built-in 'local' provider — so the two
        // diverging is harmless, not a bug. The deeper fix for reliable local
        // tool-calling is a leaner local system-prompt/tool-schema footprint.
        contextWindow: 8192,
        default: true,
        id: GEMMA4_E2B_MODEL_ID,
        label: 'Gemma 4 E2B',
        maxOutputTokens: 2048,
        supportsStreaming: false,
        tagline: 'Runs privately on this device',
        type: 'llm',
        vision: 'unsupported',
      },
    ],
    runtime: 'browser',
  },
  {
    // The optional local-server bearer token is a transport concern
    // (providerOptions.apiToken), not an authType.
    authType: 'none',
    capabilities: {
      embeddings: true,
      llm: true,
      streaming: true,
    },
    displayName: 'Ollama (Local Runtime)',
    id: 'ollama',
    // Runtime models are discovered dynamically from localhost endpoints.
    models: [],
    runtime: 'local',
  },
  {
    // The optional local-server bearer token is a transport concern
    // (providerOptions.apiToken), not an authType.
    authType: 'none',
    capabilities: {
      embeddings: true,
      llm: true,
      streaming: true,
    },
    displayName: 'LM Studio (Local Runtime)',
    id: 'lmstudio',
    // Runtime models are discovered dynamically from localhost endpoints.
    models: [],
    runtime: 'local',
  },
];

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
