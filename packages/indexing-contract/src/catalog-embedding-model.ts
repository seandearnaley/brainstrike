import type { EmbeddingDType, EmbeddingPooling } from './embedding-worker-protocol.js';

/**
 * The text a model's card says to put before a query and before a document.
 * Stated by the catalog row; a row stating none (or no prompts) embeds raw text.
 */
export interface EmbeddingPrompts {
  readonly document: string;
  readonly query: string;
}

/** A catalog row's statement that its model takes no prompts. */
export const NO_PROMPTS: EmbeddingPrompts = Object.freeze({ document: '', query: '' });

/** Decode a stated prompt pair; none (absent or both empty) is undefined, malformed refuses. */
export function decodeEmbeddingPrompts(
  value: unknown,
  modelId: string
): EmbeddingPrompts | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) {
    throw new Error(`Catalog embedding model ${modelId} states malformed prompts.`);
  }
  const query: unknown = Reflect.get(value, 'query');
  const document: unknown = Reflect.get(value, 'document');
  if (typeof query !== 'string' || typeof document !== 'string') {
    throw new Error(`Catalog embedding model ${modelId} states malformed prompts.`);
  }
  return query === '' && document === '' ? undefined : { document, query };
}

/**
 * The catalog facts that change a local model's vectors, from its row's
 * capabilities: pooling (absent means mean) and prompts (absent means none).
 * Every model-config builder reads them through this one decoder.
 */
export function decodeCatalogEmbeddingFacts(
  capabilities: unknown,
  modelId: string
): { readonly pooling?: EmbeddingPooling; readonly prompts?: EmbeddingPrompts } {
  const value: unknown = typeof capabilities === 'string' ? JSON.parse(capabilities) : capabilities;
  const read = (key: string): unknown =>
    value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
  const pooling = read('pooling');
  if (!(pooling === undefined || pooling === 'mean' || pooling === 'cls')) {
    throw new Error(`Catalog embedding model ${modelId} states an unsupported pooling.`);
  }
  const prompts = decodeEmbeddingPrompts(read('prompts'), modelId);
  return {
    ...(pooling === undefined ? {} : { pooling }),
    ...(prompts === undefined ? {} : { prompts }),
  };
}

/** The execution dtype a catalog row states for each device. */
export type CatalogEmbeddingExecution = Partial<Record<'webgpu' | 'wasm', EmbeddingDType>>;
/**
 * A local catalog model as its `models` row states it: the one owner of the
 * model's pooling, prompts, pinned revision and per-device execution dtype (BST-1993).
 */
export interface CatalogEmbeddingModel {
  readonly contextWindow?: number;
  readonly dimensions: number;
  readonly execution?: CatalogEmbeddingExecution;
  readonly id: string;
  readonly pooling?: EmbeddingPooling;
  /** What the card says to prepend; a row must state them, none being two empty strings. */
  readonly prompts: EmbeddingPrompts;
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
  if (capabilities['prompts'] === undefined) {
    throw new Error(`Catalog embedding model ${row.id} states no prompts.`);
  }
  const prompts = decodeEmbeddingPrompts(capabilities['prompts'], row.id) ?? NO_PROMPTS;
  return {
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    dimensions,
    ...(devices ? { execution: devices as CatalogEmbeddingExecution } : {}),
    id: row.id,
    ...(pooling === undefined ? {} : { pooling }),
    prompts,
    ...(revision === undefined ? {} : { revision }),
  };
}
