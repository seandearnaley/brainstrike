import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserEmbeddingQueuePort,
  type QueueProgressEventDetail,
} from '../browser-queue-port';

const resultTemplate: QueueResult = {
  type: 'result',
  id: 'chunk-1',
  vectors: [new Float32Array([0.1, 0.2])],
  metadata: {
    model: 'test-model',
    device: 'wasm',
    dtype: 'fp16',
    batchSize: 1,
    elapsedMs: 12,
    fallbackApplied: false,
    dimensions: 2,
  },
};

function createAdapter(overrides: Partial<QueueAdapter> = {}): QueueAdapter {
  return {
    add: vi.fn(async () => resultTemplate),
    addBulk: vi.fn(async (tasks) => tasks.map(() => resultTemplate)),
    onProgress: vi.fn(() => vi.fn()),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(async () => {}),
    ...overrides,
  };
}

const chunk = {
  id: 'chunk-1',
  content: 'Hello world',
  fileRecordId: 'file-1',
  contentHash: 'hash',
};

describe('createBrowserEmbeddingQueuePort', () => {
  it('dispatches progress events for successful jobs', async () => {
    const eventListener = vi.fn();
    const progressDispatch = (detail: QueueProgressEventDetail) => {
      eventListener(detail);
    };
    const drainListener = vi.fn();
    const queue = createAdapter();
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };

    const port = createBrowserEmbeddingQueuePort({
      queue,
      chunkRepository,
      dispatchProgressEvent: progressDispatch,
      dispatchDrainEvent: drainListener,
    });

    await port.enqueueBatch([chunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: 'set-1',
    });

    await vi.waitUntil(() => eventListener.mock.calls.length >= 2);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(chunkRepository.update).toHaveBeenCalledTimes(1);
    expect(eventListener).toHaveBeenCalled();

    const statuses = eventListener.mock.calls.map(
      ([detail]: [QueueProgressEventDetail]) => detail.status
    );
    expect(statuses).toContain('queued');
    expect(statuses).toContain('completed');

    const completion = eventListener.mock.calls.find(
      ([detail]: [QueueProgressEventDetail]) => detail.status === 'completed'
    )?.[0];

    expect(completion).toMatchObject({
      chunkId: 'chunk-1',
      processed: 1,
      failed: 0,
      pending: 0,
      totalQueued: 1,
    });
    expect(drainListener).toHaveBeenCalledWith('set-1');
  });

  it('emits error progress when the queue add fails', async () => {
    const eventListener = vi.fn();
    const queue = createAdapter({
      add: vi.fn(async () => {
        throw new Error('worker crashed');
      }),
    });
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };

    const port = createBrowserEmbeddingQueuePort({
      queue,
      chunkRepository,
      dispatchProgressEvent: eventListener,
    });

    await port.enqueueBatch([chunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventListener).toHaveBeenCalled();
    const errorEvent = eventListener.mock.calls.find(
      ([detail]: [QueueProgressEventDetail]) => detail.status === 'error'
    )?.[0];
    expect(errorEvent).toMatchObject({
      status: 'error',
      chunkId: 'chunk-1',
      failed: 1,
      errorMessage: 'worker crashed',
    });
    expect(chunkRepository.update).not.toHaveBeenCalled();
  });
});
