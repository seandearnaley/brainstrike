import type { IDatabase } from '@brainstrike/db';
import { decodeCatalogEmbeddingFacts } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import type { ModelConfig } from '../types.js';

const modelConfigLogger = createLogger('EmbeddingWorkerModelConfig');

/**
 * Raw model row from the database.
 */
interface DbModelRow {
  capabilities: string | { type: string; defaultDimension?: number } | null;
  description: string | null;
  id: string;
  name: string;
  parameters: string | { size?: string; contextWindow?: number } | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  provider_id: string;
}

const dbModelConfigCache = new Map<string, ModelConfig | null>();

/**
 * Invalidate cached model configs.
 * Passing a modelId clears just that entry; omitting clears everything.
 */
export function invalidateModelConfigCache(modelId?: string): void {
  if (modelId) {
    dbModelConfigCache.delete(modelId);
    return;
  }
  dbModelConfigCache.clear();
}

function parseCapabilities(raw: DbModelRow['capabilities']): {
  type?: string;
  defaultDimension?: number;
} {
  if (!raw) {
    return {};
  }
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const type = typeof value?.type === 'string' ? value.type : undefined;
    const defaultDimension =
      typeof value?.defaultDimension === 'number' ? value.defaultDimension : undefined;
    const result: { type?: string; defaultDimension?: number } = {};
    if (type !== undefined) {
      result.type = type;
    }
    if (defaultDimension !== undefined) {
      result.defaultDimension = defaultDimension;
    }
    return result;
  } catch (error) {
    modelConfigLogger.warn('parseCapabilities: failed to parse capabilities JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function parseParameters(raw: DbModelRow['parameters']): {
  size?: string;
  contextWindow?: number;
} {
  if (!raw) {
    return {};
  }
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const size = typeof value?.size === 'string' ? value.size : undefined;
    const contextWindow =
      typeof value?.contextWindow === 'number' ? value.contextWindow : undefined;
    const result: { size?: string; contextWindow?: number } = {};
    if (size !== undefined) {
      result.size = size;
    }
    if (contextWindow !== undefined) {
      result.contextWindow = contextWindow;
    }
    return result;
  } catch (error) {
    modelConfigLogger.warn('parseParameters: failed to parse parameters JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Query the database for model configuration.
 * This is the primary source of truth for model metadata.
 */
export async function getModelConfigFromDb(
  db: IDatabase,
  modelId: string
): Promise<ModelConfig | null> {
  modelConfigLogger.debug('getModelConfigFromDb: looking up model', { modelId });

  const cached = dbModelConfigCache.get(modelId);
  if (cached !== undefined) {
    modelConfigLogger.debug('getModelConfigFromDb: cache hit', { found: !!cached, modelId });
    return cached;
  }

  let row: DbModelRow | undefined;
  try {
    const result = await db.query<DbModelRow>(
      'SELECT id, provider_id, name, description, capabilities, parameters FROM models WHERE id = $1',
      [modelId]
    );
    row = result.rows[0];
  } catch (error) {
    modelConfigLogger.error('getModelConfigFromDb: QUERY FAILED', {
      error: error instanceof Error ? error.message : String(error),
      modelId,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
  if (!row) {
    modelConfigLogger.warn('getModelConfigFromDb: model not found in database', { modelId });
    dbModelConfigCache.set(modelId, null);
    return null;
  }
  // BST-1993: stated pooling and prompts are properties of the model; malformed ones refuse.
  const { pooling, prompts } = decodeCatalogEmbeddingFacts(row.capabilities, modelId);
  const capabilities = parseCapabilities(row.capabilities);
  const parameters = parseParameters(row.parameters);

  const modelConfig: ModelConfig = {
    description: row.description ?? '',
    dimensions: capabilities.defaultDimension ?? DEFAULT_EMBEDDING_DIMENSION,
    id: row.id,
    name: row.name,
    origin: row.provider_id,
    quantized: false,
    tags: [row.provider_id, capabilities.type ?? 'embedding'].filter(Boolean),
    ...(parameters.size === undefined ? {} : { size: parameters.size }),
    ...(parameters.contextWindow === undefined ? {} : { contextWindow: parameters.contextWindow }),
    ...(pooling === undefined ? {} : { pooling }),
    ...(prompts === undefined ? {} : { prompts }),
  };

  dbModelConfigCache.set(modelId, modelConfig);
  return modelConfig;
}

/**
 * Clear the model config cache.
 */
export function clearModelConfigCache(): void {
  dbModelConfigCache.clear();
}
