import { describe, expect, it, vi } from 'vitest';
import type {
  EmbedWorkerBatch,
  EmbedWorkerPipelineCacheDiagnostic,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
} from '../src/shared';
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
  it('aggregates streamed vectors through embed()', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    const embedPromise = client.embed(createRequest());
    await flushMicrotasks();

    worker.emitMessage({
      type: 'batch',
      id: 'embed-1',
      batchIndex: 0,
      startIndex: 0,
      endIndex: 1,
      vectors: [new Float32Array([1, 2])],
    } satisfies EmbedWorkerBatch);
    worker.emitMessage({
      type: 'complete',
      id: 'embed-1',
      metadata: {
        model: 'local:test-model',
        device: 'wasm',
        dtype: 'fp32',
        batchSize: 1,
        elapsedMs: 5,
        fallbackApplied: false,
        dimensions: 2,
      },
    });

    await expect(embedPromise).resolves.toMatchObject({
      type: 'result',
      id: 'embed-1',
      metadata: expect.objectContaining({ dimensions: 2 }),
    });
    await expect(embedPromise).resolves.toMatchObject({
      vectors: [new Float32Array([1, 2])],
    });
  });

  it('streams progress, batches, and completes successfully', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onProgress = vi.fn();
    const onBatch = vi.fn();
    const onDiagnostic = vi.fn();

    const streamPromise = client.stream(createRequest(), {
      onProgress,
      onBatch,
      onDiagnostic,
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
      type: 'diagnostic',
      diagnostic: 'pipeline-cache',
      event: 'loaded',
      id: 'embed-1',
      cacheSize: 1,
      emittedAt: 1000,
      entries: [
        {
          cacheKey: 'local:test-model|wasm|fp32',
          createdAt: 1000,
          device: 'wasm',
          dtype: 'fp32',
          lastUsedAt: 1000,
          memory: {
            gpuBytes: null,
            heapBytes: null,
            reason: 'browser-runtime-unavailable',
          },
          model: 'local:test-model',
          residencyMs: 0,
        },
      ],
    } satisfies EmbedWorkerPipelineCacheDiagnostic);
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
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostic: 'pipeline-cache',
        event: 'loaded',
        id: 'embed-1',
      })
    );
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'stream-ack',
      id: 'embed-1',
      batchIndex: 0,
    });
  });

  it('ignores unrelated messages and rejects on worker error payloads', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onError = vi.fn();

    const streamPromise = client.stream(createRequest(), {
      onError,
    });
    await flushMicrotasks();

    worker.emitMessage('not-an-event');
    worker.emitMessage({
      type: 'progress',
      id: 'other-request',
      phase: 'embedding',
      progress: 0.2,
    });
    worker.emitMessage({
      type: 'error',
      id: 'embed-1',
      message: 'model exploded',
    });

    await expect(streamPromise).rejects.toThrow('model exploded');
    expect(onError).toHaveBeenCalledWith({
      type: 'error',
      id: 'embed-1',
      message: 'model exploded',
    });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('rejects when the batch handler fails', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    const streamPromise = client.stream(createRequest(), {
      onBatch: async () => {
        throw new Error('batch ack failed');
      },
    });
    await flushMicrotasks();

    worker.emitMessage({
      type: 'batch',
      id: 'embed-1',
      batchIndex: 0,
      startIndex: 0,
      endIndex: 1,
      vectors: [new Float32Array([1, 2, 3])],
    } satisfies EmbedWorkerBatch);

    await expect(streamPromise).rejects.toThrow('batch ack failed');
    expect(worker.postMessage).not.toHaveBeenCalledWith({
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

  it('creates a worker from an explicit workerUrl override', () => {
    const createdWorkers: Array<{ readonly url: string | URL; readonly options?: WorkerOptions }> =
      [];
    const originalWorker = globalThis.Worker;
    class ConstructableMockWorker extends MockWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super();
        createdWorkers.push({ url, options });
      }
    }
    vi.stubGlobal('Worker', ConstructableMockWorker as unknown as typeof Worker);

    try {
      const client = new StreamingEmbeddingWorkerClient({
        workerUrl: 'http://localhost/assets/embedding.worker.js',
      });

      expect(createdWorkers).toHaveLength(1);
      expect(String(createdWorkers[0]?.url)).toBe('http://localhost/assets/embedding.worker.js');
      expect(createdWorkers[0]?.options).toMatchObject({ type: 'module' });

      client.terminate();
    } finally {
      if (originalWorker) {
        vi.stubGlobal('Worker', originalWorker);
      } else {
        vi.unstubAllGlobals();
      }
    }
  });

  it('fails fast when no worker or workerUrl is provided', () => {
    expect(() => new StreamingEmbeddingWorkerClient()).toThrow(
      'StreamingEmbeddingWorkerClient requires an explicit worker or workerUrl.'
    );
  });
});
