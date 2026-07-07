import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';
import type { ProviderDimensionParameter, QueueAdapter, QueueResult } from '@brainstrike/queue';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserEmbeddingQueuePort,
  type QueueProgressEventDetail,
} from '../browser-queue-port';

const resultTemplate: QueueResult = {
  id: 'chunk-1',
  metadata: {
    batchSize: 1,
    device: 'wasm',
    dimensions: 2,
    dtype: 'fp16',
    elapsedMs: 12,
    fallbackApplied: false,
    model: 'test-model',
  },
  type: 'result',
  vectors: [new Float32Array([0.1, 0.2])],
};

function createAdapter(overrides: Partial<QueueAdapter> = {}): QueueAdapter {
  return {
    add: vi.fn(async () => resultTemplate),
    addBulk: vi.fn(async (tasks) => tasks.map(() => resultTemplate)),
    cancel: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    get isPaused() {
      return false;
    },
    get isProcessing() {
      return false;
    },
    onProgress: vi.fn(() => vi.fn()),
    pause: vi.fn(),
    resume: vi.fn(),
    ...overrides,
  };
}

const chunk = {
  content: 'Hello world',
  contentHash: 'hash',
  fileRecordId: 'file-1',
  id: 'chunk-1',
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
      chunkRepository,
      deviceHint: 'wasm',
      dispatchDrainEvent: drainListener,
      dispatchProgressEvent: progressDispatch,
      queue,
    });

    await port.enqueueBatch([chunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: 'set-1',
    });

    await vi.waitUntil(() => eventListener.mock.calls.length >= 2);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const addRequest = (queue.add as unknown as Mock).mock.calls[0]?.[0] as {
      targetDimension?: number;
      provider?: EmbeddingProviderType;
      dimensionParameter?: ProviderDimensionParameter;
      deviceHint: 'webgpu' | 'wasm';
    };
    expect(addRequest.targetDimension).toBe(768);
    expect(addRequest.provider).toBeUndefined();
    expect(addRequest.dimensionParameter).toBeUndefined();
    expect(addRequest.deviceHint).toBe('wasm');
    expect(chunkRepository.update).toHaveBeenCalledTimes(1);
    expect(eventListener).toHaveBeenCalled();

    const statuses = eventListener.mock.calls.map(
      (call) => (call[0] as QueueProgressEventDetail).status
    );
    expect(statuses).toContain('queued');
    expect(statuses).toContain('completed');

    const completion = eventListener.mock.calls.find(
      (call) => (call[0] as QueueProgressEventDetail).status === 'completed'
    )?.[0] as QueueProgressEventDetail | undefined;

    expect(completion).toMatchObject({
      chunkId: 'chunk-1',
      failed: 0,
      pending: 0,
      processed: 1,
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
      chunkRepository,
      deviceHint: 'wasm',
      dispatchProgressEvent: eventListener,
      queue,
    });

    await port.enqueueBatch([chunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventListener).toHaveBeenCalled();
    const errorEvent = eventListener.mock.calls.find(
      (call) => (call[0] as QueueProgressEventDetail).status === 'error'
    )?.[0] as QueueProgressEventDetail | undefined;
    expect(errorEvent).toMatchObject({
      chunkId: 'chunk-1',
      errorMessage: 'worker crashed',
      failed: 1,
      status: 'error',
    });
    expect(chunkRepository.update).not.toHaveBeenCalled();
  });

  it('resets progress counters between import sessions', async () => {
    const eventListener = vi.fn();
    const queue = createAdapter();
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };

    const port = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      dispatchProgressEvent: eventListener,
      queue,
    });

    const secondChunk = {
      ...chunk,
      contentHash: 'hash-2',
      id: 'chunk-2',
    };

    await port.enqueueBatch([chunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: 'set-1',
    });

    await vi.waitUntil(() =>
      eventListener.mock.calls.some(
        (call) =>
          (call[0] as QueueProgressEventDetail).status === 'completed' &&
          (call[0] as QueueProgressEventDetail).chunkId === 'chunk-1'
      )
    );

    const firstCompletion = eventListener.mock.calls.find(
      (call) =>
        (call[0] as QueueProgressEventDetail).status === 'completed' &&
        (call[0] as QueueProgressEventDetail).chunkId === 'chunk-1'
    )?.[0] as QueueProgressEventDetail | undefined;

    expect(firstCompletion).toMatchObject({
      processed: 1,
      totalQueued: 1,
    });

    port.resetProgress?.();

    await port.enqueueBatch([secondChunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: 'set-1',
    });

    await vi.waitUntil(() =>
      eventListener.mock.calls.some(
        (call) =>
          (call[0] as QueueProgressEventDetail).status === 'completed' &&
          (call[0] as QueueProgressEventDetail).chunkId === 'chunk-2'
      )
    );

    const secondCompletion = eventListener.mock.calls.find(
      (call) =>
        (call[0] as QueueProgressEventDetail).status === 'completed' &&
        (call[0] as QueueProgressEventDetail).chunkId === 'chunk-2'
    )?.[0] as QueueProgressEventDetail | undefined;

    expect(secondCompletion).toMatchObject({
      failed: 0,
      processed: 1,
      totalQueued: 1,
    });
  });

  it('rejects when queue scheduling is aborted before enqueue', async () => {
    const queue = createAdapter();
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };
    const controller = new AbortController();
    controller.abort();

    const port = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      queue,
    });

    await expect(
      port.enqueueBatch([chunk as never], 'file-1', {
        model: 'test-model',
        signal: controller.signal,
        targetEmbeddingSetId: 'set-1',
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips enqueue when model or repository is missing', async () => {
    const queue = createAdapter();
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };
    const portWithoutModel = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      queue,
    });
    const portWithoutRepository = createBrowserEmbeddingQueuePort({
      chunkRepository: null,
      deviceHint: 'wasm',
      queue,
    });

    await portWithoutModel.enqueueBatch([chunk as never], 'file-1', {
      targetEmbeddingSetId: 'set-1',
    });
    await portWithoutRepository.enqueueBatch([chunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: 'set-1',
    });

    expect(queue.add).not.toHaveBeenCalled();
    expect(chunkRepository.update).not.toHaveBeenCalled();
  });

  it('rejects chunks without browser content before scheduling', async () => {
    const queue = createAdapter();
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };
    const port = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      queue,
    });

    await expect(
      port.enqueueBatch([{ id: 'chunk-without-content' } as never], 'file-1', {
        model: 'test-model',
        targetEmbeddingSetId: 'set-1',
      })
    ).rejects.toThrow('Browser embedding queue requires chunk content.');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips chunks with empty content', async () => {
    const eventListener = vi.fn();
    const queue = createAdapter();
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };
    const port = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      dispatchProgressEvent: eventListener,
      queue,
    });

    await port.enqueueBatch([{ ...chunk, content: '' } as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: 'set-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queue.add).not.toHaveBeenCalled();
    expect(chunkRepository.update).not.toHaveBeenCalled();
    expect(eventListener).not.toHaveBeenCalled();
  });

  it('rejects when aborting during batch scheduling', async () => {
    const queue = createAdapter();
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };
    const controller = new AbortController();
    const firstChunk = {
      ...chunk,
      get content() {
        controller.abort();
        return 'Hello world';
      },
    };
    const port = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      queue,
    });

    await expect(
      port.enqueueBatch([firstChunk as never, { ...chunk, id: 'chunk-2' } as never], 'file-1', {
        model: 'test-model',
        signal: controller.signal,
        targetEmbeddingSetId: 'set-1',
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not reset progress while a chunk is pending', async () => {
    let resolveQueue: ((value: QueueResult) => void) | undefined;
    const eventListener = vi.fn();
    const queue = createAdapter({
      add: vi.fn(
        () =>
          new Promise<QueueResult>((resolve) => {
            resolveQueue = resolve;
          })
      ),
    });
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };
    const port = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      dispatchProgressEvent: eventListener,
      queue,
    });

    await port.enqueueBatch([chunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: 'set-1',
    });
    await vi.waitUntil(() =>
      eventListener.mock.calls.some(
        (call) => (call[0] as QueueProgressEventDetail).status === 'queued'
      )
    );

    port.resetProgress?.();
    resolveQueue?.(resultTemplate);

    await vi.waitUntil(() =>
      eventListener.mock.calls.some(
        (call) => (call[0] as QueueProgressEventDetail).status === 'completed'
      )
    );

    const completion = eventListener.mock.calls.find(
      (call) => (call[0] as QueueProgressEventDetail).status === 'completed'
    )?.[0] as QueueProgressEventDetail | undefined;
    expect(completion).toMatchObject({ processed: 1, totalQueued: 1 });
  });

  it('emits error progress for non-finite vectors', async () => {
    const eventListener = vi.fn();
    const queue = createAdapter({
      add: vi.fn(async () => ({
        ...resultTemplate,
        vectors: [new Float32Array([Number.POSITIVE_INFINITY])],
      })),
    });
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };
    const port = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      dispatchProgressEvent: eventListener,
      queue,
    });

    await port.enqueueBatch([chunk as never], 'file-1', {
      model: 'test-model',
      targetEmbeddingSetId: 'set-1',
    });

    await vi.waitUntil(() =>
      eventListener.mock.calls.some(
        (call) => (call[0] as QueueProgressEventDetail).status === 'error'
      )
    );

    const errorEvent = eventListener.mock.calls.find(
      (call) => (call[0] as QueueProgressEventDetail).status === 'error'
    )?.[0] as QueueProgressEventDetail | undefined;
    expect(errorEvent).toMatchObject({
      errorMessage: 'Embedding worker returned a non-finite vector',
      failed: 1,
    });
  });

  it('dispatches default browser progress and drain events', async () => {
    const progressListener = vi.fn();
    const drainListener = vi.fn();
    window.addEventListener('brainstrike:queue-progress', progressListener);
    window.addEventListener('brainstrike:queue-drained', drainListener);
    const queue = createAdapter();
    const chunkRepository = {
      update: vi.fn().mockResolvedValue(null),
    };
    const port = createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: 'wasm',
      queue,
    });

    try {
      await port.enqueueBatch([chunk as never], 'file-1', {
        model: 'test-model',
        targetEmbeddingSetId: 'set-1',
      });

      await vi.waitUntil(() => drainListener.mock.calls.length > 0);
    } finally {
      window.removeEventListener('brainstrike:queue-progress', progressListener);
      window.removeEventListener('brainstrike:queue-drained', drainListener);
    }

    expect(progressListener).toHaveBeenCalled();
    expect(drainListener).toHaveBeenCalled();
  });
});
