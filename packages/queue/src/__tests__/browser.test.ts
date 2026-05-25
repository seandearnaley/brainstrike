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

async function expectPromiseToSettle<T>(promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Promise did not settle within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
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

    await expectPromiseToSettle(
      queue.add({
        id: 'task-1',
        kind: 'embed',
        texts: ['hello'],
        model: 'local:test',
        deviceHint: 'webgpu',
      })
    );

    expect(createWorkerpoolAdapterMock).toHaveBeenCalledTimes(1);
  }, 15_000);

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
      expectPromiseToSettle(
        queue.add({
          id: 'task-1',
          kind: 'embed',
          texts: ['hello'],
          model: 'local:test',
          deviceHint: 'webgpu',
        })
      )
    ).rejects.toThrow('workerpool bootstrap failed');

    await expect(
      expectPromiseToSettle(
        queue.add({
          id: 'task-2',
          kind: 'embed',
          texts: ['world'],
          model: 'local:test',
          deviceHint: 'webgpu',
        })
      )
    ).resolves.toMatchObject({ id: 'result', type: 'result' });

    expect(createWorkerpoolAdapterMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('waits for the lazy adapter bootstrap before canceling', async () => {
    const adapter = createQueueAdapterStub();
    createWorkerpoolAdapterMock.mockReturnValue(adapter);

    const { createBrowserEmbeddingQueue } = await import('../browser');
    const queue = createBrowserEmbeddingQueue({
      worker: { workerUrl: '/embedding.worker.js' },
    });

    const addPromise = expectPromiseToSettle(
      queue.add({
        id: 'task-1',
        kind: 'embed',
        texts: ['hello'],
        model: 'local:test',
        deviceHint: 'webgpu',
      })
    );
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

    const addPromise = expectPromiseToSettle(
      queue.add({
        id: 'task-1',
        kind: 'embed',
        texts: ['hello'],
        model: 'local:test',
        deviceHint: 'webgpu',
      })
    );
    const drainPromise = queue.drain();

    await drainPromise;
    await addPromise;

    expect(adapter.drain).toHaveBeenCalledTimes(1);
  });

  it('treats cancel as a safe no-op when lazy adapter bootstrap fails', async () => {
    createWorkerpoolAdapterMock.mockImplementation(() => {
      throw new Error('workerpool bootstrap failed');
    });

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

    await expect(queue.cancel()).resolves.toBeUndefined();
  });

  it('treats drain as a safe no-op when lazy adapter bootstrap fails', async () => {
    createWorkerpoolAdapterMock.mockImplementation(() => {
      throw new Error('workerpool bootstrap failed');
    });

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

    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('rejects work after dispose even when the lazy adapter was never bootstrapped', async () => {
    const { createBrowserEmbeddingQueue } = await import('../browser');
    const queue = createBrowserEmbeddingQueue({
      worker: { workerUrl: '/embedding.worker.js' },
    });

    await expect(queue.dispose?.()).resolves.toBeUndefined();
    await expect(
      queue.add({
        id: 'task-after-dispose',
        kind: 'embed',
        texts: ['hello'],
        model: 'local:test',
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('Adapter has been disposed');

    expect(createWorkerpoolAdapterMock).not.toHaveBeenCalled();
  });

  it('rejects work after cancel even when the lazy adapter was never bootstrapped', async () => {
    const { createBrowserEmbeddingQueue } = await import('../browser');
    const queue = createBrowserEmbeddingQueue({
      worker: { workerUrl: '/embedding.worker.js' },
    });

    await queue.cancel();
    await expect(
      queue.add({
        id: 'task-after-cancel',
        kind: 'embed',
        texts: ['hello'],
        model: 'local:test',
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('Adapter has been canceled');

    expect(createWorkerpoolAdapterMock).not.toHaveBeenCalled();
  });

  it('clears stale listener unsubscribe handles when adapter bootstrap fails', async () => {
    const unsubscribe = vi.fn();
    const adapter = createQueueAdapterStub();
    adapter.onProgress = vi.fn(() => unsubscribe);
    createWorkerpoolAdapterMock
      .mockImplementationOnce(() => {
        throw new Error('workerpool bootstrap failed');
      })
      .mockReturnValueOnce(adapter);

    const { createBrowserEmbeddingQueue } = await import('../browser');
    const queue = createBrowserEmbeddingQueue({
      worker: { workerUrl: '/embedding.worker.js' },
    });
    const listener = vi.fn();
    queue.onProgress(listener);

    await expect(
      queue.add({
        id: 'task-1',
        kind: 'embed',
        texts: ['hello'],
        model: 'local:test',
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('workerpool bootstrap failed');

    const off = queue.onProgress(listener);
    await queue.add({
      id: 'task-2',
      kind: 'embed',
      texts: ['world'],
      model: 'local:test',
      deviceHint: 'webgpu',
    });

    expect(adapter.onProgress).toHaveBeenCalled();
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
