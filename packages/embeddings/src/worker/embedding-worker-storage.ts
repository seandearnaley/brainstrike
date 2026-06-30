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

function assertClaimedJobs(jobs: Job[]): EmbeddingWorkerClaimedJob[] {
  for (const job of jobs) {
    if (!(typeof job.lease_token === 'string' && job.lease_token.length > 0)) {
      throw new Error(`Embedding worker queue claimed job '${job.id}' without a lease token.`);
    }
  }
  return jobs as EmbeddingWorkerClaimedJob[];
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
