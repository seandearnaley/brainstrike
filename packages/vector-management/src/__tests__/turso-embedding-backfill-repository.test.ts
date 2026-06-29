import { describe, expect, it, vi } from 'vitest';
import { createTursoEmbeddingBackfillRepository } from '../vector-status/turso-embedding-backfill-repository';

describe('createTursoEmbeddingBackfillRepository', () => {
  it('maps the vector backfill repository contract onto Turso repositories', async () => {
    const chunkRepository = {
      countEmbeddingBackfillCandidates: vi.fn(async () => 3),
      findEmbeddingBackfillCandidates: vi.fn(async () => [
        { id: 'chunk-2', fileRecordId: 'file-2', contentHash: 'hash-2' },
      ]),
      getEmbeddingBackfillCandidateDiagnostics: vi.fn(async () => ({
        candidateCount: 3,
        chunkCount: 5,
        embeddedChunkCount: 2,
        failedJobs: 1,
        fileCount: 2,
        missingContentHashCount: 0,
        pendingChunkCount: 3,
        queuedOrRunningJobs: 2,
      })),
    };
    const embeddingSetsRepository = {
      getById: vi.fn(async () => ({
        dimensions: 384,
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      })),
    };
    const jobQueue = {
      getEmbeddingSetQueueCounts: vi.fn(async () => ({
        failed: 1,
        queued: 2,
        running: 3,
        succeeded: 4,
      })),
    };
    const repository = createTursoEmbeddingBackfillRepository({
      chunkRepository,
      embeddingSetsRepository,
      jobQueue,
    });

    await expect(repository.countBackfillCandidates('set-1')).resolves.toBe(3);
    await expect(
      repository.loadBackfillCandidateBatch({
        afterChunkId: 'chunk-1',
        embeddingSetId: 'set-1',
        limit: 10,
      })
    ).resolves.toEqual([{ id: 'chunk-2', fileRecordId: 'file-2', contentHash: 'hash-2' }]);
    await expect(repository.loadBackfillCandidateDiagnostics('set-1')).resolves.toEqual({
      chunkCount: 5,
      embeddedChunkCount: 2,
      failedJobs: 1,
      fileCount: 2,
      pendingChunkCount: 3,
      queuedOrRunningJobs: 2,
    });
    await expect(repository.getEmbeddingSetQueueCounts('set-1')).resolves.toEqual({
      failed: 1,
      queued: 2,
      running: 3,
      succeeded: 4,
    });
    await expect(repository.resolveEmbeddingSetJobMetadata('set-1')).resolves.toEqual({
      expectedDimension: 384,
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
    });

    expect(chunkRepository.countEmbeddingBackfillCandidates).toHaveBeenCalledWith('set-1', {
      queue: 'embeddings',
    });
    expect(chunkRepository.findEmbeddingBackfillCandidates).toHaveBeenCalledWith({
      afterChunkId: 'chunk-1',
      embeddingSetId: 'set-1',
      limit: 10,
      queue: 'embeddings',
    });
    expect(jobQueue.getEmbeddingSetQueueCounts).toHaveBeenCalledWith('embeddings', 'set-1');
  });

  it('fails closed when the Turso embedding set metadata is missing', async () => {
    const repository = createTursoEmbeddingBackfillRepository({
      chunkRepository: {
        countEmbeddingBackfillCandidates: vi.fn(),
        findEmbeddingBackfillCandidates: vi.fn(),
        getEmbeddingBackfillCandidateDiagnostics: vi.fn(),
      },
      embeddingSetsRepository: {
        getById: vi.fn(async () => null),
      },
      jobQueue: {
        getEmbeddingSetQueueCounts: vi.fn(),
      },
    });

    await expect(repository.resolveEmbeddingSetJobMetadata('missing-set')).rejects.toThrow(
      'Embedding set missing-set not found'
    );
  });
});
