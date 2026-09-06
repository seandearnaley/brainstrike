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
      dedupeKey: (params as { dedupeKey: string }).dedupeKey,
      id: 'job-1',
      jobType: (params as { jobType: string }).jobType,
      queue: (params as { queue: string }).queue,
      state: 'queued',
    })),
    enqueueBatch: vi.fn(async (params: unknown[]) =>
      params.map((param, index) => ({
        dedupeKey: (param as { dedupeKey: string }).dedupeKey,
        id: `job-${index + 1}`,
        jobType: (param as { jobType: string }).jobType,
        queue: (param as { queue: string }).queue,
        state: 'queued',
      }))
    ),
  };
}

describe('createEmbeddingJobQueuePort', () => {
  it('enqueues persisted chunks through the pipeline-owned durable job payload contract', async () => {
    const db = { kind: 'db' };
    const queue = createRecordedQueue();
    const createQueue = vi.fn(() => queue);
    const port = createEmbeddingJobQueuePort({ createQueue, db });

    await port.enqueueBatch(
      [
        {
          contentHash: 'hash-1',
          embeddingSetId: 'chunk-set',
          id: 'chunk-1',
        },
      ],
      'file-1',
      {
        dimensionParameter: 'dimensions' satisfies ProviderDimensionParameter,
        model: 'local::bge-m3',
        provider: 'local' satisfies EmbeddingProviderType,
        targetDimension: 768,
        targetEmbeddingSetId: 'target-set',
      }
    );

    expect(createQueue).toHaveBeenCalledWith(db);
    expect(queue.enqueueBatch).toHaveBeenCalledOnce();
    expect(queue.enqueueBatch).toHaveBeenCalledWith([
      {
        dedupeKey: 'chunk-1:target-set:hash-1',
        jobType: 'embed_chunk',
        payload: {
          chunkId: 'chunk-1',
          dimensionParameter: 'dimensions',
          embeddingInputHash: 'a80aabf0d21d49164154d0972531edf40605eb595aff029c37bc74ca083a98df',
          embeddingSetId: 'target-set',
          expectedDimension: 768,
          fileRecordId: 'file-1',
          modelKey: 'local::bge-m3',
          provider: 'local',
          sourceContentHash: 'hash-1',
        },
        queue: 'embeddings',
      },
    ]);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('uses the transaction executor when one is provided', async () => {
    const db = { kind: 'db' };
    const tx = { kind: 'tx' };
    const queue = createRecordedQueue();
    const createQueue = vi.fn(() => queue);
    const port = createEmbeddingJobQueuePort({ createQueue, db });

    await port.enqueueBatch([{ contentHash: 'hash-1', id: 'chunk-1' }], 'file-1', {
      model: 'local::bge-m3',
      transaction: tx,
    });

    expect(createQueue).toHaveBeenCalledWith(tx);
  });

  it('hashes bare hosted model ids with the provider-qualified worker identity', async () => {
    const queue = createRecordedQueue();
    const port = createEmbeddingJobQueuePort({
      createQueue: () => queue,
      db: { kind: 'db' },
    });

    await port.enqueueBatch([{ contentHash: 'hash-1', id: 'chunk-1' }], 'file-1', {
      model: 'text-embedding-3-small',
      provider: 'openai',
    });

    expect(queue.enqueueBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        payload: expect.objectContaining({
          embeddingInputHash: 'cc48e54faf852e887cf52ea4b232e7c3db4773e5a55c0045e9ee06a8b4151b78',
          sourceContentHash: 'hash-1',
        }),
      }),
    ]);
  });

  it('fails fast instead of silently skipping chunks without required queue identity', async () => {
    const port = createEmbeddingJobQueuePort({
      createQueue: () => createRecordedQueue(),
      db: { kind: 'db' },
    });

    await expect(
      port.enqueueBatch([{ contentHash: 'hash-1', id: '' }], 'file-1', { model: 'local::bge-m3' })
    ).rejects.toThrow('Cannot enqueue embedding job for chunk without id.');
  });
});
