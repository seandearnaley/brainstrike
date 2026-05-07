import type { IDatabase, Job } from '@brainstrike/db';
import {
  JobQueue,
  markCollectionIndexingStatsDirty,
  refreshCollectionIndexingStats,
} from '@brainstrike/db';
import type { ProviderDimensionParameter } from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { createLogger, generateUUID } from '@brainstrike/utils';
import { SimpleEmbeddingService } from '../bge-m3-service';
import { EmbeddingProviderFactory } from '../factory';
import type {
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  EmbeddingProviderType,
  LocalProviderType,
} from '../provider-types';
import { isLocalProviderType } from '../provider-types';
import { formatProviderModelKey, isHostedProvider, parseProviderModelKey } from '../provider-utils';
import type {
  EmbeddingConfig,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStreamBatch,
  ModelConfig,
} from '../types';
import { FALLBACK_MODEL_CONFIG } from '../types';
import { EmbeddingCacheMaintenanceController } from './embedding-cache-maintenance';

/**
 * Interface for embedding cache operations.
 * Allows dependency injection without coupling to the Drizzle implementation.
 * BST-170: Content-level embedding deduplication.
 */
export interface EmbeddingCacheInterface {
  /**
   * Evict stale entries when cache size exceeds its configured cap.
   * Called cooperatively after the embedding queue drains.
   */
  evictIfNeeded?: () => Promise<{ needed: boolean; evicted: number; totalEntries: number }>;

  /**
   * Flush pending LRU access-time updates before worker shutdown.
   */
  flushPendingAccessTimeUpdates?: () => Promise<void>;

  /**
   * Get a cached embedding by content hash and model key.
   * Returns hit: true with the entry if found, or hit: false if not cached.
   */
  get(
    contentHash: string,
    modelKey: string
  ): Promise<{ hit: true; entry: CachedEmbedding } | { hit: false; entry: null }>;

  /**
   * Get multiple cached embeddings in a single query.
   * Returns a Map keyed by "contentHash:modelKey".
   */
  getBatch(
    requests: ReadonlyArray<{ contentHash: string; modelKey: string }>
  ): Promise<Map<string, CachedEmbedding>>;

  /**
   * Return cache diagnostics for worker metrics/log output.
   */
  getStats?: () => Promise<{
    newestAccessedAt: Date | null;
    oldestAccessedAt: Date | null;
    totalEntries: number;
    totalHits: number;
  }>;

  /**
   * Store an embedding in the cache.
   */
  set(
    contentHash: string,
    modelKey: string,
    embedding: number[],
    dimensions: number
  ): Promise<unknown>;

  /**
   * Store multiple embeddings in the cache atomically.
   */
  setBatch(
    entries: ReadonlyArray<{
      contentHash: string;
      modelKey: string;
      embedding: number[];
      dimensions: number;
    }>
  ): Promise<number>;
}

/**
 * Minimal cached embedding entry returned from cache lookups.
 */
export interface CachedEmbedding {
  contentHash: string;
  dimensions: number;
  embedding: number[];
  modelKey: string;
}

const workerLogger = createLogger('EmbeddingWorker');

/**
 * Raw model row from the database
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

/**
 * Cache for database model configs to avoid repeated queries
 */
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

/**
 * Runtime-safe parse helpers for JSONB fields.
 * Avoids throwing on malformed JSON and guards expected shapes.
 */
function parseCapabilities(raw: DbModelRow['capabilities']): {
  type?: string;
  defaultDimension?: number;
} {
  if (!raw) {
    return {};
  }
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const type = typeof value?.['type'] === 'string' ? value['type'] : undefined;
    const defaultDimension =
      typeof value?.['defaultDimension'] === 'number' ? value['defaultDimension'] : undefined;
    const result: { type?: string; defaultDimension?: number } = {};
    if (type !== undefined) {
      result.type = type;
    }
    if (defaultDimension !== undefined) {
      result.defaultDimension = defaultDimension;
    }
    return result;
  } catch (error) {
    workerLogger.warn('parseCapabilities: failed to parse capabilities JSON', {
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
    const size = typeof value?.['size'] === 'string' ? value['size'] : undefined;
    const contextWindow =
      typeof value?.['contextWindow'] === 'number' ? value['contextWindow'] : undefined;
    const result: { size?: string; contextWindow?: number } = {};
    if (size !== undefined) {
      result.size = size;
    }
    if (contextWindow !== undefined) {
      result.contextWindow = contextWindow;
    }
    return result;
  } catch (error) {
    workerLogger.warn('parseParameters: failed to parse parameters JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Query the database for model configuration.
 * This is the primary source of truth for model metadata.
 *
 * @param db - Database connection
 * @param modelId - Model ID to look up (e.g., "Xenova/all-MiniLM-L6-v2")
 * @returns ModelConfig or null if not found
 */
async function getModelConfigFromDb(db: IDatabase, modelId: string): Promise<ModelConfig | null> {
  workerLogger.debug('getModelConfigFromDb: looking up model', { modelId });

  // Check cache first
  const cached = dbModelConfigCache.get(modelId);
  if (cached !== undefined) {
    workerLogger.debug('getModelConfigFromDb: cache hit', { modelId, found: !!cached });
    return cached;
  }

  try {
    const result = await db.query<DbModelRow>(
      'SELECT id, provider_id, name, description, capabilities, parameters FROM models WHERE id = $1',
      [modelId]
    );

    if (result.rows.length === 0) {
      workerLogger.warn('getModelConfigFromDb: model not found in database', { modelId });
      dbModelConfigCache.set(modelId, null);
      return null;
    }

    const row = result.rows[0];
    if (!row) {
      dbModelConfigCache.set(modelId, null);
      return null;
    }

    // Parse JSONB fields with runtime guards
    const capabilities = parseCapabilities(row.capabilities);
    const parameters = parseParameters(row.parameters);

    // Convert DB row to ModelConfig
    const modelConfig: ModelConfig = {
      id: row.id,
      name: row.name,
      dimensions: capabilities?.defaultDimension ?? DEFAULT_EMBEDDING_DIMENSION,
      quantized: false,
      description: row.description ?? '',
      tags: [row.provider_id, capabilities?.type ?? 'embedding'].filter(Boolean),
      origin: row.provider_id,
      ...(parameters?.size === undefined ? {} : { size: parameters.size }),
      ...(parameters?.contextWindow === undefined
        ? {}
        : { contextWindow: parameters.contextWindow }),
    };

    dbModelConfigCache.set(modelId, modelConfig);
    return modelConfig;
  } catch (error) {
    workerLogger.error('getModelConfigFromDb: QUERY FAILED', {
      modelId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Do not cache transient DB failures; allow retry on next call
    return null;
  }
}

/**
 * Clear the model config cache (useful for tests)
 */
export function clearModelConfigCache(): void {
  dbModelConfigCache.clear();
}

class WorkerRateLimitError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'WorkerRateLimitError';
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

type Distance = 'cosine' | 'l2' | 'ip';

type SupportedHostedProvider = Extract<
  EmbeddingProviderType,
  'openai' | 'google' | 'ollama' | 'lmstudio'
>;
type HostedProviderConfig = Extract<
  EmbeddingProviderConfig,
  { runtime: 'hosted'; provider: SupportedHostedProvider }
>;

export interface EmbeddingWorkerOptions {
  cacheDir?: string; // directory to cache/load models from
  /**
   * Maximum number of queue jobs claimed in a single poll iteration.
   * Keep this modest in desktop flows to reduce bursty CPU/memory pressure.
   */
  claimBatchSize?: number;
  concurrency?: number; // default: 1..4
  db: IDatabase;
  device?: 'webgpu' | 'wasm'; // preferred device for transformers backend
  distance?: Distance; // default: 'cosine'
  /** Optional embedding cache for content-level deduplication (BST-170) */
  embeddingCache?: EmbeddingCacheInterface;
  enable?: boolean; // explicit runtime toggle; overrides env flag
  heartbeatIntervalMs?: number; // default: 10000
  /**
   * If false, the worker starts its queue/lease loop without initializing the
   * local embedding model. The first claimed local job must perform the model
   * initialization explicitly.
   */
  initializeLocalModelOnStart?: boolean;
  /**
   * Delay between claimed batches.
   * Use this to deliberately trade throughput for smoother foreground responsiveness.
   */
  interBatchDelayMs?: number;
  leaseMs?: number; // default: 60000
  log?: (msg: string, meta?: unknown) => void;
  metricsIntervalMs?: number; // optional metrics log interval; default env or 30000
  modelKey?: string | undefined; // default: registry default
  now?: () => number;
  onDownloadProgress?: (modelId: string, progress: number) => void;
  onFatalError?: (error: Error) => void;
  onWorkerActivityChange?: (active: boolean) => void;
  queue?: string; // default: 'embeddings'
  reinitEveryN?: number; // reinitialize service every N successes (default disabled unless env/option set)
  /**
   * Optional per-poll effective claim size. The returned value is capped by
   * claimBatchSize so callers can adapt to foreground pressure without
   * bypassing the configured maximum burst size.
   */
  resolveClaimBatchSize?: () => number | Promise<number>;
  service?: EmbeddingService; // optional DI for tests or custom backends
  statsRefreshCompletedChunkThreshold?: number;
  statsRefreshMinIntervalMs?: number;
  /**
   * When true, a fatal local-model initialization/execution error stops the
   * worker loop immediately instead of continuing to claim and fail later jobs.
   * This is intended for desktop hidden-host mode to avoid renderer churn.
   */
  stopOnFatalLocalError?: boolean;
  /** Explicit worker URL for streamed local embedding execution in the renderer host. */
  streamingWorkerUrl?: string;
  waitForBackgroundPermit?: (options: { readonly label: string }) => Promise<void>;
  workerId?: string; // optional
}

export interface EmbeddingWorkerController {
  stop: () => Promise<void>;
}

const DEFAULT_CLAIM_BATCH_SIZE = 50;
const CLAIM_SIZE_RESOLVER_FAILURE_BACKOFF_MS = 1000;
const DEFAULT_STATS_REFRESH_MIN_INTERVAL_MS = 5000;
const DEFAULT_STATS_REFRESH_COMPLETED_CHUNK_THRESHOLD = 512;

export type StatsRefreshReason = 'interval' | 'queue-idle' | 'threshold' | 'worker-stop';

function resolvePositiveIntegerOption(
  value: number | undefined,
  defaultValue: number,
  name: string
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }
  return resolved;
}

export interface EmbeddingStatsRefreshControllerOptions {
  completedChunkThreshold: number;
  db: IDatabase;
  log: (msg: string, meta?: unknown) => void;
  minIntervalMs: number;
  now: () => number;
}

export interface EmbeddingStatsRefreshController {
  flush: (reason: StatsRefreshReason) => Promise<void>;
  flushIfDue: () => Promise<void>;
  recordCompletions: (
    embeddingSetIds: readonly string[],
    completedChunkCount: number
  ) => Promise<void>;
}

export function createEmbeddingStatsRefreshController({
  completedChunkThreshold,
  db,
  log,
  minIntervalMs,
  now,
}: EmbeddingStatsRefreshControllerOptions): EmbeddingStatsRefreshController {
  const pendingEmbeddingSetIds = new Set<string>();
  let completedSinceRefresh = 0;
  let lastRefreshAt = now();
  let flushInFlight: Promise<void> | null = null;

  const flushPending = async (reason: StatsRefreshReason): Promise<void> => {
    if (pendingEmbeddingSetIds.size === 0) {
      return;
    }

    const embeddingSetIds = [...pendingEmbeddingSetIds];
    const completedChunkCount = completedSinceRefresh;
    const startedAt = now();
    pendingEmbeddingSetIds.clear();
    completedSinceRefresh = 0;

    try {
      await refreshCollectionIndexingStats(db, embeddingSetIds, {
        label: 'embedding stats refresh',
        priority: 'background',
      });
      lastRefreshAt = now();
      log('embedding_stats_refresh', {
        completedChunkCount,
        durationMs: Math.round(now() - startedAt),
        embeddingSetCount: embeddingSetIds.length,
        reason,
      });
    } catch (error) {
      for (const embeddingSetId of embeddingSetIds) {
        pendingEmbeddingSetIds.add(embeddingSetId);
      }
      completedSinceRefresh += completedChunkCount;
      throw error;
    }
  };

  const flush = async (reason: StatsRefreshReason): Promise<void> => {
    if (flushInFlight) {
      try {
        await flushInFlight;
      } catch {
        // The in-flight flush restored pending state before rejecting; this caller can retry it.
      }
    }
    const nextFlush = flushPending(reason);
    flushInFlight = nextFlush;
    try {
      await nextFlush;
    } finally {
      if (flushInFlight === nextFlush) {
        flushInFlight = null;
      }
    }
  };

  return {
    flush,
    flushIfDue: async () => {
      if (pendingEmbeddingSetIds.size === 0) {
        return;
      }
      if (completedSinceRefresh >= completedChunkThreshold) {
        await flush('threshold');
        return;
      }
      if (now() - lastRefreshAt >= minIntervalMs) {
        await flush('interval');
      }
    },
    recordCompletions: async (embeddingSetIds, completedChunkCount) => {
      if (embeddingSetIds.length === 0 || completedChunkCount <= 0) {
        return;
      }
      const uniqueIds = [...new Set(embeddingSetIds)];
      const newlyPendingIds = uniqueIds.filter(
        (embeddingSetId) => !pendingEmbeddingSetIds.has(embeddingSetId)
      );
      for (const embeddingSetId of newlyPendingIds) {
        pendingEmbeddingSetIds.add(embeddingSetId);
      }
      completedSinceRefresh += completedChunkCount;
      if (newlyPendingIds.length > 0) {
        await markCollectionIndexingStatsDirty(db, newlyPendingIds, {
          label: 'embedding completion stats dirty',
          priority: 'background',
        });
      }
    },
  };
}

interface EmbedChunkPayload {
  chunkId: string;
  dimensionParameter?: ProviderDimensionParameter | null;
  embeddingSetId?: string | null;
  expectedDimension?: number;
  fileRecordId?: string;
  modelKey?: string | null;
  provider?: EmbeddingProviderType | null;
}

type StreamingEmbeddingService = EmbeddingService & {
  generateEmbeddingsStream: (
    texts: string[],
    onBatch: (batch: EmbeddingStreamBatch) => Promise<void> | void
  ) => Promise<void>;
};

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in the renderer embedding worker.');
  }

  try {
    const data = new TextEncoder().encode(input);
    const digest = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (error) {
    throw new Error(
      `Web Crypto SHA-256 failed in the renderer embedding worker: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function loadChunk(db: IDatabase, id: string) {
  const res = await db.query<{
    id: string;
    content: string;
    contentHash: string;
    embeddingHash?: string | null;
    embeddingSetId?: string | null;
  }>(
    `SELECT id, content, content_hash AS "contentHash", embedding_hash AS "embeddingHash", embedding_set_id AS "embeddingSetId"
     FROM file_chunks WHERE id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

async function loadChunksBatch(db: IDatabase, ids: string[], idType: string) {
  if (ids.length === 0) {
    return [];
  }

  let sql: string;
  if (idType === 'uuid') {
    sql = `SELECT id, content, content_hash AS "contentHash", embedding_hash AS "embeddingHash", embedding_set_id AS "embeddingSetId"
     FROM file_chunks WHERE id = ANY($1::uuid[])`;
  } else {
    sql = `SELECT id, content, content_hash AS "contentHash", embedding_hash AS "embeddingHash", embedding_set_id AS "embeddingSetId"
     FROM file_chunks WHERE id = ANY($1::text[])`;
  }

  const res = await db.query<{
    id: string;
    content: string;
    contentHash: string;
    embeddingHash?: string | null;
    embeddingSetId?: string | null;
  }>(sql, [ids]);
  return res.rows;
}

async function resolveIdType(db: IDatabase, table: string): Promise<string> {
  type IdTypeProbe = 'information_schema' | 'pg_catalog';
  const normalizeType = (value: unknown): 'uuid' | 'text' | null => {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.toLowerCase();
    if (normalized === 'uuid') {
      return 'uuid';
    }
    if (normalized === 'text') {
      return 'text';
    }
    return null;
  };
  const errors: string[] = [];
  const recordProbeError = (probe: IdTypeProbe, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${probe}: ${message}`);
    workerLogger.error('Failed to resolve id type probe for embedding worker', {
      message,
      probe,
      table,
    });
  };

  try {
    const res = await db.query<{ dataType: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS "dataType"
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = $1
          AND a.attname = 'id'
          AND NOT a.attisdropped
        LIMIT 1`,
      [table]
    );
    const type = normalizeType(res.rows[0]?.dataType);
    if (type) {
      return type;
    }
  } catch (error) {
    recordProbeError('pg_catalog', error);
  }

  try {
    const res = await db.query<{ dataType: string }>(
      `SELECT data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = 'id'
        LIMIT 1`,
      [table]
    );
    const type = normalizeType(res.rows[0]?.dataType);
    if (type) {
      return type;
    }
  } catch (error) {
    recordProbeError('information_schema', error);
  }

  const suffix = errors.length > 0 ? ` Details: ${errors.join('; ')}` : '';
  throw new Error(`Failed to resolve ID type for ${table}.id.${suffix}`);
}

function readRowString(row: Record<string, unknown> | undefined, keys: readonly string[]): string {
  if (!row) {
    return '';
  }

  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string') {
      return value;
    }
  }

  return '';
}

async function assertVectorEmbeddingColumn(db: IDatabase): Promise<void> {
  try {
    const res = await db.query<Record<string, unknown>>(
      `SELECT data_type AS "dataType", udt_name AS "udtName"
       FROM information_schema.columns
       WHERE table_name = 'file_chunks'
         AND column_name = 'embedding'
       LIMIT 1`
    );
    const row = res.rows[0];
    const columnType = `${readRowString(row, ['udtName', 'udt_name', 'udtname'])} ${readRowString(
      row,
      ['dataType', 'data_type', 'datatype']
    )}`.toLowerCase();

    if (columnType.includes('vector')) {
      return;
    }
    if (columnType.trim().length > 0) {
      throw new Error(`file_chunks.embedding must be a vector column, found: ${columnType}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('must be a vector column')) {
      throw error;
    }
    workerLogger.debug('Failed to resolve file_chunks.embedding column type', { error });
  }

  try {
    const res = await db.query<{ one: number }>(
      "SELECT 1 as one FROM pg_extension WHERE extname = 'vector'"
    );
    if (Array.isArray(res.rows) && res.rows.length > 0) {
      return;
    }
  } catch (error) {
    workerLogger.debug('Failed to detect pgvector extension for embedding writes', {
      error,
    });
  }

  workerLogger.debug(
    'Could not verify file_chunks.embedding column type; continuing with vector writes because initialized Brainstrike databases require pgvector.'
  );
}

async function updateChunkEmbeddingBatch(
  db: IDatabase,
  updates: Array<{
    id: string;
    embedding: number[];
    embeddingSetId: string;
    embeddingHash: string;
  }>,
  idType: string
) {
  if (updates.length === 0) {
    return;
  }

  const now = new Date().toISOString();

  const ids = updates.map((u) => u.id);
  const embeddingSetIds = updates.map((u) => u.embeddingSetId);
  const embeddingHashes = updates.map((u) => u.embeddingHash);
  // Convert embeddings to string representation for postgres vector type
  const embeddings = updates.map((u) => `[${u.embedding.join(',')}]`);

  let sql: string;

  if (idType === 'uuid') {
    sql = `UPDATE file_chunks AS fc
         SET
           embedding = t.embedding::vector,
           embedding_set_id = t.embedding_set_id,
           embedding_updated_at = $1,
           embedding_hash = t.embedding_hash,
           updated_at = $1
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[])
         AS t(id, embedding, embedding_set_id, embedding_hash)
       WHERE fc.id = t.id`;
  } else {
    sql = `UPDATE file_chunks AS fc
         SET
           embedding = t.embedding::vector,
           embedding_set_id = t.embedding_set_id,
           embedding_updated_at = $1,
           embedding_hash = t.embedding_hash,
           updated_at = $1
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
         AS t(id, embedding, embedding_set_id, embedding_hash)
       WHERE fc.id = t.id`;
  }

  await db.query(sql, [now, ids, embeddings, embeddingSetIds, embeddingHashes]);
}

const embeddingSetDimensionCache = new Map<string, number>();

async function resolveEmbeddingSetDimension(
  db: IDatabase,
  embeddingSetId: string
): Promise<number> {
  const cached = embeddingSetDimensionCache.get(embeddingSetId);
  if (typeof cached === 'number') {
    return cached;
  }

  const res = await db.query<{ dimensions?: number }>(
    'SELECT dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
    [embeddingSetId]
  );
  const raw = res.rows[0]?.dimensions;
  const dimension = typeof raw === 'number' ? raw : Number(raw ?? 0);
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error(`Embedding set ${embeddingSetId} is missing valid dimension metadata.`);
  }
  embeddingSetDimensionCache.set(embeddingSetId, dimension);
  return dimension;
}

function resolveWorkerModel(fromOptions?: string): {
  provider: EmbeddingProviderType;
  modelId: string;
  compositeKey: string;
} {
  const envValue = (() => {
    try {
      if (process?.env?.['EMBED_MODEL_KEY']) {
        return String(process.env['EMBED_MODEL_KEY']);
      }
      return '';
    } catch (error) {
      workerLogger.debug('Unable to read EMBED_MODEL_KEY from environment', { error });
      return '';
    }
  })();

  const candidate = fromOptions || envValue || FALLBACK_MODEL_CONFIG.id;
  const parsed = parseProviderModelKey(candidate);

  if (parsed) {
    return {
      provider: parsed.provider,
      modelId: parsed.modelId,
      compositeKey: formatProviderModelKey(parsed.provider, parsed.modelId),
    };
  }

  return {
    provider: 'local',
    modelId: candidate,
    compositeKey: formatProviderModelKey('local', candidate),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isNodejsMainProcess(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      typeof process.versions?.node !== 'undefined' &&
      typeof window === 'undefined'
    );
  } catch (error) {
    workerLogger.debug('Failed to detect Node.js runtime while checking embedding worker context', {
      error,
    });
    return false;
  }
}

function isElectronMainProcess(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      Boolean((process as { type?: string } | undefined)?.type === 'browser')
    );
  } catch (error) {
    workerLogger.debug('Failed to detect Electron main process while checking embedding context', {
      error,
    });
    return false;
  }
}

function readBooleanEnv(key: string): boolean | undefined {
  try {
    const raw = (process as { env?: Record<string, string | undefined> } | undefined)?.env?.[key];
    if (raw === undefined) {
      return;
    }
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
    return;
  } catch (error) {
    workerLogger.debug('Failed to read boolean env flag', { key, error });
    return;
  }
}

function ensureLocalRuntime(modelResolution: { provider: EmbeddingProviderType }): void {
  if (!isLocalProviderType(modelResolution.provider)) {
    return;
  }

  const allowMainRuntime = readBooleanEnv('EMBED_ALLOW_LOCAL_IN_MAIN') === true;

  // Local transformers require Web Workers. In Electron main process, that would block the UI,
  // so we still forbid it unless explicitly overridden.
  if (isElectronMainProcess() && process.env['NODE_ENV'] !== 'test' && !allowMainRuntime) {
    throw new Error(
      'Cannot use local embedding models in Electron main process. ' +
        'TransformersBackend requires Web Workers which are only available in browser contexts. ' +
        'Use a hosted provider (openai, google) or process embeddings in the renderer.'
    );
  }

  // Pure Node.js workers are allowed but warned because they can still block when Web Workers
  // are unavailable. Operators can silence by setting EMBED_ALLOW_LOCAL_IN_MAIN=true.
  if (isNodejsMainProcess() && !allowMainRuntime) {
    workerLogger.warn(
      'Running local embeddings in a Node.js main process. This may block event loop if Web Workers are unavailable. ' +
        'Set EMBED_ALLOW_LOCAL_IN_MAIN=true to acknowledge this risk.'
    );
  }
}

function shouldStartWorker(
  options: EmbeddingWorkerOptions,
  log: (msg: string, meta?: unknown) => void
): boolean {
  // Allow explicit disable via options (for tests)
  if (options.enable === false) {
    log('Embedding worker disabled via options.enable=false');
    return false;
  }

  const envEnabled = readBooleanEnv('EMBED_WORKER_ENABLED');
  if (envEnabled === false) {
    log('Embedding worker disabled via EMBED_WORKER_ENABLED=false');
    return false;
  }
  if (envEnabled === true) {
    return true;
  }

  return true;
}

function toSupportedHostedProvider(
  provider: Exclude<EmbeddingProviderType, LocalProviderType>
): SupportedHostedProvider {
  if (
    provider === 'openai' ||
    provider === 'google' ||
    provider === 'ollama' ||
    provider === 'lmstudio'
  ) {
    return provider;
  }
  throw new Error(`Hosted provider "${provider}" is not supported yet.`);
}

function buildHostedProviderConfig(
  provider: SupportedHostedProvider,
  modelId: string,
  expectedDimension: number
): HostedProviderConfig {
  switch (provider) {
    case 'openai':
      return {
        runtime: 'hosted',
        provider: 'openai',
        modelId,
        dimensions: expectedDimension,
      };
    case 'google':
      return {
        runtime: 'hosted',
        provider: 'google',
        modelId,
        outputDimensionality: expectedDimension,
      };
    case 'ollama':
      return {
        runtime: 'hosted',
        provider: 'ollama',
        modelId,
        dimensions: expectedDimension,
      };
    case 'lmstudio':
      return {
        runtime: 'hosted',
        provider: 'lmstudio',
        modelId,
        dimensions: expectedDimension,
      };
    default:
      throw new Error(`Hosted provider "${provider}" is not supported yet.`);
  }
}

function formatHostedInitializationError(
  provider: SupportedHostedProvider,
  error: EmbeddingProviderError
): string {
  let reason = 'unavailable';
  if (error.type === 'missing_api_key') {
    reason = 'missing API key';
  } else if (error.type === 'validation_error') {
    reason = error.message;
  }
  return `Failed to initialize provider "${provider}" (${reason}).`;
}

async function createHostedProviderInstance(
  provider: SupportedHostedProvider,
  config: HostedProviderConfig
) {
  const providerResult = await EmbeddingProviderFactory.createProvider(config);
  if (!providerResult.ok) {
    throw new Error(formatHostedInitializationError(provider, providerResult.error));
  }
  return providerResult.value;
}

function formatHostedEmbedError(
  provider: SupportedHostedProvider,
  error: EmbeddingProviderError
): string {
  switch (error.type) {
    case 'api_error':
      return `Hosted provider "${provider}" API error (${error.statusCode}): ${error.message}`;
    case 'rate_limit_exceeded':
      return `Hosted provider "${provider}" rate limit exceeded.`;
    case 'missing_api_key':
      return `Hosted provider "${provider}" missing API key.`;
    case 'network_error':
      return `Hosted provider "${provider}" network error: ${error.originalError.message}`;
    default:
      return `Hosted provider "${provider}" error: ${error.type}.`;
  }
}

function validateHostedEmbeddingDimensions(
  provider: SupportedHostedProvider,
  modelId: string,
  embedding: number[],
  expectedDimension: number
): void {
  if (!Array.isArray(embedding) || embedding.length !== expectedDimension) {
    throw new Error(
      `Embedding dimension mismatch for hosted provider '${provider}' model '${modelId}': received ${embedding.length}, expected ${expectedDimension}.`
    );
  }
}

async function initializeEmbeddingService(
  options: EmbeddingWorkerOptions,
  modelKey: string,
  mode?: { initializeLocalService?: boolean }
): Promise<{ service: EmbeddingService; modelConfig: ModelConfig }> {
  workerLogger.info('initializeEmbeddingService: START', { modelKey });

  const service =
    options.service ??
    new SimpleEmbeddingService(
      options.streamingWorkerUrl
        ? {
            streamingWorkerUrl: options.streamingWorkerUrl,
          }
        : undefined
    );
  const initializeLocalService = mode?.initializeLocalService ?? true;

  const parsedForRegistry = parseProviderModelKey(modelKey);
  const registryModelKey =
    parsedForRegistry && isLocalProviderType(parsedForRegistry.provider)
      ? parsedForRegistry.modelId
      : modelKey;

  workerLogger.info('initializeEmbeddingService: querying DB for model', {
    modelKey,
    registryModelKey,
    parsedProvider: parsedForRegistry?.provider,
  });

  // Get model config from database FIRST (single source of truth)
  let modelConfig = await getModelConfigFromDb(options.db, registryModelKey);

  workerLogger.info('initializeEmbeddingService: DB query complete', {
    registryModelKey,
    foundConfig: !!modelConfig,
    configName: modelConfig?.name,
    configDimensions: modelConfig?.dimensions,
  });

  // For custom services, generate a test embedding to get dimensions
  if (!modelConfig && options.service) {
    const serviceConfig = service.getConfig();
    const testEmbedding = await service.generateEmbedding('test');
    modelConfig = {
      id: serviceConfig.modelId || 'custom-model',
      name: 'Custom Service Model',
      dimensions: testEmbedding.embedding.length,
      quantized: false,
      description: 'Custom embedding service model',
      tags: ['custom'],
      origin: 'custom',
      size: 'unknown',
    };
  }

  if (!modelConfig) {
    throw new Error(
      `Model '${registryModelKey}' not found in database. Add it via Settings > Models.`
    );
  }

  // Only initialize if we created the default service
  if (!options.service) {
    // Check if it's a hosted model - if so, we don't need to initialize the local service
    const parsed = parseProviderModelKey(modelKey);
    const isHosted = parsed && isHostedProvider(parsed.provider);

    if (!isHosted && initializeLocalService) {
      // Initialize with the MODEL CONFIG from DB (not just the key)
      // This bypasses the static registry lookup in SimpleEmbeddingService
      const simpleService = service as SimpleEmbeddingService;
      if (typeof simpleService.initializeWithModel === 'function') {
        await simpleService.initializeWithModel(
          modelConfig, // Pass the full config, not just the key
          (p) => {
            if (options.onDownloadProgress && p.progress !== undefined) {
              options.onDownloadProgress(registryModelKey, p.progress);
            }
          },
          options.device,
          options.cacheDir
        );
      } else {
        await service.initialize?.({}, undefined);
      }
    }
  }

  return { service, modelConfig };
}

/**
 * Validates the dimension metadata returned by the embedding service.
 * Ensures the size is finite, within pgvector's limits, and emits telemetry when we diverge
 * from the historical 768D default so downstream consumers can react.
 */
function ensureModelDimension(
  modelConfig: ModelConfig,
  modelKey: string,
  log: (msg: string, meta?: unknown) => void
): number {
  const dimensions = Number(modelConfig.dimensions);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    const errorMsg = `Model '${modelKey}' reported an invalid embedding dimension (${modelConfig.dimensions}).`;
    log('worker_model_dimension_invalid', {
      modelKey,
      dimensions: modelConfig.dimensions,
    });
    throw new Error(errorMsg);
  }

  if (dimensions > MAX_EMBEDDING_DIMENSION) {
    log('worker_model_dimension_warning', {
      modelKey,
      dimensions,
      message: `pgvector supports up to ${MAX_EMBEDDING_DIMENSION} dimensions; verify provider settings.`,
    });
    throw new Error(
      `Model '${modelKey}' exceeds the supported embedding dimension limit (${MAX_EMBEDDING_DIMENSION}). Received ${dimensions}.`
    );
  }

  if (dimensions !== DEFAULT_EMBEDDING_DIMENSION) {
    log('worker_model_dimension_notice', {
      modelKey,
      dimensions,
      default: DEFAULT_EMBEDDING_DIMENSION,
    });
  }

  return dimensions;
}

export async function startEmbeddingWorker(
  options: EmbeddingWorkerOptions
): Promise<EmbeddingWorkerController> {
  workerLogger.info('startEmbeddingWorker: START', {
    hasDb: !!options.db,
    modelKey: options.modelKey,
    claimBatchSize: options.claimBatchSize,
    concurrency: options.concurrency,
    device: options.device,
    interBatchDelayMs: options.interBatchDelayMs,
  });

  const log =
    options.log ||
    ((message: string, meta?: unknown) => {
      workerLogger.debug(message, meta);
    });
  let activeBatchCount = 0;
  let lastReportedActive = false;

  const reportWorkerActivity = (active: boolean) => {
    if (lastReportedActive === active) {
      return;
    }
    lastReportedActive = active;
    options.onWorkerActivityChange?.(active);
  };

  const beginActiveBatch = () => {
    activeBatchCount += 1;
    reportWorkerActivity(activeBatchCount > 0);
  };

  const endActiveBatch = () => {
    activeBatchCount = Math.max(0, activeBatchCount - 1);
    reportWorkerActivity(activeBatchCount > 0);
  };

  // Check if worker is disabled BEFORE resolving model to avoid errors in tests
  if (!shouldStartWorker(options, log)) {
    workerLogger.info('startEmbeddingWorker: worker disabled, returning early');
    return { stop: async () => {} };
  }

  const queueName = options.queue ?? 'embeddings';
  const leaseMs = options.leaseMs ?? 60_000;
  const heartbeatMs = options.heartbeatIntervalMs ?? 10_000;
  const concurrency = resolvePositiveIntegerOption(options.concurrency, 1, 'concurrency');
  const interBatchDelayMs = resolvePositiveIntegerOption(
    options.interBatchDelayMs,
    50,
    'interBatchDelayMs'
  );
  const claimBatchSize = resolvePositiveIntegerOption(
    options.claimBatchSize,
    DEFAULT_CLAIM_BATCH_SIZE,
    'claimBatchSize'
  );
  const statsRefreshMinIntervalMs = resolvePositiveIntegerOption(
    options.statsRefreshMinIntervalMs,
    DEFAULT_STATS_REFRESH_MIN_INTERVAL_MS,
    'statsRefreshMinIntervalMs'
  );
  const statsRefreshCompletedChunkThreshold = resolvePositiveIntegerOption(
    options.statsRefreshCompletedChunkThreshold,
    DEFAULT_STATS_REFRESH_COMPLETED_CHUNK_THRESHOLD,
    'statsRefreshCompletedChunkThreshold'
  );
  const now = options.now ?? Date.now;
  const statsRefreshController = createEmbeddingStatsRefreshController({
    completedChunkThreshold: statsRefreshCompletedChunkThreshold,
    db: options.db,
    log,
    minIntervalMs: statsRefreshMinIntervalMs,
    now,
  });
  const modelResolution = resolveWorkerModel(options.modelKey);
  ensureLocalRuntime(modelResolution);
  const initializeLocalModelOnStart = options.initializeLocalModelOnStart ?? true;
  let activeModelId = modelResolution.modelId;
  let activeCompositeKey = modelResolution.compositeKey;
  let lastClaimBatchSize = claimBatchSize;
  let lastClaimBatchSizeError: string | null = null;
  const workerId = options.workerId ?? `embed-worker-${generateUUID().slice(0, 8)}`;
  let service: EmbeddingService;
  let modelConfig: ModelConfig | null = null;
  let localServiceInitialized = false;
  let localModelExecutionFailure: {
    compositeKey: string;
    message: string;
    modelId: string;
  } | null = null;
  let fatalWorkerError: Error | null = null;
  let localModelInitializationFailure: {
    compositeKey: string;
    message: string;
    modelId: string;
  } | null = null;

  if (isLocalProviderType(modelResolution.provider) && !initializeLocalModelOnStart) {
    service =
      options.service ??
      new SimpleEmbeddingService(
        options.streamingWorkerUrl
          ? {
              streamingWorkerUrl: options.streamingWorkerUrl,
            }
          : undefined
      );
    localServiceInitialized = service.getStatus() === 'ready';
    workerLogger.info('Deferring local embedding model initialization until first claimed job', {
      modelKey: activeCompositeKey,
      serviceReady: localServiceInitialized,
    });
  } else {
    const initializedService = await initializeEmbeddingService(options, activeCompositeKey, {
      initializeLocalService: true,
    });
    service = initializedService.service;
    modelConfig = initializedService.modelConfig;
    if (isLocalProviderType(modelResolution.provider)) {
      localServiceInitialized = service.getStatus() === 'ready';
    }
    ensureModelDimension(initializedService.modelConfig, activeCompositeKey, log);
  }

  // Determine ID column type for file_chunks to support both UUID (Prod) and TEXT (Test/Electron) schemas
  const fileChunkIdType = await resolveIdType(options.db, 'file_chunks');

  // REMOVED: Worker no longer auto-creates embedding sets on startup
  // Collections should ONLY be created by the user via the Create Collection dialog
  // The worker will use embeddingSetId from job payloads (see resolveTargetSetId function)

  const jq = new JobQueue(options.db);
  let running = true;

  async function waitForBackgroundPermit(label: string): Promise<void> {
    await options.waitForBackgroundPermit?.({ label });
  }

  async function resolveEffectiveClaimBatchSize(): Promise<number | null> {
    if (!options.resolveClaimBatchSize) {
      lastClaimBatchSize = claimBatchSize;
      lastClaimBatchSizeError = null;
      return claimBatchSize;
    }
    try {
      const resolved = await options.resolveClaimBatchSize();
      const requestedClaimBatchSize = resolvePositiveIntegerOption(
        resolved,
        claimBatchSize,
        'resolveClaimBatchSize'
      );
      const effectiveClaimBatchSize = Math.min(requestedClaimBatchSize, claimBatchSize);
      lastClaimBatchSize = effectiveClaimBatchSize;
      lastClaimBatchSizeError = null;
      return effectiveClaimBatchSize;
    } catch (error) {
      // Resolver failures skip this claim poll; report the configured ceiling, not a stale value.
      lastClaimBatchSize = claimBatchSize;
      lastClaimBatchSizeError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  await assertVectorEmbeddingColumn(options.db);

  // Lightweight metrics for observability
  const metrics = {
    startedAt: Date.now(),
    jobsProcessed: 0,
    jobsFailed: 0,
    totalDurationMs: 0,
  };

  // Stability controls
  let processedSinceInit = 0;
  let consecutiveFailures = 0;
  let scheduledReinitPending = false;
  const reinitEveryN =
    options.reinitEveryN ??
    (() => {
      const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
        ?.process?.env?.['EMBED_REINIT_EVERY'];
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    })();

  function triggerFatalLocalWorkerError(error: Error): void {
    if (!options.stopOnFatalLocalError || fatalWorkerError) {
      return;
    }
    fatalWorkerError = error;
    running = false;
    reportWorkerActivity(false);
    workerLogger.error('Stopping embedding worker after fatal local model error', {
      error: error.message,
    });
    try {
      options.onFatalError?.(error);
    } catch (callbackError) {
      workerLogger.error('Embedding worker fatal error callback failed', {
        error: callbackError,
      });
    }
  }

  function assertLocalModelSwitchAllowed(targetModelId: string): void {
    const allowMainRuntime = readBooleanEnv('EMBED_ALLOW_LOCAL_IN_MAIN') === true;
    if (targetModelId === activeModelId || !isElectronMainProcess() || allowMainRuntime) {
      return;
    }

    throw new Error(
      `Cannot switch local embedding models in main process (from ${activeModelId} to ${targetModelId}). ` +
        'Web Workers are not available in Node.js/Electron main process. ' +
        `Either process this job in the renderer, or ensure all jobs use the same local model: ${activeModelId}`
    );
  }

  function logLocalModelInitialization(shouldReinitialize: boolean): void {
    workerLogger.warn(
      shouldReinitialize
        ? 'Reinitializing embedding service; this blocks the main thread'
        : 'Initializing deferred local embedding model for claimed work'
    );
  }

  async function resolveLocalModelConfig(
    targetModelId: string,
    shouldReinitialize: boolean
  ): Promise<ModelConfig> {
    const cachedConfig =
      modelConfig && !shouldReinitialize && modelConfig.id === targetModelId ? modelConfig : null;
    if (cachedConfig) {
      return cachedConfig;
    }

    const loadedConfig = await getModelConfigFromDb(options.db, targetModelId);
    if (!loadedConfig) {
      throw new Error(
        `Model '${targetModelId}' not found in database. Add it via Settings > Models.`
      );
    }
    return loadedConfig;
  }

  function createLocalServiceConfig(cfg: ModelConfig): Partial<EmbeddingConfig> {
    return {
      modelId: cfg.id,
      ...(options.device ? { device: options.device } : {}),
      ...(cfg.quantized === undefined ? {} : { quantized: cfg.quantized }),
      ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    };
  }

  async function initializeExistingLocalService(cfg: ModelConfig): Promise<void> {
    const simpleService = service as SimpleEmbeddingService;
    if (typeof simpleService.initializeWithModel === 'function') {
      await simpleService.initializeWithModel(cfg, undefined, options.device, options.cacheDir);
      return;
    }

    await service.initialize(createLocalServiceConfig(cfg), undefined);
  }

  async function createReinitializedLocalService(cfg: ModelConfig): Promise<EmbeddingService> {
    try {
      await service.dispose();
    } catch (error) {
      workerLogger.warn('Failed to dispose embedding service during reinitialization', { error });
    }

    const nextService = new SimpleEmbeddingService(
      options.streamingWorkerUrl
        ? {
            streamingWorkerUrl: options.streamingWorkerUrl,
          }
        : undefined
    );
    await nextService.initializeWithModel(cfg, undefined, options.device, options.cacheDir);
    return nextService;
  }

  function finalizeLocalModelState(
    cfg: ModelConfig,
    targetModelId: string,
    targetCompositeKey: string
  ): void {
    modelConfig = cfg;
    localServiceInitialized = true;
    localModelExecutionFailure = null;
    localModelInitializationFailure = null;
    activeModelId = targetModelId;
    activeCompositeKey = targetCompositeKey;
    ensureModelDimension(modelConfig, activeCompositeKey, log);
    processedSinceInit = 0;
    consecutiveFailures = 0;
  }

  function failFastOnLatchedLocalModelInitializationFailure(
    targetModelId: string,
    targetCompositeKey: string,
    forceReinit: boolean
  ): void {
    if (forceReinit || !localModelInitializationFailure) {
      return;
    }
    if (
      localModelInitializationFailure.modelId !== targetModelId ||
      localModelInitializationFailure.compositeKey !== targetCompositeKey
    ) {
      return;
    }

    throw new Error(
      `Local embedding model initialization previously failed for '${targetCompositeKey}': ${localModelInitializationFailure.message}`
    );
  }

  function latchLocalModelInitializationFailure(
    targetModelId: string,
    targetCompositeKey: string,
    error: unknown
  ): Error {
    const message = error instanceof Error ? error.message : String(error);
    const wrappedError = new Error(
      `Local embedding model initialization failed for '${targetCompositeKey}': ${message}`
    );
    localModelInitializationFailure = {
      modelId: targetModelId,
      compositeKey: targetCompositeKey,
      message,
    };
    triggerFatalLocalWorkerError(wrappedError);
    return options.stopOnFatalLocalError
      ? wrappedError
      : error instanceof Error
        ? error
        : new Error(message);
  }

  function failFastOnLatchedLocalModelExecutionFailure(
    targetModelId: string,
    targetCompositeKey: string
  ): void {
    if (!localModelExecutionFailure) {
      return;
    }
    if (
      localModelExecutionFailure.modelId !== targetModelId ||
      localModelExecutionFailure.compositeKey !== targetCompositeKey
    ) {
      return;
    }

    throw new Error(
      `Local embedding execution previously failed for '${targetCompositeKey}': ${localModelExecutionFailure.message}`
    );
  }

  function latchLocalModelExecutionFailure(
    targetModelId: string,
    targetCompositeKey: string,
    error: unknown
  ): Error {
    const message = error instanceof Error ? error.message : String(error);
    const wrappedError = new Error(
      `Local embedding execution failed for '${targetCompositeKey}': ${message}`
    );
    localModelExecutionFailure = {
      modelId: targetModelId,
      compositeKey: targetCompositeKey,
      message,
    };
    triggerFatalLocalWorkerError(wrappedError);
    return options.stopOnFatalLocalError
      ? wrappedError
      : error instanceof Error
        ? error
        : new Error(message);
  }

  async function ensureLocalModel(
    targetModelId: string,
    targetCompositeKey: string,
    opts?: { forceReinit?: boolean }
  ): Promise<void> {
    const forceReinit = opts?.forceReinit ?? false;
    const shouldReinitialize = forceReinit || targetModelId !== activeModelId;
    const shouldInitializeCurrentModel = !localServiceInitialized;

    if (!(shouldReinitialize || shouldInitializeCurrentModel)) {
      return;
    }

    workerLogger.debug('ensureLocalModel check', {
      targetModelId,
      activeModelId,
      shouldReinitialize,
      shouldInitializeCurrentModel,
      forceReinit,
    });

    assertLocalModelSwitchAllowed(targetModelId);
    failFastOnLatchedLocalModelInitializationFailure(
      targetModelId,
      targetCompositeKey,
      forceReinit
    );
    logLocalModelInitialization(shouldReinitialize);
    try {
      const cfg = await resolveLocalModelConfig(targetModelId, shouldReinitialize);

      if (shouldReinitialize) {
        service = await createReinitializedLocalService(cfg);
      } else {
        await initializeExistingLocalService(cfg);
      }
      finalizeLocalModelState(cfg, targetModelId, targetCompositeKey);
    } catch (error) {
      throw latchLocalModelInitializationFailure(targetModelId, targetCompositeKey, error);
    }
  }

  async function resetService() {
    localModelExecutionFailure = null;
    localModelInitializationFailure = null;
    await ensureLocalModel(activeModelId, activeCompositeKey, {
      forceReinit: true,
    });
    scheduledReinitPending = false;
  }

  // biome-ignore lint/style/useNamingConvention: DB field name
  type ClaimedJob = Job & { lease_token: string };

  class JobProcessingError extends Error {
    remainingJobs: ClaimedJob[];
    readonly originalError?: unknown;

    constructor(message: string, remainingJobs: ClaimedJob[], cause?: unknown) {
      super(message);
      this.name = 'JobProcessingError';
      this.remainingJobs = remainingJobs;
      this.originalError = cause;
    }
  }

  async function generateLocalEmbeddings(
    chunks: NonNullable<Awaited<ReturnType<typeof loadChunk>>>[],
    expectedDimension: number
  ): Promise<EmbeddingResult[]> {
    if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
      throw new Error(`Invalid expected embedding dimension (${expectedDimension}).`);
    }

    workerLogger.debug('Calling service.generateEmbeddings (may block main thread)', {
      count: chunks.length,
      expectedDimension,
    });

    const texts = chunks.map((c) => c.content);

    // EmbeddingService interface guarantees generateEmbeddings is available
    // No unsafe casting needed - use the typed service directly
    const results = await service.generateEmbeddings(texts);

    workerLogger.debug('service.generateEmbeddings completed');

    for (const result of results) {
      if (!Array.isArray(result.embedding) || result.embedding.length !== expectedDimension) {
        throw new Error(
          `Embedding dimension mismatch for model '${activeCompositeKey}': received ${result.embedding.length}, expected ${expectedDimension}. ` +
            'Verify provider configuration (dimension/size parameter) and retry.'
        );
      }
    }

    return results;
  }

  function assertStreamingService(candidate: EmbeddingService): StreamingEmbeddingService {
    const streamingService = candidate as StreamingEmbeddingService;
    if (typeof streamingService.generateEmbeddingsStream !== 'function') {
      throw new Error(
        'Local embedding service must implement generateEmbeddingsStream for background worker processing.'
      );
    }
    return streamingService;
  }

  function handleHostedError(provider: SupportedHostedProvider, error: EmbeddingProviderError) {
    if (error.type === 'rate_limit_exceeded') {
      const retryAfter = error.retryAfter;
      const ms = retryAfter ? retryAfter * 1000 : undefined;
      throw new WorkerRateLimitError(formatHostedEmbedError(provider, error), ms);
    }
    throw new Error(formatHostedEmbedError(provider, error));
  }

  async function generateHostedEmbeddings(
    provider: Exclude<EmbeddingProviderType, LocalProviderType>,
    modelId: string,
    expectedDimension: number,
    texts: string[]
  ): Promise<number[][]> {
    const supportedProvider = toSupportedHostedProvider(provider);
    const config = buildHostedProviderConfig(supportedProvider, modelId, expectedDimension);
    const providerInstance = await createHostedProviderInstance(supportedProvider, config);

    // Casting to allow array input which we added support for
    const embedResult = await providerInstance.embed({
      text: texts,
      modelId,
    });

    if (!embedResult.ok) {
      handleHostedError(supportedProvider, embedResult.error);
      throw new Error('Unreachable'); // handleHostedError always throws
    }

    const embeddings =
      embedResult.value.embeddings ||
      (embedResult.value.embedding ? [embedResult.value.embedding] : []);

    if (embeddings.length !== texts.length) {
      throw new Error(
        `Hosted provider returned ${embeddings.length} embeddings for ${texts.length} inputs.`
      );
    }

    for (const embedding of embeddings) {
      validateHostedEmbeddingDimensions(supportedProvider, modelId, embedding, expectedDimension);
    }

    return embeddings;
  }
  function assertEmbedChunkJob(claimed: ClaimedJob): EmbedChunkPayload {
    if (claimed.jobType !== 'embed_chunk') {
      throw new Error(`Unsupported job type: ${claimed.jobType}`);
    }
    const payload = (claimed.payload || {}) as EmbedChunkPayload;
    if (typeof payload.chunkId !== 'string' || payload.chunkId.length === 0) {
      throw new Error('Missing chunkId in payload');
    }
    if (typeof payload.embeddingSetId !== 'string' || payload.embeddingSetId.length === 0) {
      throw new Error('Missing embeddingSetId in payload');
    }
    if (typeof payload.modelKey !== 'string' || payload.modelKey.length === 0) {
      throw new Error('Missing modelKey in payload');
    }
    if (!Number.isFinite(payload.expectedDimension) || (payload.expectedDimension ?? 0) <= 0) {
      throw new Error('Missing expectedDimension in payload');
    }
    return payload;
  }

  function resolveTargetSetId(payload: EmbedChunkPayload): string {
    return payload.embeddingSetId ?? '';
  }

  async function determineExpectedDimension(
    targetSetId: string,
    payload: EmbedChunkPayload
  ): Promise<number> {
    const setDimension = await resolveEmbeddingSetDimension(options.db, targetSetId);
    if (payload.expectedDimension !== setDimension) {
      log('worker_expected_dimension_mismatch', {
        chunkId: payload.chunkId,
        payload: payload.expectedDimension,
        embeddingSetId: targetSetId,
        embeddingSetDimension: setDimension,
      });
      throw new Error(
        `Embedding dimension mismatch for set '${targetSetId}': payload=${payload.expectedDimension}, set=${setDimension}.`
      );
    }

    if (!Number.isFinite(setDimension) || setDimension <= 0) {
      throw new Error(`Invalid expected embedding dimension for set '${targetSetId}'.`);
    }

    return setDimension;
  }

  function isEmbeddingUpToDate(
    chunk: NonNullable<Awaited<ReturnType<typeof loadChunk>>>,
    expectedHash: string
  ): boolean {
    return Boolean(chunk.embeddingHash && chunk.embeddingHash === expectedHash);
  }

  function parseStatusCode(message: string): number | undefined {
    const statusMatch = /status (\d{3})/i.exec(message);
    return statusMatch ? Number(statusMatch[1]) : undefined;
  }

  function parseHostedStatusCode(message: string): number | undefined {
    const hostedStatusMatch = /API error \((\d{3})\)/i.exec(message);
    return hostedStatusMatch ? Number(hostedStatusMatch[1]) : undefined;
  }

  function classifyFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const truncated = summarizeErrorMessage(message);

    const backoffMs =
      error instanceof WorkerRateLimitError && error.retryAfterMs ? error.retryAfterMs : undefined;

    const hostedStatusCode = parseHostedStatusCode(message);
    const isHostedTerminal =
      hostedStatusCode !== undefined &&
      hostedStatusCode >= 400 &&
      hostedStatusCode < 500 &&
      hostedStatusCode !== 429;

    const statusCode = parseStatusCode(message);
    const isExplicitTerminalStatus =
      statusCode !== undefined && [400, 401, 403, 422].includes(statusCode);

    const isTerminal =
      isExplicitTerminalStatus ||
      isHostedTerminal ||
      /context length exceeded/i.test(message) ||
      /invalid input/i.test(message);

    return {
      backoffMs,
      isTerminal,
      truncated,
    };
  }

  function summarizeErrorMessage(message: string, limit = 4000): string {
    if (message.length <= limit) {
      return message;
    }
    const separator = ' ...[truncated]... ';
    const available = limit - separator.length;
    if (available <= 0) {
      return message.slice(0, limit);
    }

    const head = Math.floor(available / 2);
    const tail = available - head;
    return `${message.slice(0, head)}${separator}${message.slice(message.length - tail)}`;
  }

  async function handleBatchFailure(jobs: ClaimedJob[], error: unknown) {
    // LOG THE ERROR so we can see what's happening
    workerLogger.error('handleBatchFailure: Job(s) failed', {
      jobCount: jobs.length,
      jobIds: jobs.map((j) => j.id).slice(0, 5), // First 5 job IDs
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    const { backoffMs, isTerminal, truncated } = classifyFailure(error);

    // Fail all jobs in one batched call (2-3 queries instead of 2N)
    await jq.failBatch({
      jobs: jobs.map((j) => ({ id: j.id, leaseToken: j.lease_token })),
      error: truncated,
      terminal: isTerminal,
      ...(backoffMs === undefined ? {} : { backoffMs }),
    });

    metrics.jobsFailed += jobs.length;
    consecutiveFailures += 1;

    if (fatalWorkerError) {
      return;
    }

    if (reinitEveryN > 0 && consecutiveFailures >= reinitEveryN) {
      workerLogger.warn(
        `Consecutive failures (${consecutiveFailures}); forcing service reinitialization.`
      );
      await resetService();
      consecutiveFailures = 0;
    }
  }

  async function loadAndFilterChunks(
    jobs: ClaimedJob[],
    jobModel: ReturnType<typeof resolveJobModel>
  ) {
    // 1. Load all chunks
    const chunkIds = jobs.map((job) => assertEmbedChunkJob(job).chunkId);
    const loadedChunks = await loadChunksBatch(options.db, chunkIds, fileChunkIdType);
    const chunkMap = new Map(loadedChunks.map((c) => [c.id, c]));

    const chunks = jobs.map((job) => {
      const p = assertEmbedChunkJob(job);
      const chunk = chunkMap.get(p.chunkId);
      if (!chunk) {
        throw new Error(`Chunk not found: ${p.chunkId}`);
      }
      return { job, chunk, payload: p };
    });

    // 2. Filter out up-to-date chunks
    const toProcess: LoadedChunkItem[] = [];
    const completed: LoadedChunkItem[] = [];

    for (const item of chunks) {
      const expectedHash = await sha256Hex(`${item.chunk.contentHash}:${jobModel.compositeKey}`);
      const tagged = { ...item, expectedHash };
      if (isEmbeddingUpToDate(item.chunk, expectedHash)) {
        completed.push(tagged);
      } else {
        toProcess.push(tagged);
      }
    }
    return { toProcess, completed };
  }

  interface LoadedChunkItem {
    chunk: NonNullable<Awaited<ReturnType<typeof loadChunk>>>;
    expectedHash: string; // BST-358: computed once in loadAndFilterChunks
    job: ClaimedJob;
    payload: EmbedChunkPayload;
  }

  const embeddingCacheMaintenance = options.embeddingCache
    ? new EmbeddingCacheMaintenanceController(options.embeddingCache, {
        log,
        warn: (message, meta) => workerLogger.warn(message, meta),
      })
    : null;

  function trackCacheWrite(write: Promise<number>): void {
    embeddingCacheMaintenance?.trackCacheWrite(write);
  }

  async function runEmbeddingCacheMaintenance(reason: 'queue-idle'): Promise<void> {
    await embeddingCacheMaintenance?.run(reason);
  }

  async function flushEmbeddingCacheWrites(): Promise<void> {
    await embeddingCacheMaintenance?.flushPendingWrites();
    await options.embeddingCache?.flushPendingAccessTimeUpdates?.();
  }

  // BST-170: Helper to lookup cache hits
  async function lookupCacheHits(
    items: LoadedChunkItem[],
    modelKey: string
  ): Promise<Map<string, CachedEmbedding>> {
    const cache = options.embeddingCache;
    if (!cache) {
      return new Map();
    }

    const requests = items.map((item) => ({
      contentHash: item.chunk.contentHash,
      modelKey,
    }));
    const hits = await cache.getBatch(requests);
    workerLogger.debug('Cache lookup complete', {
      requested: items.length,
      hits: hits.size,
      modelKey,
    });
    return hits;
  }

  // BST-170: Helper to filter cache misses
  function filterCacheMisses(
    items: LoadedChunkItem[],
    cacheHits: Map<string, CachedEmbedding>,
    modelKey: string
  ): LoadedChunkItem[] {
    return items.filter((item) => {
      const cacheKey = `${item.chunk.contentHash}:${modelKey}`;
      return !cacheHits.has(cacheKey);
    });
  }

  // BST-170: Helper to store embeddings to cache without failing embedding completion.
  function storeToCacheAsync(
    items: LoadedChunkItem[],
    embeddings: number[][],
    modelKey: string,
    dimensions: number
  ): void {
    const cache = options.embeddingCache;
    if (!cache || embeddings.length === 0) {
      return;
    }

    const entries = items
      .map((item, idx) => {
        const embedding = embeddings[idx];
        return embedding
          ? { contentHash: item.chunk.contentHash, modelKey, embedding, dimensions }
          : null;
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    trackCacheWrite(cache.setBatch(entries));
  }

  // BST-170: Helper to reconstruct results combining cache hits and generated
  function reconstructResults(
    items: LoadedChunkItem[],
    cacheHits: Map<string, CachedEmbedding>,
    generated: number[][],
    modelKey: string
  ): number[][] {
    const results: number[][] = [];
    let genIdx = 0;
    for (const item of items) {
      const cacheKey = `${item.chunk.contentHash}:${modelKey}`;
      const cached = cacheHits.get(cacheKey);
      if (cached) {
        results.push(cached.embedding);
      } else {
        const embedding = generated[genIdx++];
        if (!embedding) {
          throw new Error(`Missing generated embedding at index ${genIdx - 1}`);
        }
        results.push(embedding);
      }
    }
    return results;
  }

  async function generateEmbeddingsForGroup(
    jobModel: ReturnType<typeof resolveJobModel>,
    toProcess: LoadedChunkItem[],
    expectedDimension: number
  ): Promise<number[][]> {
    const modelKey = jobModel.compositeKey;

    // BST-170: Check cache for existing embeddings
    const cacheHits = await lookupCacheHits(toProcess, modelKey);
    const cacheMisses = filterCacheMisses(toProcess, cacheHits, modelKey);

    // All items were cache hits
    if (cacheMisses.length === 0) {
      return reconstructResults(toProcess, cacheHits, [], modelKey);
    }

    // Generate embeddings for cache misses only
    let generatedEmbeddings: number[][];
    const texts = cacheMisses.map((item) => item.chunk.content);

    if (isLocalProviderType(jobModel.provider)) {
      await ensureLocalModel(jobModel.modelId, jobModel.compositeKey);
      failFastOnLatchedLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey);
      let results: EmbeddingResult[];
      try {
        results = await generateLocalEmbeddings(
          cacheMisses.map((item) => item.chunk),
          expectedDimension
        );
      } catch (error) {
        throw latchLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey, error);
      }
      localModelExecutionFailure = null;
      generatedEmbeddings = results.map((r) => r.embedding);
    } else {
      generatedEmbeddings = await generateHostedEmbeddings(
        jobModel.provider,
        jobModel.modelId,
        expectedDimension,
        texts
      );
    }

    // BST-170: Store generated embeddings in cache (fire-and-forget)
    storeToCacheAsync(cacheMisses, generatedEmbeddings, modelKey, expectedDimension);

    return reconstructResults(toProcess, cacheHits, generatedEmbeddings, modelKey);
  }

  async function validateBatchDimensions(toProcess: LoadedChunkItem[]) {
    const dimensions = await Promise.all(
      toProcess.map((item) =>
        determineExpectedDimension(resolveTargetSetId(item.payload), item.payload)
      )
    );

    const expectedDimension = dimensions[0];
    if (!expectedDimension) {
      throw new Error('Could not determine expected dimension for batch.');
    }

    if (dimensions.some((d) => d !== expectedDimension)) {
      throw new Error('Batch contains jobs with conflicting expected dimensions.');
    }
    return expectedDimension;
  }

  async function completeBatch(
    toProcess: LoadedChunkItem[],
    embeddings: number[][],
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): Promise<Set<string>> {
    // Validate batch size consistency before processing
    if (toProcess.length !== embeddings.length) {
      throw new Error(
        `Batch size mismatch: ${toProcess.length} items vs ${embeddings.length} embeddings.`
      );
    }

    const completedJobIds = new Set<string>();
    const updates: Array<{
      id: string;
      embedding: number[];
      embeddingSetId: string;
      embeddingHash: string;
    }> = [];
    const jobCompletions: Array<{ id: string; leaseToken: string }> = [];

    for (let index = 0; index < toProcess.length; index++) {
      const item = toProcess[index];
      const embedding = embeddings[index];
      if (!(item && embedding)) {
        throw new Error(`Missing item or embedding at index ${index} in batch.`);
      }
      const targetSetId = resolveTargetSetId(item.payload);
      updates.push({
        id: item.chunk.id,
        embedding,
        embeddingSetId: targetSetId,
        embeddingHash: item.expectedHash,
      });
      jobCompletions.push({ id: item.job.id, leaseToken: item.job.lease_token });
    }

    if (updates.length > 0) {
      await waitForBackgroundPermit('embedding completion');
      await updateChunkEmbeddingBatch(options.db, updates, fileChunkIdType);
    }

    const completedJobs = await jq.completeBatch(jobCompletions);

    for (const job of completedJobs) {
      completedJobIds.add(job.id);
    }
    onJobsCompleted?.(completedJobIds);
    log('embedding_completion_batch', {
      completedJobCount: completedJobIds.size,
      embeddingSetCount: new Set(updates.map((update) => update.embeddingSetId)).size,
      updateCount: updates.length,
    });
    try {
      await statsRefreshController.recordCompletions(
        updates.map((update) => update.embeddingSetId),
        updates.length
      );
      await statsRefreshController.flushIfDue();
    } catch (error) {
      workerLogger.warn('Failed to update embedding completion stats', {
        completedChunkCount: updates.length,
        embeddingSetCount: new Set(updates.map((update) => update.embeddingSetId)).size,
        error,
      });
    }

    return completedJobIds;
  }

  async function completeBatchAndTrack(
    toProcess: LoadedChunkItem[],
    embeddings: number[][],
    completedJobIds: Set<string>,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): Promise<void> {
    const newlyCompleted = await completeBatch(toProcess, embeddings, onJobsCompleted);
    for (const id of newlyCompleted) {
      completedJobIds.add(id);
    }
    metrics.jobsProcessed += toProcess.length;
    processedSinceInit += toProcess.length;
    consecutiveFailures = 0;
  }

  async function processLocalGroupIncrementally(
    jobModel: ReturnType<typeof resolveJobModel>,
    toProcess: LoadedChunkItem[],
    expectedDimension: number,
    completedJobIds: Set<string>,
    checkLease: () => boolean,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): Promise<void> {
    const modelKey = jobModel.compositeKey;
    const cacheHits = await lookupCacheHits(toProcess, modelKey);
    const cacheMisses = filterCacheMisses(toProcess, cacheHits, modelKey);
    const cacheHitItems = toProcess.filter((item) =>
      cacheHits.has(`${item.chunk.contentHash}:${modelKey}`)
    );

    if (cacheHitItems.length > 0) {
      if (checkLease()) {
        throw new Error('Lease lost during processing');
      }
      const cachedEmbeddings = reconstructResults(cacheHitItems, cacheHits, [], modelKey);
      await completeBatchAndTrack(
        cacheHitItems,
        cachedEmbeddings,
        completedJobIds,
        onJobsCompleted
      );
    }

    if (cacheMisses.length === 0) {
      await maybeReinitialize();
      return;
    }

    await ensureLocalModel(jobModel.modelId, jobModel.compositeKey);
    failFastOnLatchedLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey);
    const streamingService = assertStreamingService(service);

    try {
      await streamingService.generateEmbeddingsStream(
        cacheMisses.map((item) => item.chunk.content),
        async (batch) => {
          if (checkLease()) {
            throw new Error('Lease lost during processing');
          }

          const batchItems = cacheMisses.slice(batch.startIndex, batch.endIndex);
          if (batchItems.length !== batch.results.length) {
            throw new Error(
              `Local embedding stream batch mismatch: ${batchItems.length} items for ${batch.results.length} results.`
            );
          }

          const embeddings = batch.results.map((result, index) => {
            if (!Array.isArray(result.embedding) || result.embedding.length !== expectedDimension) {
              throw new Error(
                `Embedding dimension mismatch for model '${jobModel.compositeKey}' batch item ${batch.startIndex + index}: received ${result.embedding.length}, expected ${expectedDimension}.`
              );
            }
            return result.embedding;
          });

          await completeBatchAndTrack(batchItems, embeddings, completedJobIds, onJobsCompleted);
          storeToCacheAsync(batchItems, embeddings, modelKey, expectedDimension);
        }
      );
    } catch (error) {
      throw latchLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey, error);
    }

    localModelExecutionFailure = null;

    await maybeReinitialize();
  }

  function resolveJobModel(payload: EmbedChunkPayload): {
    compositeKey: string;
    provider: EmbeddingProviderType;
    modelId: string;
  } {
    const rawModelKey = payload.modelKey ?? '';
    const providerHint = payload.provider ?? undefined;

    const candidateComposite = (() => {
      const parsed = parseProviderModelKey(rawModelKey);
      if (parsed) {
        return rawModelKey;
      }
      if (providerHint && isHostedProvider(providerHint)) {
        return formatProviderModelKey(providerHint, rawModelKey);
      }
      throw new Error(`Invalid modelKey in payload: ${rawModelKey}`);
    })();

    const compositeKey = candidateComposite;
    const parsed = parseProviderModelKey(compositeKey);

    if (parsed) {
      return {
        compositeKey,
        provider: parsed.provider,
        modelId: parsed.modelId,
      };
    }

    return {
      compositeKey,
      provider: 'local',
      modelId: compositeKey,
    };
  }

  function startHeartbeat(jobs: ClaimedJob[], onLeaseLost: (job: ClaimedJob) => void) {
    const completedJobs = new Set<string>();
    const lostJobs = new Set<string>();
    let isHeartbeating = false;

    const timer = setInterval(() => {
      // Prevent overlapping heartbeats (race condition protection)
      if (isHeartbeating) {
        return;
      }
      isHeartbeating = true;

      (async () => {
        try {
          const activeJobs = jobs.filter(
            (job) => !(completedJobs.has(job.id) || lostJobs.has(job.id))
          );
          if (activeJobs.length === 0) {
            return;
          }

          const heartbeatInput = activeJobs.map((job) => ({
            id: job.id,
            leaseToken: job.lease_token,
          }));

          const heartbeatedJobs = await jq.heartbeatBatch(heartbeatInput, leaseMs);
          const succeededIds = new Set(heartbeatedJobs.map((j) => j.id));

          for (const job of activeJobs) {
            // Streaming completions can land while heartbeatBatch awaits the DB host.
            if (completedJobs.has(job.id)) {
              continue;
            }
            if (!succeededIds.has(job.id)) {
              workerLogger.error('Heartbeat failed: lease lost', { jobId: job.id });
              lostJobs.add(job.id);
              onLeaseLost(job);
            }
          }
        } finally {
          isHeartbeating = false;
        }
      })().catch((err) => {
        log('worker_heartbeat_error', { count: jobs.length, error: String(err) });
      });
    }, heartbeatMs);

    return {
      markCompleted(jobIds: Iterable<string>): void {
        for (const jobId of jobIds) {
          completedJobs.add(jobId);
        }
      },
      stop(): void {
        clearInterval(timer);
      },
    };
  }

  async function processJobGroup(
    jobs: ClaimedJob[],
    jobModel: ReturnType<typeof resolveJobModel>,
    checkLease: () => boolean,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ) {
    const { toProcess, completed } = await loadAndFilterChunks(jobs, jobModel);
    const completedJobIds = new Set<string>(completed.map((item) => item.job.id));

    try {
      if (checkLease()) {
        throw new Error('Lease lost during processing');
      }

      await markAlreadyCompleted(completed, completedJobIds, onJobsCompleted);

      if (toProcess.length === 0) {
        return;
      }

      const expectedDimension = await validateBatchDimensions(toProcess);

      if (checkLease()) {
        throw new Error('Lease lost during processing');
      }

      if (isLocalProviderType(jobModel.provider)) {
        await processLocalGroupIncrementally(
          jobModel,
          toProcess,
          expectedDimension,
          completedJobIds,
          checkLease,
          onJobsCompleted
        );
      } else {
        const embeddings = await generateEmbeddingsForGroup(jobModel, toProcess, expectedDimension);

        if (checkLease()) {
          throw new Error('Lease lost during processing');
        }

        await completeBatchAndTrack(toProcess, embeddings, completedJobIds, onJobsCompleted);
        await maybeReinitialize();
      }
    } catch (err) {
      const remainingJobs = jobs.filter((job) => !completedJobIds.has(job.id));
      throw new JobProcessingError('Failed processing job group', remainingJobs, err);
    }
  }

  /**
   * Mark already-completed jobs (chunks with matching embedding_hash) as succeeded.
   * Uses batch completion to avoid N+1 database queries.
   *
   * @param completed - Jobs that were filtered out because their chunks are already embedded
   * @param completedJobIds - Set to track which job IDs have been completed
   */
  async function markAlreadyCompleted(
    completed: Array<{ job: ClaimedJob }>,
    completedJobIds: Set<string>,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ) {
    if (completed.length === 0) {
      return;
    }
    await jq.completeBatch(
      completed.map((item) => ({ id: item.job.id, leaseToken: item.job.lease_token }))
    );
    const newlyCompleted = new Set<string>();
    for (const item of completed) {
      completedJobIds.add(item.job.id);
      newlyCompleted.add(item.job.id);
    }
    onJobsCompleted?.(newlyCompleted);
    metrics.jobsProcessed += completed.length;
    processedSinceInit += completed.length;
  }

  async function maybeReinitialize() {
    if (reinitEveryN <= 0 || processedSinceInit < reinitEveryN || scheduledReinitPending) {
      return;
    }
    // Reinitialize inline instead of deferring to idle. During large backfills
    // the queue is never idle, so the deferred reinit never runs. This causes
    // the ONNX WASM heap to grow unboundedly (WASM memory can only grow, not
    // shrink). Inline reinit caps memory by creating a fresh WASM instance.
    workerLogger.info(
      `Processed ${processedSinceInit} jobs; reinitializing embedding service to reclaim WASM memory.`
    );
    try {
      await resetService();
    } catch (error) {
      workerLogger.error('Inline embedding service reinitialization failed', { error });
    }
  }

  async function resolveJobModelOrFail(
    jobs: ClaimedJob[]
  ): Promise<ReturnType<typeof resolveJobModel> | null> {
    const firstJob = jobs[0];
    if (!firstJob) {
      return null;
    }
    try {
      const payload = assertEmbedChunkJob(firstJob);
      return resolveJobModel(payload);
    } catch (err) {
      await handleBatchFailure(jobs, err);
      return null;
    }
  }

  function createLeaseTracker(
    jobs: ClaimedJob[],
    checkLeaseOverride?: () => boolean
  ): {
    checkLease: () => boolean;
    dispose: () => void;
    markCompleted: (jobIds: Iterable<string>) => void;
  } {
    let leaseLost = false;
    const checkLease = checkLeaseOverride ?? (() => leaseLost);
    const hb =
      checkLeaseOverride === undefined
        ? startHeartbeat(jobs, () => {
            leaseLost = true;
          })
        : undefined;
    return {
      checkLease,
      dispose: () => {
        if (hb) {
          hb.stop();
        }
      },
      markCompleted: (jobIds: Iterable<string>) => {
        hb?.markCompleted(jobIds);
      },
    };
  }

  async function handleGroupError(
    error: unknown,
    jobs: ClaimedJob[],
    checkLease: () => boolean
  ): Promise<void> {
    if (checkLease()) {
      workerLogger.warn('Aborting batch processing due to lost lease');
      return;
    }
    if (error instanceof JobProcessingError) {
      await handleBatchFailure(error.remainingJobs, error.originalError ?? error);
      return;
    }
    await handleBatchFailure(jobs, error);
  }

  async function processGroup(
    jobs: ClaimedJob[],
    checkLeaseOverride?: () => boolean,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): Promise<void> {
    if (jobs.length === 0) {
      return;
    }

    const jobModel = await resolveJobModelOrFail(jobs);
    if (!jobModel) {
      return;
    }

    const lease = createLeaseTracker(jobs, checkLeaseOverride);
    const markJobsCompleted = (jobIds: Set<string>) => {
      lease.markCompleted(jobIds);
      onJobsCompleted?.(jobIds);
    };

    try {
      await processJobGroup(jobs, jobModel, lease.checkLease, markJobsCompleted);
    } catch (error) {
      await handleGroupError(error, jobs, lease.checkLease);
    } finally {
      lease.dispose();
    }
  }

  function groupJobs(jobs: ClaimedJob[]): Map<string, ClaimedJob[]> {
    const groups = new Map<string, ClaimedJob[]>();
    for (const job of jobs) {
      try {
        const payload = assertEmbedChunkJob(job);
        const model = resolveJobModel(payload);
        const key = `${model.provider}:${model.compositeKey}`;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)?.push(job);
      } catch (err) {
        // If we can't parse job/model, fail it immediately
        jq.fail({
          id: job.id,
          leaseToken: job.lease_token,
          error: err instanceof Error ? err.message : String(err),
        }).catch((e: unknown) => workerLogger.error('Failed to fail job', { error: e }));
        metrics.jobsFailed += 1;
      }
    }
    return groups;
  }

  async function processClaimedJobs(jobs: ClaimedJob[]) {
    const leaseLost = new Set<string>();
    const batchHeartbeat = startHeartbeat(jobs, (job) => {
      leaseLost.add(job.id);
    });

    try {
      const groups = groupJobs(jobs);
      for (const group of groups.values()) {
        const checkLease = () => group.some((job) => leaseLost.has(job.id));
        if (checkLease()) {
          workerLogger.warn('Skipping group due to lost lease before processing', {
            jobIds: group.map((job) => job.id),
          });
          continue;
        }
        await processGroup(group, checkLease, (jobIds) => {
          batchHeartbeat.markCompleted(jobIds);
        });
      }
    } finally {
      batchHeartbeat.stop();
    }
  }

  async function handleIdleBatch(): Promise<void> {
    reportWorkerActivity(false);
    if (scheduledReinitPending) {
      workerLogger.info('Queue idle; performing scheduled embedding service reinitialization.');
      try {
        await resetService();
      } catch (error) {
        workerLogger.error('Scheduled embedding service reinitialization failed', { error });
      }
    }
    try {
      await statsRefreshController.flush('queue-idle');
    } catch (error) {
      workerLogger.warn('Failed to refresh embedding stats during idle', { error });
    }
    await runEmbeddingCacheMaintenance('queue-idle');
    // Silent on empty polls - this happens constantly during idle
    await sleep(400); // idle backoff
  }

  function isClosedDatabaseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('PGlite is closed') || message.includes('closed');
  }

  async function processBatch(): Promise<void> {
    const batchStart = performance.now();
    try {
      await waitForBackgroundPermit('embedding claim');
      const effectiveClaimBatchSize = await resolveEffectiveClaimBatchSize();
      if (effectiveClaimBatchSize === null) {
        await sleep(CLAIM_SIZE_RESOLVER_FAILURE_BACKOFF_MS);
        return;
      }
      // Claim a batch of jobs
      const jobs = (await jq.claimMany({
        queue: queueName,
        leaseMs,
        workerId,
        limit: effectiveClaimBatchSize,
      })) as ClaimedJob[];

      if (jobs.length === 0) {
        await handleIdleBatch();
        return;
      }

      beginActiveBatch();
      try {
        await processClaimedJobs(jobs);
      } finally {
        endActiveBatch();
      }

      // Yield between batches to let V8/GC and the foreground renderer breathe
      // under sustained background embedding load.
      if (running) {
        await sleep(interBatchDelayMs);
      }
    } catch (err) {
      if (isClosedDatabaseError(err)) {
        running = false; // Stop the worker loop
        return;
      }
      workerLogger.error('Critical worker error in processBatch', { error: err });
      await sleep(1000);
    } finally {
      metrics.totalDurationMs += performance.now() - batchStart;
    }
  }

  const loops: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    loops.push(
      (async () => {
        while (running) {
          await processBatch();
        }
      })()
    );
  }

  // Periodic metrics logger
  const metricsInterval = Number(
    options.metricsIntervalMs ??
      (globalThis as { process?: { env?: Record<string, string | undefined> } })?.process?.env?.[
        'WORKER_METRICS_INTERVAL_MS'
      ] ??
      30_000
  );
  const metricsTimer = setInterval(
    () => {
      if (!running) {
        return;
      }
      const uptimeMs = Date.now() - metrics.startedAt;
      const avgMs = metrics.jobsProcessed > 0 ? metrics.totalDurationMs / metrics.jobsProcessed : 0;
      log('worker_metrics', {
        uptimeMs,
        processed: metrics.jobsProcessed,
        failed: metrics.jobsFailed,
        avgDurationMs: Math.round(avgMs),
        concurrency,
        claimBatchSize,
        effectiveClaimBatchSize: lastClaimBatchSize,
        effectiveClaimBatchSizeError: lastClaimBatchSizeError,
        interBatchDelayMs,
        queue: queueName,
        modelKey: activeCompositeKey,
      });
    },
    Math.max(5000, metricsInterval)
  );

  return {
    stop: async () => {
      running = false;
      reportWorkerActivity(false);
      await Promise.race([Promise.allSettled(loops).then(() => {}), sleep(leaseMs)]);
      try {
        await statsRefreshController.flush('worker-stop');
      } catch (error) {
        workerLogger.warn('Failed to refresh embedding stats during shutdown', { error });
      }
      await flushEmbeddingCacheWrites();
      try {
        await service.dispose();
      } catch (error) {
        workerLogger.warn('Failed to dispose embedding service during shutdown', { error });
      }
      clearInterval(metricsTimer);
    },
  };
}
