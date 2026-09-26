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
