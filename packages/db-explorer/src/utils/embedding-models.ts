import { isHostedProvider, type ModelConfig, parseProviderModelKey } from '@brainstrike/embeddings';
import type { DbModel } from '@brainstrike/preferences';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';

const LOCAL_PROVIDER_IDS = new Set<string>(['local', 'transformers']);

type ModelParameters = Record<string, unknown> | null | undefined;

type ModelMetadata = {
  size?: string;
  contextWindow?: number;
};

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

export function isLocalProviderId(providerId: string): boolean {
  return LOCAL_PROVIDER_IDS.has(providerId);
}

export function isEmbeddingModel(model: DbModel): boolean {
  return model.capabilities.type === 'embedding';
}

export function toEmbeddingModelConfig(model: DbModel): ModelConfig {
  const dimensions = model.capabilities.defaultDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  const tags = Array.isArray(model.bestFor) ? model.bestFor : [];
  const description = model.description ?? model.tagline ?? '';
  const metadata = readModelMetadata(model.parameters);

  return {
    id: model.id,
    name: model.name,
    dimensions,
    quantized: false,
    description,
    tags,
    origin: model.providerId,
    ...(metadata.size ? { size: metadata.size } : {}),
    ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow } : {}),
  };
}

export function getLocalEmbeddingModels(models: DbModel[]): DbModel[] {
  return models
    .filter((model) => isEmbeddingModel(model) && isLocalProviderId(model.providerId))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getEmbeddingsPanelModels(models: DbModel[]): DbModel[] {
  const local = getLocalEmbeddingModels(models);
  const enabled = local.filter((model) => model.isEnabled);
  return enabled.length > 0 ? enabled : local;
}

export function getDefaultLocalEmbeddingModel(models: DbModel[]): DbModel | null {
  const candidates = getEmbeddingsPanelModels(models);
  return candidates[0] ?? null;
}

export function buildLocalEmbeddingModelConfigMap(models: DbModel[]): Map<string, ModelConfig> {
  const map = new Map<string, ModelConfig>();
  for (const model of getLocalEmbeddingModels(models)) {
    map.set(model.id, toEmbeddingModelConfig(model));
  }
  return map;
}

export type EffectiveModelInfo = {
  modelKey: string;
  dimensions: number;
  modelConfig?: ModelConfig;
};

type EmbeddingSetRow = {
  modelKey: string;
  dimensions: number;
};

export function resolveEmbeddingSetModelInfo(
  row: EmbeddingSetRow,
  modelConfigMap: Map<string, ModelConfig>,
  fallback: EffectiveModelInfo
): EffectiveModelInfo {
  const dimensions = Number(row.dimensions) || fallback.dimensions;
  const parsed = parseProviderModelKey(row.modelKey);
  if (parsed && isHostedProvider(parsed.provider)) {
    return { modelKey: row.modelKey, dimensions };
  }

  const localModelId = parsed?.modelId ?? row.modelKey;
  const localConfig = modelConfigMap.get(localModelId) ?? fallback.modelConfig;
  if (localConfig) {
    return {
      modelKey: localConfig.id,
      dimensions: localConfig.dimensions || dimensions,
      modelConfig: localConfig,
    };
  }

  return { modelKey: localModelId, dimensions };
}
