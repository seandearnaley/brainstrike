import { expect, it, vi } from 'vitest';
import type { EmbedWorkerRequest } from '../src/shared';
import { StreamingEmbeddingWorkerClient } from '../src/streaming-worker-client';

class MockWorker {
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.messageListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.messageListeners.delete(listener);
    }
  }

  postMessage = vi.fn();
  terminate = vi.fn();
}

function createRequest(): EmbedWorkerRequest {
  return {
    deviceHint: 'wasm',
    dtype: 'fp32',
    id: 'embed-1',
    model: 'local:test-model',
    texts: ['hello'],
    type: 'embed',
  };
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

async function settlePromptly(
  promises: readonly Promise<unknown>[]
): Promise<PromiseSettledResult<unknown>[] | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(promises),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it('rejects queued streams when the owned worker is terminated', async () => {
  const worker = new MockWorker();
  const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
  const active = client.stream(createRequest());
  const queued = client.stream({ ...createRequest(), id: 'embed-queued' });
  await flushMicrotasks();

  client.terminate();

  await expect(active).rejects.toThrow('Embedding worker terminated during an active stream.');
  await expect(
    Promise.race([
      queued.then(
        () => 'completed',
        () => 'rejected'
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])
  ).resolves.toBe('rejected');
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it('terminates an active stream when its controller signal aborts', async () => {
  const worker = new MockWorker();
  const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
  const controller = new AbortController();
  const pending = client.stream(createRequest(), { signal: controller.signal });
  const queued = client.stream(
    { ...createRequest(), id: 'embed-queued' },
    { signal: controller.signal }
  );
  await flushMicrotasks();

  controller.abort();

  await expect(pending).rejects.toBe(controller.signal.reason);
  await expect(queued).rejects.toBe(controller.signal.reason);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it('settles an active stream and a queued stream when the queued signal aborts', async () => {
  const worker = new MockWorker();
  const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
  const activeController = new AbortController();
  const queuedController = new AbortController();
  const removeActiveListener = vi.spyOn(activeController.signal, 'removeEventListener');
  const removeQueuedListener = vi.spyOn(queuedController.signal, 'removeEventListener');
  const active = client.stream(createRequest(), { signal: activeController.signal });
  const queued = client.stream(
    { ...createRequest(), id: 'embed-queued' },
    { signal: queuedController.signal }
  );
  await flushMicrotasks();

  queuedController.abort();

  try {
    const outcome = await settlePromptly([active, queued]);
    expect(outcome).toEqual([
      { reason: queuedController.signal.reason, status: 'rejected' },
      { reason: queuedController.signal.reason, status: 'rejected' },
    ]);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(client.stream({ ...createRequest(), id: 'embed-later' })).rejects.toBe(
      queuedController.signal.reason
    );
    expect(removeActiveListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(removeQueuedListener).toHaveBeenCalledWith('abort', expect.any(Function));
  } finally {
    client.terminate();
    await Promise.allSettled([active, queued]);
  }
});

it('terminates an active stream when the queued signal was already aborted', async () => {
  const worker = new MockWorker();
  const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
  const active = client.stream(createRequest());
  await flushMicrotasks();
  const queuedController = new AbortController();
  queuedController.abort();
  const queued = client.stream(
    { ...createRequest(), id: 'embed-queued' },
    { signal: queuedController.signal }
  );

  try {
    const outcome = await settlePromptly([active, queued]);
    expect(outcome).toEqual([
      { reason: queuedController.signal.reason, status: 'rejected' },
      { reason: queuedController.signal.reason, status: 'rejected' },
    ]);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally {
    client.terminate();
    await Promise.allSettled([active, queued]);
  }
});
