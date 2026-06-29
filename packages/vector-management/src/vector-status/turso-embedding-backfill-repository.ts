import type {
  EmbeddingSet,
  JobQueueStateCounts,
  TursoEmbeddingBackfillCandidate,
  TursoEmbeddingBackfillCandidateDiagnostics,
  TursoEmbeddingBackfillCandidateOptions,
} from '@brainstrike/db';
import { canonicalizeEmbeddingProviderModelKey } from '@brainstrike/indexing-contract';
import {
  type BackfillCandidateDiagnostics,
  EMBEDDINGS_QUEUE,
  type EmbeddingBackfillRepository,
  type QueueCounts,
} from './vector-queue-service';

interface TursoBackfillChunkRepository {
  countEmbeddingBackfillCandidates(
    embeddingSetId: string,
    options?: { readonly queue?: string }
  ): Promise<number>;
  findEmbeddingBackfillCandidates(
    options: TursoEmbeddingBackfillCandidateOptions
  ): Promise<TursoEmbeddingBackfillCandidate[]>;
  getEmbeddingBackfillCandidateDiagnostics(
    embeddingSetId: string,
    options?: { readonly queue?: string }
  ): Promise<TursoEmbeddingBackfillCandidateDiagnostics>;
}

interface TursoBackfillEmbeddingSetsRepository {
  getById(id: string): Promise<Pick<EmbeddingSet, 'dimensions' | 'modelKey'> | null>;
}

interface TursoBackfillJobQueue {
  getEmbeddingSetQueueCounts(queue: string, embeddingSetId: string): Promise<JobQueueStateCounts>;
}

export interface TursoEmbeddingBackfillRepositoryDependencies {
  chunkRepository: TursoBackfillChunkRepository;
  embeddingSetsRepository: TursoBackfillEmbeddingSetsRepository;
  jobQueue: TursoBackfillJobQueue;
  queue?: string;
}

export function createTursoEmbeddingBackfillRepository(
  dependencies: TursoEmbeddingBackfillRepositoryDependencies
): EmbeddingBackfillRepository {
  const queue = dependencies.queue ?? EMBEDDINGS_QUEUE;
  return {
    countBackfillCandidates: (embeddingSetId) =>
      dependencies.chunkRepository.countEmbeddingBackfillCandidates(embeddingSetId, { queue }),
    getEmbeddingSetQueueCounts: async (embeddingSetId) =>
      toQueueCounts(await dependencies.jobQueue.getEmbeddingSetQueueCounts(queue, embeddingSetId)),
    loadBackfillCandidateBatch: ({ embeddingSetId, afterChunkId, limit }) =>
      dependencies.chunkRepository.findEmbeddingBackfillCandidates({
        afterChunkId,
        embeddingSetId,
        limit,
        queue,
      }),
    loadBackfillCandidateDiagnostics: async (embeddingSetId) =>
      toBackfillCandidateDiagnostics(
        await dependencies.chunkRepository.getEmbeddingBackfillCandidateDiagnostics(
          embeddingSetId,
          { queue }
        )
      ),
    resolveEmbeddingSetJobMetadata: async (embeddingSetId) => {
      const embeddingSet = await dependencies.embeddingSetsRepository.getById(embeddingSetId);
      if (!embeddingSet) {
        throw new Error(`Embedding set ${embeddingSetId} not found`);
      }
      const canonical = canonicalizeEmbeddingProviderModelKey(embeddingSet.modelKey);
      if (!canonical) {
        throw new Error(`Embedding set ${embeddingSetId} has invalid model_key metadata`);
      }
      const expectedDimension = Number(embeddingSet.dimensions);
      if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
        throw new Error(`Embedding set ${embeddingSetId} is missing dimension metadata`);
      }
      return {
        expectedDimension,
        modelKey: canonical.composite,
      };
    },
  };
}

function toQueueCounts(counts: JobQueueStateCounts): QueueCounts {
  return {
    failed: counts.failed,
    queued: counts.queued,
    running: counts.running,
    succeeded: counts.succeeded,
  };
}

function toBackfillCandidateDiagnostics(
  diagnostics: TursoEmbeddingBackfillCandidateDiagnostics
): BackfillCandidateDiagnostics {
  return {
    chunkCount: diagnostics.chunkCount,
    embeddedChunkCount: diagnostics.embeddedChunkCount,
    failedJobs: diagnostics.failedJobs,
    fileCount: diagnostics.fileCount,
    pendingChunkCount: diagnostics.pendingChunkCount,
    queuedOrRunningJobs: diagnostics.queuedOrRunningJobs,
  };
}
