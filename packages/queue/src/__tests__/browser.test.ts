import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueAdapter, QueueResult, TaskPayload } from '../types';

const createWorkerpoolAdapterMock = vi.hoisted(() => vi.fn());

vi.mock('../adapters/browser-workerpool', () => ({
  createWorkerpoolAdapter: createWorkerpoolAdapterMock,
}));

function createQueueAdapterStub(): QueueAdapter {
  return {
    add: vi.fn(
      async (_task: TaskPayload): Promise<QueueResult> => ({
        id: 'result',
        type: 'result',
        vectors: [new Float32Array([1, 2, 3])],
        metadata: {
          model: 'local:test',
          device: 'webgpu',
          dtype: 'fp16',
          batchSize: 1,
          elapsedMs: 1,
          fallbackApplied: false,
          dimensions: 3,
        },
      })
    ),
    addBulk: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    isPaused: false,
    isProcessing: false,
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  };
}

describe('createBrowserEmbeddingQueue', () => {
  beforeEach(() => {
    vi.resetModules();
    createWorkerpoolAdapterMock.mockReset();
    vi.stubGlobal('window', {} as Window & typeof globalThis);
    (globalThis as typeof globalThis & { Worker?: typeof Worker }).Worker =
      class WorkerStub {} as unknown as typeof Worker;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not construct the workerpool adapter until queue work starts', async () => {
    const adapter = createQueueAdapterStub();
    createWorkerpoolAdapterMock.mockReturnValue(adapter);

    const { createBrowserEmbeddingQueue } = await import('../browser');
    const queue = createBrowserEmbeddingQueue({
      worker: { workerUrl: '/embedding.worker.js' },
    });

    expect(createWorkerpoolAdapterMock).not.toHaveBeenCalled();
    expect(queue.isProcessing).toBe(false);

    await queue.add({
      id: 'task-1',
      kind: 'embed',
      texts: ['hello'],
      model: 'local:test',
      deviceHint: 'webgpu',
    });

    expect(createWorkerpoolAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('retries adapter creation after an initial lazy import failure', async () => {
    const adapter = createQueueAdapterStub();
    createWorkerpoolAdapterMock
      .mockImplementationOnce(() => {
        throw new Error('workerpool bootstrap failed');
      })
      .mockReturnValueOnce(adapter);

    const { createBrowserEmbeddingQueue } = await import('../browser');
    const queue = createBrowserEmbeddingQueue({
      worker: { workerUrl: '/embedding.worker.js' },
    });

    await expect(
      queue.add({
        id: 'task-1',
        kind: 'embed',
        texts: ['hello'],
        model: 'local:test',
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('workerpool bootstrap failed');

    await expect(
      queue.add({
        id: 'task-2',
        kind: 'embed',
        texts: ['world'],
        model: 'local:test',
        deviceHint: 'webgpu',
      })
    ).resolves.toMatchObject({ id: 'result', type: 'result' });

    expect(createWorkerpoolAdapterMock).toHaveBeenCalledTimes(2);
  });

  it('waits for the lazy adapter bootstrap before canceling', async () => {
    const adapter = createQueueAdapterStub();
    createWorkerpoolAdapterMock.mockReturnValue(adapter);

    const { createBrowserEmbeddingQueue } = await import('../browser');
    const queue = createBrowserEmbeddingQueue({
      worker: { workerUrl: '/embedding.worker.js' },
    });

    const addPromise = queue.add({
      id: 'task-1',
      kind: 'embed',
      texts: ['hello'],
      model: 'local:test',
      deviceHint: 'webgpu',
    });
    const cancelPromise = queue.cancel();

    await cancelPromise;
    await addPromise;

    expect(adapter.cancel).toHaveBeenCalledTimes(1);
  });

  it('waits for the lazy adapter bootstrap before draining', async () => {
    const adapter = createQueueAdapterStub();
    createWorkerpoolAdapterMock.mockReturnValue(adapter);

    const { createBrowserEmbeddingQueue } = await import('../browser');
    const queue = createBrowserEmbeddingQueue({
      worker: { workerUrl: '/embedding.worker.js' },
    });

    const addPromise = queue.add({
      id: 'task-1',
      kind: 'embed',
      texts: ['hello'],
      model: 'local:test',
      deviceHint: 'webgpu',
    });
    const drainPromise = queue.drain();

    await drainPromise;
    await addPromise;

    expect(adapter.drain).toHaveBeenCalledTimes(1);
  });
});
