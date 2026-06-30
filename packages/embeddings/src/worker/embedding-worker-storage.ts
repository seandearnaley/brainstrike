import { type IDatabase, type Job, JobQueue } from '@brainstrike/db';
import type { ModelConfig } from '../types';
import { getModelConfigFromDb } from './embedding-model-config';
import {
  createEmbeddingStatsRefreshController,
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
  claimMany(params: EmbeddingWorkerClaimParams): Promise<Job[]>;
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
    queue,
    resolveEmbeddingSetDimension: (embeddingSetId) =>
      resolveEmbeddingSetDimension(db, embeddingSetId),
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
