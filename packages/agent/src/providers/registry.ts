import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';

export const STANDARD_EMBEDDING_DIMENSION = DEFAULT_EMBEDDING_DIMENSION;

export type ProviderRuntime = 'hosted' | 'gateway' | 'local' | 'browser';

export type ProviderModelType = 'llm' | 'embedding';

export interface ProviderCapabilities {
  llm: boolean;
  embeddings: boolean;
  streaming: boolean;
}

interface BaseModelDefinition {
  /**
   * Provider-specific model identifier (as accepted by the upstream API).
   */
  id: string;
  /**
   * Optional human-friendly label when the upstream ID is cryptic.
   */
  label?: string;
  /**
   * Flag a sensible default for the given model type.
   */
  default?: boolean;
}

export interface LlmModelDefinition extends BaseModelDefinition {
  type: 'llm';
  /**
   * Some providers restrict streaming; surface this so the UI can badge support.
   */
  supportsStreaming?: boolean;
}

export interface EmbeddingModelDefinition extends BaseModelDefinition {
  type: 'embedding';
  /**
   * Canonical output dimensionality when no overrides are supplied.
   */
  defaultDimension: number;
  /**
   * Known discrete dimensions offered by this model (if fixed).
   */
  availableDimensions?: readonly number[];
  /**
   * Indicates whether the provider exposes a parameter to customise the dimension.
   */
  supportsCustomDimensions?: boolean;
  /**
   * Name of the parameter used to tune embedding dimension. Used by workers.
   */
  dimensionParameter?: 'dimensions' | 'output_dimensionality' | 'output_dimension';
  /**
   * Whether the model can natively (or via parameterisation) produce the project
   * standard 768 dimensional vectors.
   */
  supportsStandardDimension: boolean;
}

export type ProviderModelDefinition = LlmModelDefinition | EmbeddingModelDefinition;

export interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  runtime: ProviderRuntime;
  capabilities: ProviderCapabilities;
  /**
   * Ordered list of models covering both chat and embeddings.
   */
  models: readonly ProviderModelDefinition[];
  /**
   * Environment variable keys (most preferred first) for secret discovery.
   */
  envKeys?: readonly string[];
}

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'cohere'
  | 'voyage'
  | 'local';

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
        id: 'gpt-4o-mini',
        type: 'llm',
        default: true,
        supportsStreaming: true,
      },
      { id: 'gpt-4o', type: 'llm', supportsStreaming: true },
      { id: 'gpt-4-turbo', type: 'llm', supportsStreaming: true },
      { id: 'gpt-3.5-turbo', type: 'llm', supportsStreaming: true },
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
    envKeys: ['ANTHROPIC_API_KEY', 'AI_ANTHROPIC_API_KEY'],
    models: [
      {
        id: 'claude-3-5-haiku-latest',
        type: 'llm',
        default: true,
        supportsStreaming: true,
      },
      { id: 'claude-3-5-sonnet-latest', type: 'llm', supportsStreaming: true },
      { id: 'claude-3-opus-latest', type: 'llm', supportsStreaming: true },
    ],
  },
  {
    id: 'google',
    displayName: 'Google',
    runtime: 'hosted',
    capabilities: {
      llm: true,
      embeddings: true,
      streaming: true,
    },
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
    models: [
      {
        id: 'gemini-2.5-flash',
        type: 'llm',
        default: true,
        supportsStreaming: true,
      },
      { id: 'gemini-2.0-pro', type: 'llm', supportsStreaming: true },
      { id: 'gemini-1.5-pro', type: 'llm', supportsStreaming: true },
      {
        id: 'text-embedding-004',
        type: 'embedding',
        default: true,
        defaultDimension: 768,
        availableDimensions: [768],
        supportsStandardDimension: true,
        dimensionParameter: 'output_dimensionality',
      },
      {
        id: 'gemini-embedding-001',
        type: 'embedding',
        defaultDimension: 3072,
        supportsCustomDimensions: true,
        dimensionParameter: 'output_dimensionality',
        supportsStandardDimension: true,
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
    envKeys: ['OPENROUTER_API_KEY', 'AI_OPENROUTER_API_KEY'],
    models: [
      {
        id: 'gpt-4o-mini',
        type: 'llm',
        default: true,
        supportsStreaming: true,
      },
      { id: 'gpt-4o', type: 'llm', supportsStreaming: true },
      { id: 'claude-3-5-sonnet', type: 'llm', supportsStreaming: true },
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
        // LFM2.5 is a general-purpose chat model - good default
        id: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
        label: 'LFM2.5 1.2B',
        type: 'llm',
        default: true,
        supportsStreaming: false,
      },
      {
        // FunctionGemma is for function/tool calling only, NOT general chat
        id: 'onnx-community/functiongemma-270m-it-ONNX',
        label: 'FunctionGemma 270M (Tool Calling)',
        type: 'llm',
        supportsStreaming: false,
      },
      {
        id: 'onnx-community/Qwen3-0.6B-ONNX',
        label: 'Qwen3 0.6B',
        type: 'llm',
        supportsStreaming: false,
      },
      // NOTE: Qwen3-1.7B removed - crashes due to WebGPU buffer size limits
      // See: https://github.com/huggingface/transformers.js/issues/1469
    ],
  },
];

const PROVIDER_BY_ID: Record<ProviderId, ProviderDefinition> = PROVIDER_DEFINITIONS.reduce(
  (acc, provider) => {
    acc[provider.id] = provider;
    return acc;
  },
  {} as Record<ProviderId, ProviderDefinition>
);

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
