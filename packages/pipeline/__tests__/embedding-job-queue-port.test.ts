import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingJobQueuePort } from '../src/index.js';

interface RecordedQueue {
  enqueue: ReturnType<typeof vi.fn>;
  enqueueBatch: ReturnType<typeof vi.fn>;
}

function createRecordedQueue(): RecordedQueue {
  return {
    enqueue: vi.fn(async (params: unknown) => ({
      id: 'job-1',
      queue: (params as { queue: string }).queue,
      jobType: (params as { jobType: string }).jobType,
      state: 'queued',
      dedupeKey: (params as { dedupeKey: string }).dedupeKey,
    })),
    enqueueBatch: vi.fn(async (params: unknown[]) =>
      params.map((param, index) => ({
        id: `job-${index + 1}`,
        queue: (param as { queue: string }).queue,
        jobType: (param as { jobType: string }).jobType,
        state: 'queued',
        dedupeKey: (param as { dedupeKey: string }).dedupeKey,
      }))
    ),
  };
}

describe('createEmbeddingJobQueuePort', () => {
  it('enqueues persisted chunks through the pipeline-owned durable job payload contract', async () => {
    const db = { kind: 'db' };
    const queue = createRecordedQueue();
    const createQueue = vi.fn(() => queue);
    const port = createEmbeddingJobQueuePort({ db, createQueue });

    await port.enqueueBatch(
      [
        {
          id: 'chunk-1',
          contentHash: 'hash-1',
          embeddingSetId: 'chunk-set',
        },
      ],
      'file-1',
      {
        model: 'local::bge-m3',
        targetEmbeddingSetId: 'target-set',
        targetDimension: 768,
        provider: 'local' satisfies EmbeddingProviderType,
        dimensionParameter: 'dimensions' satisfies ProviderDimensionParameter,
      }
    );

    expect(createQueue).toHaveBeenCalledWith(db);
    expect(queue.enqueueBatch).toHaveBeenCalledOnce();
    expect(queue.enqueueBatch).toHaveBeenCalledWith([
      {
        queue: 'embeddings',
        jobType: 'embed_chunk',
        payload: {
          chunkId: 'chunk-1',
          fileRecordId: 'file-1',
          embeddingSetId: 'target-set',
          expectedDimension: 768,
          modelKey: 'local::bge-m3',
          provider: 'local',
          dimensionParameter: 'dimensions',
        },
        dedupeKey: 'chunk-1:target-set:hash-1',
      },
    ]);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('uses the transaction executor when one is provided', async () => {
    const db = { kind: 'db' };
    const tx = { kind: 'tx' };
    const queue = createRecordedQueue();
    const createQueue = vi.fn(() => queue);
    const port = createEmbeddingJobQueuePort({ db, createQueue });

    await port.enqueueBatch([{ id: 'chunk-1', contentHash: 'hash-1' }], 'file-1', {
      model: 'local::bge-m3',
      transaction: tx,
    });

    expect(createQueue).toHaveBeenCalledWith(tx);
  });

  it('fails fast instead of silently skipping chunks without required queue identity', async () => {
    const port = createEmbeddingJobQueuePort({
      db: { kind: 'db' },
      createQueue: () => createRecordedQueue(),
    });

    await expect(
      port.enqueueBatch([{ id: '', contentHash: 'hash-1' }], 'file-1', { model: 'local::bge-m3' })
    ).rejects.toThrow('Cannot enqueue embedding job for chunk without id.');
  });
});
