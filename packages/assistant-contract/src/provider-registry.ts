import { GEMMA4_E2B_MODEL_ID } from './local-llm.js';
import type { OpenAiReasoningEffort } from './runtime-data.js';

export const STANDARD_EMBEDDING_DIMENSION = 768;

export type ProviderRuntime = 'hosted' | 'gateway' | 'local' | 'browser';

export type ProviderModelType = 'llm' | 'embedding';

export interface ProviderCapabilities {
  embeddings: boolean;
  llm: boolean;
  streaming: boolean;
}

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
   * Total context window in tokens (input + output). REQUIRED: adding a model
   * without it is a compile error — this drives the thread context meter and
   * the auto-derived agent input token budget. Use the provider's documented
   * standard tier (not beta/extended tiers).
   */
  contextWindow: number;
  /**
   * Provider's documented maximum output tokens, when known. Used to reserve
   * output headroom in the input-budget derivation.
   */
  maxOutputTokens?: number;
  /**
   * Approx. USD price per 1,000,000 tokens. ESTIMATE as of 2026-07-13 — list prices drift;
   * treat as non-authoritative (override planned in settings). Omit for models with unknown
   * or $0 (local/keyless) pricing — unknown pricing must render "cost unavailable", never $0.
   */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  /**
   * Authoritative per-model reasoning controls when the provider publishes
   * them. The UI and request boundary both enforce these values so a
   * provider-wide saved setting cannot become an invalid model request.
   */
  reasoning?: {
    defaultEffort?: OpenAiReasoningEffort;
    mandatory: boolean;
    supportedEfforts: readonly OpenAiReasoningEffort[];
  };
  /**
   * Some providers restrict streaming; surface this so the UI can badge support.
   */
  supportsStreaming?: boolean;
  type: 'llm';
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

export interface ProviderDefinition {
  capabilities: ProviderCapabilities;
  displayName: string;
  /**
   * Environment variable keys (most preferred first) for secret discovery.
   */
  envKeys?: readonly string[];
  id: ProviderId;
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
  | 'local'
  | 'ollama'
  | 'lmstudio';

const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    capabilities: {
      embeddings: true,
      llm: true,
      streaming: true,
    },
    displayName: 'OpenAI',
    // Model IDs per OpenAI docs:
    // https://platform.openai.com/docs/guides/latest-model
    // https://platform.openai.com/docs/models
    envKeys: [
      'BRAINSTRIKE_OPENAI_API_KEY',
      'BS_OPENAI_API_KEY',
      'OPENAI_API_KEY',
      'AI_OPENAI_API_KEY',
      'OPENAI_API_KEY_V1',
      'OPENAI_API_KEY_V2',
    ],
    id: 'openai',
    models: [
      {
        contextWindow: 1_050_000,
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 5, outputPerMTok: 30 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_050_000,
        default: true,
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 2.5, outputPerMTok: 15 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_050_000,
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1, outputPerMTok: 6 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.5-pro',
        label: 'GPT-5.5 Pro',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 15, outputPerMTok: 120 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.4-pro',
        label: 'GPT-5.4 Pro',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 15, outputPerMTok: 120 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 0.25, outputPerMTok: 2 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.4-nano',
        label: 'GPT-5.4 Nano',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 0.05, outputPerMTok: 0.4 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'gpt-5.2-pro',
        label: 'GPT-5.2 Pro',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 15, outputPerMTok: 120 },
        supportsStreaming: true,
        type: 'llm',
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
    capabilities: {
      embeddings: false,
      llm: true,
      streaming: true,
    },
    displayName: 'Anthropic',
    // Model aliases per Anthropic docs:
    // https://www.anthropic.com/claude/sonnet
    // https://www.anthropic.com/claude/haiku
    // https://www.anthropic.com/claude/opus
    envKeys: ['ANTHROPIC_API_KEY', 'AI_ANTHROPIC_API_KEY'],
    id: 'anthropic',
    models: [
      {
        contextWindow: 1_000_000,
        id: 'claude-fable-5',
        label: 'Claude Fable 5',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 10, outputPerMTok: 50 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 200_000,
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 5, outputPerMTok: 25 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_000_000,
        default: true,
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        maxOutputTokens: 128_000,
        // Anthropic introductory rate through 2026-08-31.
        pricing: { inputPerMTok: 2, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 200_000,
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 200_000,
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 1, outputPerMTok: 5 },
        supportsStreaming: true,
        type: 'llm',
      },
    ],
    runtime: 'hosted',
  },
  {
    capabilities: {
      embeddings: true,
      llm: true,
      streaming: true,
    },
    displayName: 'Google AI Studio',
    // Gemini 3 model IDs + embeddings docs:
    // https://ai.google.dev/gemini-api/docs/gemini-3
    // https://ai.google.dev/gemini-api/docs/embeddings
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
    id: 'google',
    models: [
      {
        contextWindow: 1_048_576,
        default: true,
        id: 'gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro (Preview)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 2, outputPerMTok: 12 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-3.1-flash-lite',
        label: 'Gemini 3.1 Flash Lite',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash Lite',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
        supportsStreaming: true,
        type: 'llm',
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
    capabilities: {
      embeddings: false,
      llm: true,
      streaming: true,
    },
    displayName: 'OpenRouter',
    // OpenRouter uses provider-prefixed model slugs (examples in docs):
    // https://openrouter.ai/docs/guides/routing/auto-model-selection
    envKeys: ['OPENROUTER_API_KEY', 'AI_OPENROUTER_API_KEY'],
    id: 'openrouter',
    // Curated current subset from OpenRouter's model catalog. Provider-reported
    // billed cost is authoritative at runtime; these rates are display estimates.
    models: [
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
      },
      {
        contextWindow: 1_048_576,
        id: 'moonshotai/kimi-k3',
        label: 'Kimi K3 (OpenRouter)',
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        reasoning: {
          defaultEffort: 'max',
          mandatory: true,
          supportedEfforts: ['max'],
        },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_050_000,
        id: 'openai/gpt-5.6-sol',
        label: 'GPT-5.6 Sol (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 5, outputPerMTok: 30 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_050_000,
        default: true,
        id: 'openai/gpt-5.6-terra',
        label: 'GPT-5.6 Terra (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 2.5, outputPerMTok: 15 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_050_000,
        id: 'openai/gpt-5.6-luna',
        label: 'GPT-5.6 Luna (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1, outputPerMTok: 6 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_000_000,
        id: 'anthropic/claude-fable-5',
        label: 'Claude Fable 5 (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 10, outputPerMTok: 50 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_000_000,
        id: 'anthropic/claude-sonnet-5',
        label: 'Claude Sonnet 5 (OpenRouter)',
        maxOutputTokens: 128_000,
        // OpenRouter currently reflects Anthropic's introductory rate.
        pricing: { inputPerMTok: 2, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'z-ai/glm-5.2',
        label: 'GLM-5.2 (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.9282, outputPerMTok: 2.9172 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'minimax/minimax-m3',
        label: 'MiniMax M3 (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro (OpenRouter)',
        maxOutputTokens: 384_000,
        pricing: { inputPerMTok: 0.435, outputPerMTok: 0.87 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'deepseek/deepseek-v4-flash',
        label: 'DeepSeek V4 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.09, outputPerMTok: 0.18 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.7-max',
        label: 'Qwen3.7 Max (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 3.75 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.7-plus',
        label: 'Qwen3.7 Plus (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.32, outputPerMTok: 1.28 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.6-flash',
        label: 'Qwen3.6 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.1875, outputPerMTok: 1.125 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 262_144,
        id: 'qwen/qwen3-coder-next',
        label: 'Qwen3 Coder Next (OpenRouter)',
        pricing: { inputPerMTok: 0.11, outputPerMTok: 0.8 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 262_144,
        id: 'moonshotai/kimi-k2.6',
        label: 'Kimi K2.6 (OpenRouter)',
        pricing: { inputPerMTok: 0.66, outputPerMTok: 3.41 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 262_144,
        id: 'moonshotai/kimi-k2.7-code',
        label: 'Kimi K2.7 Code (OpenRouter)',
        pricing: { inputPerMTok: 0.719, outputPerMTok: 3.49 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.5',
        label: 'GPT-5.5 (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.4',
        label: 'GPT-5.4 (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.4-mini',
        label: 'GPT-5.4 Mini (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 0.25, outputPerMTok: 2 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.3-codex',
        label: 'GPT-5.3 Codex (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 400_000,
        id: 'openai/gpt-5.2',
        label: 'GPT-5.2 (OpenRouter)',
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 200_000,
        id: 'anthropic/claude-opus-4.8',
        label: 'Claude Opus 4.8 (OpenRouter)',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 5, outputPerMTok: 25 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 200_000,
        id: 'anthropic/claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6 (OpenRouter)',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 200_000,
        id: 'anthropic/claude-haiku-4.5',
        label: 'Claude Haiku 4.5 (OpenRouter)',
        maxOutputTokens: 64_000,
        pricing: { inputPerMTok: 1, outputPerMTok: 5 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'google/gemini-3.5-flash',
        label: 'Gemini 3.5 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'google/gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 2, outputPerMTok: 12 },
        supportsStreaming: true,
        type: 'llm',
      },
      {
        contextWindow: 1_048_576,
        id: 'google/gemini-2.5-flash',
        label: 'Gemini 2.5 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        type: 'llm',
      },
    ],
    runtime: 'gateway',
  },
  {
    capabilities: {
      embeddings: true,
      llm: false,
      streaming: false,
    },
    displayName: 'Cohere',
    envKeys: ['COHERE_API_KEY', 'AI_COHERE_API_KEY'],
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
    capabilities: {
      embeddings: true,
      llm: false,
      streaming: false,
    },
    displayName: 'Voyage AI',
    envKeys: ['VOYAGE_API_KEY', 'AI_VOYAGE_API_KEY'],
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
        type: 'llm',
      },
    ],
    runtime: 'browser',
  },
  {
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

export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDER_DEFINITIONS;
}

export function getProviderDefinition(provider: ProviderId): ProviderDefinition {
  return PROVIDER_BY_ID[provider];
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
export function getLlmModelDefinition(providerId: ProviderId, modelId: string): LlmModelDefinition {
  // O(1) map lookup; the type says it can't miss, but guard against
  // out-of-union runtime ids (e.g. persisted prefs from an older build).
  const provider: ProviderDefinition | undefined = getProviderDefinition(providerId);
  if (!provider) {
    throw new Error(`Unknown provider id for LLM model lookup: ${providerId}`);
  }
  const model = provider.models.find(
    (definition) => definition.type === 'llm' && definition.id === modelId
  );
  if (model?.type !== 'llm') {
    throw new Error(`Unknown LLM model id for provider ${providerId}: ${modelId}`);
  }
  return model;
}
