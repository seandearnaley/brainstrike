import {
  isHostedProvider,
  type EmbeddingModelConfig as ModelConfig,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import type { DbModel } from '@brainstrike/preferences/stores/model-registry-store';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';

const LOCAL_PROVIDER_IDS = new Set<string>(['local', 'transformers']);

type ModelParameters = Record<string, unknown> | null | undefined;

interface ModelMetadata {
  contextWindow?: number;
  size?: string;
}

function readModelMetadata(parameters: ModelParameters): ModelMetadata {
  const metadata: ModelMetadata = {};
  const size = parameters?.['size'];
  if (size !== undefined) {
    metadata.size = typeof size === 'string' ? size : String(size);
  }

  const contextWindow = parameters?.['contextWindow'];
  if (typeof contextWindow === 'number') {
    metadata.contextWindow = contextWindow;
  } else if (typeof contextWindow === 'string') {
    const parsed = Number(contextWindow);
    if (Number.isFinite(parsed)) {
      metadata.contextWindow = parsed;
    }
  }

  return metadata;
}

function readQuantizedFlag(parameters: ModelParameters): boolean {
  const value = parameters?.['quantized'];
  return typeof value === 'boolean' ? value : false;
}

function resolveDimensions(capabilities: DbModel['capabilities'] | null | undefined): number {
  const rawDimension = capabilities?.defaultDimension;
  if (!hasEmbeddingCapabilities(capabilities)) {
    return DEFAULT_EMBEDDING_DIMENSION;
  }
  if (typeof rawDimension !== 'number' || !Number.isFinite(rawDimension) || rawDimension <= 0) {
    return DEFAULT_EMBEDDING_DIMENSION;
  }
  return rawDimension;
}

function readTags(bestFor: DbModel['bestFor']): string[] {
  if (!Array.isArray(bestFor)) {
    return [];
  }
  return bestFor.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0);
}

function hasEmbeddingCapabilities(
  capabilities: unknown
): capabilities is DbModel['capabilities'] & { type: 'embedding' } {
  if (!capabilities || typeof capabilities !== 'object') {
    return false;
  }
  if (!('type' in capabilities)) {
    return false;
  }
  const typeValue = (capabilities as { type?: unknown }).type;
  return typeValue === 'embedding';
}

function sanitizeModelId(value: string): string {
  return value.slice(0, 100).replace(/[^\w\-:./@]/g, '_');
}

export function isLocalProviderId(providerId: string): boolean {
  return LOCAL_PROVIDER_IDS.has(providerId);
}

export function isEmbeddingModel(model: DbModel | null | undefined): model is DbModel {
  if (!model) {
    return false;
  }
  return hasEmbeddingCapabilities(model.capabilities);
}

export function toEmbeddingModelConfig(model: DbModel): ModelConfig {
  const dimensions = resolveDimensions(model.capabilities);
  const tags = readTags(model.bestFor);
  const description = model.description ?? model.tagline ?? '';
  const metadata = readModelMetadata(model.parameters);
  const quantized = readQuantizedFlag(model.parameters);

  return {
    description,
    dimensions,
    id: model.id,
    name: model.name,
    origin: model.providerId,
    quantized,
    tags,
    ...(metadata.size ? { size: metadata.size } : {}),
    ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow } : {}),
  };
}

export function getLocalEmbeddingModels(models: readonly DbModel[] | null | undefined): DbModel[] {
  if (!models || models.length === 0) {
    return [];
  }
  return models
    .filter(
      (model): model is DbModel =>
        isEmbeddingModel(model) &&
        typeof model.providerId === 'string' &&
        isLocalProviderId(model.providerId)
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function buildLocalEmbeddingModelConfigMap(
  models: readonly DbModel[] | null | undefined
): Map<string, ModelConfig> {
  const map = new Map<string, ModelConfig>();
  for (const model of getLocalEmbeddingModels(models).filter((model) => model.isEnabled)) {
    map.set(model.id, toEmbeddingModelConfig(model));
  }
  return map;
}

export interface EffectiveModelInfo {
  dimensions: number;
  modelConfig?: ModelConfig;
  modelKey: string;
}

interface EmbeddingSetRow {
  dimensions: number;
  modelKey: string;
}

export function resolveEmbeddingSetModelInfo(
  row: EmbeddingSetRow,
  modelConfigMap: Map<string, ModelConfig>
): EffectiveModelInfo {
  const modelKey = typeof row.modelKey === 'string' ? row.modelKey.trim() : '';
  if (!modelKey) {
    throw new Error('Embedding set has invalid model key.');
  }

  const dimensions = Number(row.dimensions);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error('Embedding set dimensions are missing or invalid.');
  }
  const parsed = parseEmbeddingProviderModelKey(modelKey);
  if (parsed && isHostedProvider(parsed.provider)) {
    return { dimensions, modelKey };
  }

  const localModelId = parsed?.modelId ?? modelKey;
  const localConfig = modelConfigMap.get(localModelId);
  if (!localConfig) {
    const availableModels = Array.from(modelConfigMap.keys()).join(', ');
    const safeModelId = sanitizeModelId(localModelId);
    throw new Error(
      `Embedding set references unknown model: ${safeModelId}. Available models: ${
        availableModels || 'none'
      }. If the model exists but is disabled, enable it in Settings > Models.`
    );
  }

  if (!Number.isFinite(localConfig.dimensions) || localConfig.dimensions <= 0) {
    throw new Error(`Model ${localModelId} has invalid dimensions in the registry.`);
  }

  if (localConfig.dimensions !== dimensions) {
    throw new Error(
      `Embedding set dimensions (${dimensions}) do not match registry (${localConfig.dimensions}) for ${localModelId}.`
    );
  }

  return {
    dimensions: localConfig.dimensions,
    modelConfig: localConfig,
    modelKey: localConfig.id,
  };
}
