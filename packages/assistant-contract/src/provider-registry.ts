import { GEMMA4_E2B_MODEL_ID } from './local-llm.js';

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
    id: 'openai',
    displayName: 'OpenAI',
    runtime: 'hosted',
    capabilities: {
      llm: true,
      embeddings: true,
      streaming: true,
    },
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
    models: [
      {
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        type: 'llm',
        default: true,
        supportsStreaming: true,
      },
      {
        id: 'gpt-5.2-chat-latest',
        label: 'GPT-5.2 Chat (Latest)',
        type: 'llm',
        supportsStreaming: true,
      },
      {
        id: 'gpt-5.2-pro',
        label: 'GPT-5.2 Pro',
        type: 'llm',
        supportsStreaming: true,
      },
      {
        id: 'text-embedding-3-small',
        type: 'embedding',
        default: true,
        defaultDimension: 1536,
        supportsCustomDimensions: true,
        dimensionParameter: 'dimensions',
        supportsStandardDimension: true,
      },
      {
        id: 'text-embedding-3-large',
        type: 'embedding',
        defaultDimension: 3072,
        supportsCustomDimensions: true,
        dimensionParameter: 'dimensions',
        supportsStandardDimension: true,
      },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    runtime: 'hosted',
    capabilities: {
      llm: true,
      embeddings: false,
      streaming: true,
    },
    // Model aliases per Anthropic docs:
    // https://www.anthropic.com/claude/sonnet
    // https://www.anthropic.com/claude/haiku
    // https://www.anthropic.com/claude/opus
    envKeys: ['ANTHROPIC_API_KEY', 'AI_ANTHROPIC_API_KEY'],
    models: [
      {
        id: 'claude-sonnet-4-5',
        label: 'Claude Sonnet 4.5',
        type: 'llm',
        default: true,
        supportsStreaming: true,
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        type: 'llm',
        supportsStreaming: true,
      },
      {
        id: 'claude-opus-4-5',
        label: 'Claude Opus 4.5',
        type: 'llm',
        supportsStreaming: true,
      },
    ],
  },
  {
    id: 'google',
    displayName: 'Google AI Studio',
    runtime: 'hosted',
    capabilities: {
      llm: true,
      embeddings: true,
      streaming: true,
    },
    // Gemini 3 model IDs + embeddings docs:
    // https://ai.google.dev/gemini-api/docs/gemini-3
    // https://ai.google.dev/gemini-api/docs/embeddings
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
    models: [
      {
        id: 'gemini-3-flash-preview',
        label: 'Gemini 3 Flash (Preview)',
        type: 'llm',
        default: true,
        supportsStreaming: true,
      },
      {
        id: 'gemini-3-pro-preview',
        label: 'Gemini 3 Pro (Preview)',
        type: 'llm',
        supportsStreaming: true,
      },
      {
        id: 'gemini-embedding-001',
        type: 'embedding',
        default: true,
        defaultDimension: 3072,
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        // Gemini embeddings use outputDimensionality in JSON; this value is a UI hint.
        dimensionParameter: 'output_dimensionality',
      },
    ],
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    runtime: 'gateway',
    capabilities: {
      llm: true,
      embeddings: false,
      streaming: true,
    },
    // OpenRouter uses provider-prefixed model slugs (examples in docs):
    // https://openrouter.ai/docs/guides/routing/auto-model-selection
    envKeys: ['OPENROUTER_API_KEY', 'AI_OPENROUTER_API_KEY'],
    models: [
      {
        id: 'openai/gpt-5.2',
        label: 'GPT-5.2 (OpenRouter)',
        type: 'llm',
        default: true,
        supportsStreaming: true,
      },
      {
        id: 'anthropic/claude-sonnet-4.5',
        label: 'Claude Sonnet 4.5 (OpenRouter)',
        type: 'llm',
        supportsStreaming: true,
      },
      {
        id: 'google/gemini-3-flash-preview',
        label: 'Gemini 3 Flash (OpenRouter)',
        type: 'llm',
        supportsStreaming: true,
      },
    ],
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    runtime: 'hosted',
    capabilities: {
      llm: false,
      embeddings: true,
      streaming: false,
    },
    envKeys: ['COHERE_API_KEY', 'AI_COHERE_API_KEY'],
    models: [
      {
        id: 'embed-english-v3.0',
        type: 'embedding',
        default: true,
        defaultDimension: 1024,
        availableDimensions: [1024],
        supportsStandardDimension: true,
      },
      {
        id: 'embed-multilingual-v3.0',
        type: 'embedding',
        defaultDimension: 1024,
        availableDimensions: [1024],
        supportsStandardDimension: true,
      },
    ],
  },
  {
    id: 'voyage',
    displayName: 'Voyage AI',
    runtime: 'hosted',
    capabilities: {
      llm: false,
      embeddings: true,
      streaming: false,
    },
    envKeys: ['VOYAGE_API_KEY', 'AI_VOYAGE_API_KEY'],
    models: [
      {
        id: 'voyage-3',
        type: 'embedding',
        default: true,
        defaultDimension: 1024,
        availableDimensions: [1024],
        supportsStandardDimension: true,
      },
      {
        id: 'voyage-3-lite',
        type: 'embedding',
        defaultDimension: 512,
        availableDimensions: [512],
        supportsStandardDimension: false,
      },
    ],
  },
  {
    id: 'local',
    displayName: 'Local (Browser)',
    runtime: 'browser',
    capabilities: {
      llm: true,
      embeddings: false,
      streaming: false, // transformers.js generate() is not streaming
    },
    models: [
      {
        id: GEMMA4_E2B_MODEL_ID,
        label: 'Gemma 4 E2B',
        type: 'llm',
        default: true,
        supportsStreaming: false,
      },
    ],
  },
  {
    id: 'ollama',
    displayName: 'Ollama (Local Runtime)',
    runtime: 'local',
    capabilities: {
      llm: true,
      embeddings: true,
      streaming: true,
    },
    // Runtime models are discovered dynamically from localhost endpoints.
    models: [],
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio (Local Runtime)',
    runtime: 'local',
    capabilities: {
      llm: true,
      embeddings: true,
      streaming: true,
    },
    // Runtime models are discovered dynamically from localhost endpoints.
    models: [],
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
