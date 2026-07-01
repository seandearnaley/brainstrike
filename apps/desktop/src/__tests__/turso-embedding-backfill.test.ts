import { buildEmbeddingJobDedupeKey, type EnqueueParams } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { createTursoEmbeddingBackfillRunner } from '../turso-embedding-backfill';

describe('createTursoEmbeddingBackfillRunner', () => {
  it('enqueues Turso embedding backfill candidates and waits for scoped drain', async () => {
    let queueCounts = { failed: 0, queued: 0, running: 0, succeeded: 0 };
    const enqueueBatch = vi.fn(async (jobs: EnqueueParams[]) => {
      queueCounts = {
        failed: 0,
        queued: 0,
        running: 0,
        succeeded: queueCounts.succeeded + jobs.length,
      };
      return jobs.map((job, index) => ({ id: `job-${index}`, ...job }));
    });
    const runner = createTursoEmbeddingBackfillRunner({
      chunkRepository: {
        countEmbeddingBackfillCandidates: vi.fn(async () => 2),
        findEmbeddingBackfillCandidates: vi.fn(async () => [
          { contentHash: 'hash-a', fileRecordId: 'file-a', id: 'chunk-a' },
          { contentHash: 'hash-b', fileRecordId: 'file-b', id: 'chunk-b' },
        ]),
      },
      embeddingSetsRepository: {
        getById: vi.fn(async () => ({ dimensions: 768, modelKey: 'local::bge-m3' })),
      },
      jobQueue: {
        enqueueBatch,
        getEmbeddingSetQueueCounts: vi.fn(async () => queueCounts),
        getQueueStats: vi.fn(async () => [
          {
            failed: 0,
            queue: 'embeddings',
            queued: 0,
            running: 0,
            succeeded: queueCounts.succeeded,
          },
        ]),
        repairUnclaimableQueued: vi.fn(async () => 0),
      },
    });
    const progress: [number, number][] = [];

    const result = await runner.enqueue('set-1', (done, total) => {
      progress.push([done, total]);
    });

    expect(result).toEqual({ failed: 0, queued: 0, running: 0, succeeded: 2 });
    expect(enqueueBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        dedupeKey: buildEmbeddingJobDedupeKey('chunk-a', 'set-1', 'hash-a'),
        jobType: 'embed_chunk',
        payload: {
          chunkId: 'chunk-a',
          embeddingSetId: 'set-1',
          expectedDimension: 768,
          fileRecordId: 'file-a',
          modelKey: 'local::bge-m3',
        },
        queue: 'embeddings',
      }),
      expect.objectContaining({
        dedupeKey: buildEmbeddingJobDedupeKey('chunk-b', 'set-1', 'hash-b'),
        payload: expect.objectContaining({ chunkId: 'chunk-b', fileRecordId: 'file-b' }),
      }),
    ]);
    expect(progress).toContainEqual([0, 2]);
    expect(progress).toContainEqual([2, 2]);
  });

  it('fails when a run-created Turso job fails even if the total failed count is unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
    const failureDuringMetadataResolutionAt = '2026-07-01T00:00:00.500Z';
    const countsBeforeAndAfter = { failed: 1, queued: 0, running: 0, succeeded: 0 };
    const getEmbeddingSetQueueCounts = vi.fn(
      async (
        _queue: string,
        _embeddingSetId: string,
        options?: { readonly updatedAfter?: string }
      ) =>
        options?.updatedAfter
          ? {
              failed: options.updatedAfter <= failureDuringMetadataResolutionAt ? 1 : 0,
              queued: 0,
              running: 0,
              succeeded: 0,
            }
          : countsBeforeAndAfter
    );
    const runner = createTursoEmbeddingBackfillRunner({
      chunkRepository: {
        countEmbeddingBackfillCandidates: vi.fn(async () => 1),
        findEmbeddingBackfillCandidates: vi.fn(async () => [
          { contentHash: 'hash-a', fileRecordId: 'file-a', id: 'chunk-a' },
        ]),
      },
      embeddingSetsRepository: {
        getById: vi.fn(async () => {
          vi.setSystemTime(new Date('2026-07-01T00:00:01.000Z'));
          return { dimensions: 768, modelKey: 'local::bge-m3' };
        }),
      },
      jobQueue: {
        enqueueBatch: vi.fn(async (jobs: EnqueueParams[]) => jobs),
        getEmbeddingSetQueueCounts,
        getQueueStats: vi.fn(async () => [
          {
            failed: 1,
            queue: 'embeddings',
            queued: 0,
            running: 0,
            succeeded: 0,
          },
        ]),
        repairUnclaimableQueued: vi.fn(async () => 0),
      },
    });

    try {
      await expect(runner.enqueue('set-1', vi.fn())).rejects.toThrow(
        "Turso backfill failed for embedding set 'set-1': 1 job(s) failed."
      );
      expect(getEmbeddingSetQueueCounts).toHaveBeenCalledWith(
        'embeddings',
        'set-1',
        expect.objectContaining({ updatedAfter: '2026-07-01T00:00:00.000Z' })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
