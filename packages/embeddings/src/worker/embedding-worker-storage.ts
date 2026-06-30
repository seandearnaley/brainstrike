import {
  type BrainstrikeDbExecutionClient,
  type IDatabase,
  type Job,
  JobQueue,
  markTursoCollectionIndexingStatsDirty,
  refreshTursoCollectionIndexingStats,
  TursoJobQueue,
} from '@brainstrike/db';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import type { ModelConfig } from '../types';
import { getModelConfigFromDb } from './embedding-model-config';
import {
  createEmbeddingStatsRefreshController,
  createEmbeddingStatsRefreshControllerWithOperations,
  type EmbeddingStatsRefreshController,
} from './embedding-stats-refresh-controller';
import {
  assertVectorEmbeddingColumn,
  type EmbedChunkRow,
  loadChunksBatch,
  resolveEmbeddingSetDimension,
  resolveIdType,
} from './embedding-worker-db-io';

export interface EmbeddingWorkerClaimParams {
  leaseMs: number;
  limit?: number;
  queue: string;
  workerId?: string;
}

export interface EmbeddingWorkerJobLeaseRef {
  id: string;
  leaseToken: string;
}

// biome-ignore lint/style/useNamingConvention: lease_token is a database field name.
export type EmbeddingWorkerClaimedJob = Job & { lease_token: string };

export interface EmbeddingWorkerCompleteEmbeddingChunkParams extends EmbeddingWorkerJobLeaseRef {
  chunkId: string;
  embedding: number[];
  embeddingHash: string;
  embeddingSetId: string;
}

export interface EmbeddingWorkerFailBatchParams {
  backoffMs?: number;
  error: string;
  jobs: readonly EmbeddingWorkerJobLeaseRef[];
  terminal?: boolean;
}

export interface EmbeddingWorkerFailParams extends EmbeddingWorkerJobLeaseRef {
  backoffMs?: number;
  error: string;
  terminal?: boolean;
}

export interface EmbeddingWorkerQueuePort {
  claimMany(params: EmbeddingWorkerClaimParams): Promise<EmbeddingWorkerClaimedJob[]>;
  completeBatch(jobs: EmbeddingWorkerJobLeaseRef[]): Promise<Job[]>;
  completeEmbeddingChunkBatch(jobs: EmbeddingWorkerCompleteEmbeddingChunkParams[]): Promise<Job[]>;
  fail(params: EmbeddingWorkerFailParams): Promise<Job | null>;
  failBatch(params: EmbeddingWorkerFailBatchParams): Promise<Job[]>;
  heartbeatBatch(jobs: EmbeddingWorkerJobLeaseRef[], extendMs: number): Promise<Job[]>;
}

export interface EmbeddingWorkerStatsControllerOptions {
  completedChunkThreshold: number;
  log: (msg: string, meta?: unknown) => void;
  minIntervalMs: number;
  now: () => number;
}

export interface EmbeddingWorkerStorage {
  assertEmbeddingStorageReady(): Promise<void>;
  createStatsRefreshController(
    options: EmbeddingWorkerStatsControllerOptions
  ): EmbeddingStatsRefreshController;
  getModelConfig(modelId: string): Promise<ModelConfig | null>;
  loadChunksByIds(ids: readonly string[]): Promise<EmbedChunkRow[]>;
  queue: EmbeddingWorkerQueuePort;
  resolveEmbeddingSetDimension(embeddingSetId: string): Promise<number>;
}

interface TursoModelRow {
  readonly capabilities: string | null;
  readonly description: string | null;
  readonly id: string;
  readonly name: string;
  readonly parameters: string | null;
  readonly providerId: string;
}

interface TursoTableColumnRow {
  readonly name: string;
  readonly type: string;
}

const tursoStorageLogger = createLogger('TursoEmbeddingWorkerStorage');

function assertClaimedJobs(jobs: Job[]): EmbeddingWorkerClaimedJob[] {
  for (const job of jobs) {
    if (!(typeof job.lease_token === 'string' && job.lease_token.length > 0)) {
      throw new Error(`Embedding worker queue claimed job '${job.id}' without a lease token.`);
    }
  }
  return jobs as EmbeddingWorkerClaimedJob[];
}

function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function readPositiveInteger(value: unknown, label: string): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return numberValue;
}

function parseTursoJsonObject(raw: string | null, label: string): Record<string, unknown> {
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    tursoStorageLogger.warn(`${label}: failed to parse JSON`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function readTursoModelCapabilities(raw: string | null): {
  type?: string;
  defaultDimension?: number;
} {
  const value = parseTursoJsonObject(raw, 'Turso model capabilities');
  const result: { type?: string; defaultDimension?: number } = {};
  if (typeof value['type'] === 'string') {
    result.type = value['type'];
  }
  if (typeof value['defaultDimension'] === 'number') {
    result.defaultDimension = value['defaultDimension'];
  }
  return result;
}

function readTursoModelParameters(raw: string | null): {
  size?: string;
  contextWindow?: number;
} {
  const value = parseTursoJsonObject(raw, 'Turso model parameters');
  const result: { size?: string; contextWindow?: number } = {};
  if (typeof value['size'] === 'string') {
    result.size = value['size'];
  }
  if (typeof value['contextWindow'] === 'number') {
    result.contextWindow = value['contextWindow'];
  }
  return result;
}

function createTursoEmbeddingStatsRefreshController(
  db: BrainstrikeDbExecutionClient,
  options: EmbeddingWorkerStatsControllerOptions
): EmbeddingStatsRefreshController {
  return createEmbeddingStatsRefreshControllerWithOperations(options, {
    markDirty: (embeddingSetIds) => markTursoCollectionIndexingStatsDirty(db, embeddingSetIds),
    refresh: (embeddingSetIds) =>
      db.transaction((tx) => refreshTursoCollectionIndexingStats(tx, embeddingSetIds)),
  });
}

async function assertTursoEmbeddingStorageReady(db: BrainstrikeDbExecutionClient): Promise<void> {
  const columns = await db.query<TursoTableColumnRow>('PRAGMA table_info(file_chunks)');
  const embeddingColumn = columns.rows.find(
    (column: TursoTableColumnRow) => column.name === 'embedding'
  );
  if (!embeddingColumn) {
    throw new Error('Turso file_chunks.embedding column is missing.');
  }
  if (embeddingColumn.type.toUpperCase() !== 'BLOB') {
    throw new Error(
      `Turso file_chunks.embedding column must be BLOB, received ${embeddingColumn.type}.`
    );
  }
  await db.query('SELECT vector32(?) AS embedding', [JSON.stringify([0])]);
}

async function getTursoModelConfig(
  db: BrainstrikeDbExecutionClient,
  modelId: string,
  cache: Map<string, ModelConfig | null>
): Promise<ModelConfig | null> {
  const cached = cache.get(modelId);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const result = await db.query<TursoModelRow>(
      `SELECT id,
              provider_id AS "providerId",
              name,
              description,
              capabilities,
              parameters
         FROM models
        WHERE id = ?
        LIMIT 1`,
      [modelId]
    );
    const row = result.rows[0];
    if (!row) {
      cache.set(modelId, null);
      return null;
    }
    const capabilities = readTursoModelCapabilities(row.capabilities);
    const parameters = readTursoModelParameters(row.parameters);
    const modelConfig: ModelConfig = {
      id: row.id,
      name: row.name,
      dimensions: capabilities.defaultDimension ?? DEFAULT_EMBEDDING_DIMENSION,
      quantized: false,
      description: row.description ?? '',
      tags: [row.providerId, capabilities.type ?? 'embedding'].filter(Boolean),
      origin: row.providerId,
      ...(parameters.size === undefined ? {} : { size: parameters.size }),
      ...(parameters.contextWindow === undefined
        ? {}
        : { contextWindow: parameters.contextWindow }),
    };
    cache.set(modelId, modelConfig);
    return modelConfig;
  } catch (error) {
    tursoStorageLogger.error('getTursoModelConfig: query failed', {
      error: error instanceof Error ? error.message : String(error),
      modelId,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

async function loadTursoChunksByIds(
  db: BrainstrikeDbExecutionClient,
  ids: readonly string[]
): Promise<EmbedChunkRow[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return [];
  }
  const result = await db.query<EmbedChunkRow>(
    `SELECT id,
            content,
            content_hash AS "contentHash",
            embedding_hash AS "embeddingHash",
            embedding_set_id AS "embeddingSetId"
       FROM file_chunks
      WHERE id IN (${createPlaceholders(uniqueIds.length)})
      ORDER BY id`,
    uniqueIds
  );
  return [...result.rows];
}

async function resolveTursoEmbeddingSetDimension(
  db: BrainstrikeDbExecutionClient,
  embeddingSetId: string
): Promise<number> {
  const result = await db.query<{ dimensions: number | string | null }>(
    'SELECT dimensions FROM embedding_sets WHERE id = ? LIMIT 1',
    [embeddingSetId]
  );
  return readPositiveInteger(
    result.rows[0]?.dimensions,
    `Embedding set ${embeddingSetId} dimension metadata`
  );
}

export async function createPGliteEmbeddingWorkerStorage(
  db: IDatabase
): Promise<EmbeddingWorkerStorage> {
  const fileChunkIdType = await resolveIdType(db, 'file_chunks');
  const queue = new JobQueue(db);

  return {
    assertEmbeddingStorageReady: () => assertVectorEmbeddingColumn(db),
    createStatsRefreshController: (options) =>
      createEmbeddingStatsRefreshController({
        completedChunkThreshold: options.completedChunkThreshold,
        db,
        log: options.log,
        minIntervalMs: options.minIntervalMs,
        now: options.now,
      }),
    getModelConfig: (modelId) => getModelConfigFromDb(db, modelId),
    loadChunksByIds: (ids) => loadChunksBatch(db, [...ids], fileChunkIdType),
    queue: {
      claimMany: async (params) => assertClaimedJobs(await queue.claimMany(params)),
      completeBatch: (jobs) => queue.completeBatch(jobs),
      completeEmbeddingChunkBatch: (jobs) => queue.completeEmbeddingChunkBatch(jobs),
      fail: (params) => queue.fail(params),
      failBatch: (params) => queue.failBatch(params),
      heartbeatBatch: (jobs, extendMs) => queue.heartbeatBatch(jobs, extendMs),
    },
    resolveEmbeddingSetDimension: (embeddingSetId) =>
      resolveEmbeddingSetDimension(db, embeddingSetId),
  };
}

export function createTursoEmbeddingWorkerStorage(
  db: BrainstrikeDbExecutionClient
): EmbeddingWorkerStorage {
  const queue = new TursoJobQueue(db);
  const modelConfigCache = new Map<string, ModelConfig | null>();
  return {
    assertEmbeddingStorageReady: () => assertTursoEmbeddingStorageReady(db),
    createStatsRefreshController: (options) =>
      createTursoEmbeddingStatsRefreshController(db, options),
    getModelConfig: (modelId) => getTursoModelConfig(db, modelId, modelConfigCache),
    loadChunksByIds: (ids) => loadTursoChunksByIds(db, ids),
    queue: {
      claimMany: async (params) => assertClaimedJobs(await queue.claimMany(params)),
      completeBatch: (jobs) => queue.completeBatch(jobs),
      completeEmbeddingChunkBatch: (jobs) => queue.completeEmbeddingChunkBatch(jobs),
      fail: (params) => queue.fail(params),
      failBatch: (params) => queue.failBatch(params),
      heartbeatBatch: (jobs, extendMs) => queue.heartbeatBatch(jobs, extendMs),
    },
    resolveEmbeddingSetDimension: (embeddingSetId) =>
      resolveTursoEmbeddingSetDimension(db, embeddingSetId),
  };
}

export async function resolveEmbeddingWorkerStorage(options: {
  db?: IDatabase | undefined;
  storage?: EmbeddingWorkerStorage | undefined;
}): Promise<EmbeddingWorkerStorage> {
  if (options.storage) {
    return options.storage;
  }
  if (!options.db) {
    throw new Error('Embedding worker requires either a database handle or a storage port.');
  }
  return createPGliteEmbeddingWorkerStorage(options.db);
}
