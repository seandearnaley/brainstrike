import { describe, expect, it, vi } from 'vitest';
import type { EmbedWorkerBatch, EmbedWorkerProgress, EmbedWorkerRequest } from '../src/shared';
import { StreamingEmbeddingWorkerClient } from '../src/streaming-worker-client';

class MockWorker {
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();

  addEventListener(
    type: string,
    listener: ((event: ErrorEvent) => void) | ((event: MessageEvent<unknown>) => void)
  ): void {
    if (type === 'error') {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    }
    if (type === 'message') {
      this.messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  removeEventListener(
    type: string,
    listener: ((event: ErrorEvent) => void) | ((event: MessageEvent<unknown>) => void)
  ): void {
    if (type === 'error') {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void);
    }
    if (type === 'message') {
      this.messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  postMessage = vi.fn();
  terminate = vi.fn();

  emitMessage(message: unknown): void {
    const event = { data: message } as MessageEvent<unknown>;
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }

  emitError(message: string): void {
    const event = { message } as ErrorEvent;
    for (const listener of this.errorListeners) {
      listener(event);
    }
  }
}

function createRequest(): EmbedWorkerRequest {
  return {
    type: 'embed',
    id: 'embed-1',
    model: 'local:test-model',
    texts: ['hello'],
    deviceHint: 'wasm',
  };
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('StreamingEmbeddingWorkerClient', () => {
  it('streams progress, batches, and completes successfully', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onProgress = vi.fn();
    const onBatch = vi.fn();

    const streamPromise = client.stream(createRequest(), {
      onProgress,
      onBatch,
    });
    await flushMicrotasks();

    const [requestMessage] = worker.postMessage.mock.calls[0] ?? [];
    expect(requestMessage).toMatchObject({
      type: 'stream-embed',
      request: expect.objectContaining({
        id: 'embed-1',
      }),
    });

    worker.emitMessage({
      type: 'progress',
      id: 'embed-1',
      phase: 'embedding',
      progress: 0.5,
    } satisfies EmbedWorkerProgress);
    worker.emitMessage({
      type: 'batch',
      id: 'embed-1',
      batchIndex: 0,
      startIndex: 0,
      endIndex: 1,
      vectors: [new Float32Array([1, 2, 3])],
    } satisfies EmbedWorkerBatch);
    worker.emitMessage({
      type: 'complete',
      id: 'embed-1',
      metadata: {
        model: 'local:test-model',
        device: 'wasm',
        dtype: 'fp32',
        batchSize: 1,
        elapsedMs: 12,
        fallbackApplied: false,
        dimensions: 3,
      },
    });

    await expect(streamPromise).resolves.toMatchObject({
      model: 'local:test-model',
      dimensions: 3,
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'stream-ack',
      id: 'embed-1',
      batchIndex: 0,
    });
  });

  it('latches worker error events as terminal failures', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    const pending = client.stream(createRequest());
    const pendingOutcome = pending.catch((error: unknown) => error);
    await flushMicrotasks();
    worker.emitError('embedding worker crashed');

    await expect(pendingOutcome).resolves.toMatchObject({
      message: 'Embedding worker runtime error: embedding worker crashed',
    });
    await expect(client.stream(createRequest())).rejects.toThrow(
      'Embedding worker runtime error: embedding worker crashed'
    );
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('rejects the active stream when terminate is called mid-flight', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    const pending = client.stream(createRequest());
    await flushMicrotasks();

    client.terminate();

    await expect(pending).rejects.toThrow('Embedding worker terminated during an active stream.');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
