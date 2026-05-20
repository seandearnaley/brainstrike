import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';

export const STANDARD_EMBEDDING_DIMENSION = DEFAULT_EMBEDDING_DIMENSION;

export type EmbeddingDevice = 'webgpu' | 'wasm';

export type EmbeddingDeviceHint = EmbeddingDevice;

export type EmbeddingDType = 'fp16' | 'q4' | 'fp32';

export type EmbeddingDimensionParameter =
  | 'dimensions'
  | 'output_dimensionality'
  | 'output_dimension';

export type EmbeddingProviderType =
  | 'local'
  | 'transformers'
  | 'openai'
  | 'google'
  | 'cohere'
  | 'voyage'
  | 'ollama'
  | 'lmstudio';

export type LocalProviderType = 'local' | 'transformers';

export type HostedProviderType = Exclude<EmbeddingProviderType, LocalProviderType>;

export type EmbeddingRuntime = 'browser' | 'hosted';

export type DistanceMetric = 'cosine' | 'l2' | 'ip';

export type ProviderDimensionParameter = EmbeddingDimensionParameter;

export interface EmbeddingModelConfig {
  contextWindow?: number;
  description: string;
  dimensions: number;
  id: string;
  name: string;
  origin?: string;
  pricePer1MTokens?: number;
  quantized?: boolean;
  size?: string;
  supportedDimensions?: number[] | string;
  tags: string[];
}

export interface ProviderMetadata {
  contextWindow?: number;
  dimensions: number;
  displayName?: string;
  distance: DistanceMetric;
  modelKey: string;
  providerId: EmbeddingProviderType;
}

interface BaseEmbeddingModelDefinition {
  default?: boolean;
  id: string;
  label?: string;
  type: 'embedding';
}

export interface EmbeddingModelDefinition extends BaseEmbeddingModelDefinition {
  availableDimensions?: readonly number[];
  defaultDimension: number;
  dimensionParameter?: EmbeddingDimensionParameter;
  supportsCustomDimensions?: boolean;
  supportsStandardDimension: boolean;
}

export interface EmbeddingProviderDefinition {
  displayName: string;
  envKeys?: readonly string[];
  id: EmbeddingProviderType;
  models: readonly EmbeddingModelDefinition[];
  runtime: EmbeddingRuntime;
}

export interface ParsedEmbeddingProviderModel {
  modelId: string;
  provider: EmbeddingProviderType;
}

const PROVIDER_SEPARATOR = '::';
const LEGACY_PROVIDER_SEPARATOR = ':';

const NO_API_KEY_HOSTED_PROVIDERS: ReadonlySet<HostedProviderType> = new Set([
  'ollama',
  'lmstudio',
]);

const EMBEDDING_PROVIDER_DEFINITIONS: readonly EmbeddingProviderDefinition[] = [
  {
    id: 'local',
    displayName: 'Local (Browser)',
    runtime: 'browser',
    models: [],
  },
  {
    id: 'transformers',
    displayName: 'Transformers.js',
    runtime: 'browser',
    models: [],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    runtime: 'hosted',
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
    id: 'google',
    displayName: 'Google AI Studio',
    runtime: 'hosted',
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
    models: [
      {
        id: 'gemini-embedding-001',
        type: 'embedding',
        default: true,
        defaultDimension: 3072,
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        dimensionParameter: 'output_dimensionality',
      },
    ],
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    runtime: 'hosted',
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
    id: 'ollama',
    displayName: 'Ollama (Local Runtime)',
    runtime: 'hosted',
    models: [],
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio (Local Runtime)',
    runtime: 'hosted',
    models: [],
  },
];

const EMBEDDING_PROVIDER_BY_ID = Object.fromEntries(
  EMBEDDING_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
) as Record<EmbeddingProviderType, EmbeddingProviderDefinition>;

export function listEmbeddingProviderDefinitions(): readonly EmbeddingProviderDefinition[] {
  return EMBEDDING_PROVIDER_DEFINITIONS;
}

export function getEmbeddingProviderDefinition(
  provider: EmbeddingProviderType
): EmbeddingProviderDefinition {
  return EMBEDDING_PROVIDER_BY_ID[provider];
}

export function isLocalProviderType(
  provider: EmbeddingProviderType
): provider is LocalProviderType {
  return provider === 'local' || provider === 'transformers';
}

export function isHostedProvider(provider: EmbeddingProviderType): provider is HostedProviderType {
  return !isLocalProviderType(provider);
}

export function hostedProviderRequiresApiKey(provider: HostedProviderType): boolean {
  return !NO_API_KEY_HOSTED_PROVIDERS.has(provider);
}

export function formatEmbeddingProviderModelKey(
  provider: EmbeddingProviderType,
  modelId: string
): string {
  return `${provider}${PROVIDER_SEPARATOR}${modelId}`;
}

export function parseEmbeddingProviderModelKey(
  composite: string | null | undefined
): ParsedEmbeddingProviderModel | null {
  if (!composite) {
    return null;
  }

  if (composite.includes(PROVIDER_SEPARATOR)) {
    const separatorIndex = composite.indexOf(PROVIDER_SEPARATOR);
    const provider = composite.slice(0, separatorIndex).trim();
    const modelId = composite.slice(separatorIndex + PROVIDER_SEPARATOR.length).trim();
    if (!(provider && modelId && provider in EMBEDDING_PROVIDER_BY_ID)) {
      return null;
    }
    return {
      provider: provider as EmbeddingProviderType,
      modelId,
    };
  }

  const legacyIndex = composite.indexOf(LEGACY_PROVIDER_SEPARATOR);
  if (legacyIndex > 0 && legacyIndex < composite.length - 1) {
    const provider = composite.slice(0, legacyIndex).trim();
    const modelId = composite.slice(legacyIndex + LEGACY_PROVIDER_SEPARATOR.length).trim();
    if (!(provider && modelId && provider in EMBEDDING_PROVIDER_BY_ID)) {
      return null;
    }
    return {
      provider: provider as EmbeddingProviderType,
      modelId,
    };
  }

  return null;
}

export function canonicalizeEmbeddingProviderModelKey(
  modelKey: string | null | undefined,
  providerHint?: EmbeddingProviderType
): { provider: EmbeddingProviderType; modelId: string; composite: string } | null {
  const parsed = parseEmbeddingProviderModelKey(modelKey);
  const provider = parsed?.provider ?? providerHint ?? 'local';
  const rawModelId = parsed?.modelId ?? modelKey?.trim() ?? '';
  if (!rawModelId) {
    return null;
  }
  return {
    provider,
    modelId: rawModelId,
    composite: formatEmbeddingProviderModelKey(provider, rawModelId),
  };
}

export interface EmbedWorkerRequest {
  readonly deviceHint: EmbeddingDeviceHint;
  readonly dimensionParameter?: EmbeddingDimensionParameter;
  readonly dtype?: EmbeddingDType;
  readonly id: string;
  readonly maxBatchSize?: number;
  readonly model: string;
  readonly provider?: string;
  readonly targetDimension?: number;
  readonly texts: readonly string[];
  readonly truncateDim?: number;
  readonly type: 'embed';
}

export interface EmbedWorkerProgress {
  readonly id: string;
  readonly phase: 'initializing' | 'embedding' | 'complete';
  readonly progress: number;
  readonly type: 'progress';
}

export interface EmbedWorkerBatch {
  readonly batchIndex: number;
  readonly endIndex: number;
  readonly id: string;
  readonly startIndex: number;
  readonly type: 'batch';
  readonly vectors: readonly Float32Array[];
}

export interface EmbedWorkerSuccess {
  readonly id: string;
  readonly metadata: {
    readonly model: string;
    readonly device: EmbeddingDevice;
    readonly dtype: EmbeddingDType;
    readonly batchSize: number;
    readonly elapsedMs: number;
    readonly fallbackApplied: boolean;
    readonly dimensions: number;
  };
  readonly type: 'result';
  readonly vectors: readonly Float32Array[];
}

export interface EmbedWorkerError {
  readonly cause?: string | undefined;
  readonly id: string;
  readonly message: string;
  readonly type: 'error';
}

export interface EmbedWorkerComplete {
  readonly id: string;
  readonly metadata: EmbedWorkerSuccess['metadata'];
  readonly type: 'complete';
}

export type EmbedWorkerStreamEvent =
  | EmbedWorkerBatch
  | EmbedWorkerComplete
  | EmbedWorkerError
  | EmbedWorkerProgress;
