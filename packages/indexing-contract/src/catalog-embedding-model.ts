import type { EmbeddingDType, EmbeddingPooling } from './embedding-worker-protocol.js';

/** The execution dtype a catalog row states for each device. */
export type CatalogEmbeddingExecution = Partial<Record<'webgpu' | 'wasm', EmbeddingDType>>;
/**
 * A local catalog model as its `models` row states it: the one owner of the
 * model's pooling, pinned revision and per-device execution dtype (BST-1993).
 */
export interface CatalogEmbeddingModel {
  readonly contextWindow?: number;
  readonly dimensions: number;
  readonly execution?: CatalogEmbeddingExecution;
  readonly id: string;
  readonly pooling?: EmbeddingPooling;
  readonly revision?: string;
}

const REVISION = /^[a-f0-9]{40}$/u;
function isDType(value: unknown): value is EmbeddingDType {
  return value === 'q4' || value === 'q8' || value === 'fp16' || value === 'fp32';
}
function jsonRecord(value: unknown, field: string): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : (value ?? {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Catalog embedding model ${field} must be an object.`);
  }
  return parsed as Record<string, unknown>;
}

/** Decode a local embedding `models` row; a malformed pooling, pin or dtype refuses. */
export function decodeCatalogEmbeddingModel(row: {
  readonly capabilities: unknown;
  readonly id: string;
  readonly parameters: unknown;
}): CatalogEmbeddingModel {
  const capabilities = jsonRecord(row.capabilities, 'capabilities');
  const parameters = jsonRecord(row.parameters, 'parameters');
  const { defaultDimension: dimensions, pooling } = capabilities;
  const { execution, revision } = parameters;
  if (
    !(
      row.id.trim() &&
      typeof dimensions === 'number' &&
      Number.isSafeInteger(dimensions) &&
      dimensions > 0 &&
      dimensions <= 16_000 &&
      (pooling === undefined || pooling === 'mean' || pooling === 'cls') &&
      (revision === undefined || (typeof revision === 'string' && REVISION.test(revision)))
    )
  ) {
    throw new Error(`Catalog embedding model ${row.id} has invalid dimensions, pooling or pins.`);
  }
  const devices = execution === undefined ? undefined : jsonRecord(execution, 'execution');
  if (
    devices &&
    !Object.entries(devices).every(
      ([device, dtype]) => (device === 'webgpu' || device === 'wasm') && isDType(dtype)
    )
  ) {
    throw new Error(`Catalog embedding model ${row.id} has an invalid execution dtype.`);
  }
  const contextWindow = parameters['contextWindow'];
  return {
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    dimensions,
    ...(devices ? { execution: devices as CatalogEmbeddingExecution } : {}),
    id: row.id,
    ...(pooling === undefined ? {} : { pooling }),
    ...(revision === undefined ? {} : { revision }),
  };
}
