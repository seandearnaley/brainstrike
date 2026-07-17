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
    deviceHint: 'wasm',
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

describe('StreamingEmbeddingWorkerClient', () => {
  it('aggregates streamed vectors through embed()', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    const embedPromise = client.embed(createRequest());
    await flushMicrotasks();

    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      startIndex: 0,
      type: 'batch',
      vectors: [new Float32Array([1, 2])],
    } satisfies EmbedWorkerBatch);
    worker.emitMessage({
      id: 'embed-1',
      metadata: {
        batchSize: 1,
        device: 'wasm',
        dimensions: 2,
        dtype: 'fp32',
        elapsedMs: 5,
        fallbackApplied: false,
        model: 'local:test-model',
      },
      type: 'complete',
    });

    await expect(embedPromise).resolves.toMatchObject({
      id: 'embed-1',
      metadata: expect.objectContaining({ dimensions: 2 }),
      type: 'result',
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
      onBatch,
      onDiagnostic,
      onProgress,
    });
    await flushMicrotasks();

    const [requestMessage] = worker.postMessage.mock.calls[0] ?? [];
    expect(requestMessage).toMatchObject({
      request: expect.objectContaining({
        id: 'embed-1',
      }),
      type: 'stream-embed',
    });

    worker.emitMessage({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
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
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);
    worker.emitMessage({
      id: 'embed-1',
      phase: 'embedding',
      progress: 0.5,
      type: 'progress',
    } satisfies EmbedWorkerProgress);
    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      startIndex: 0,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3])],
    } satisfies EmbedWorkerBatch);
    worker.emitMessage({
      id: 'embed-1',
      metadata: {
        batchSize: 1,
        device: 'wasm',
        dimensions: 3,
        dtype: 'fp32',
        elapsedMs: 12,
        fallbackApplied: false,
        model: 'local:test-model',
      },
      type: 'complete',
    });

    await expect(streamPromise).resolves.toMatchObject({
      dimensions: 3,
      model: 'local:test-model',
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
      batchIndex: 0,
      id: 'embed-1',
      type: 'stream-ack',
    });
  });

  it('forwards id-less diagnostics emitted during an active stream', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onDiagnostic = vi.fn();

    const streamPromise = client.stream(createRequest(), { onDiagnostic });
    await flushMicrotasks();

    const diagnostic = {
      cacheSize: 0,
      diagnostic: 'pipeline-cache',
      emittedAt: 1234,
      entries: [],
      event: 'invalidated',
      reason: 'device-lost',
      type: 'diagnostic',
    } satisfies EmbedWorkerPipelineCacheDiagnostic;
    worker.emitMessage(diagnostic);
    worker.emitMessage({
      id: 'embed-1',
      metadata: {
        batchSize: 1,
        device: 'wasm',
        dimensions: 3,
        dtype: 'fp32',
        elapsedMs: 12,
        fallbackApplied: false,
        model: 'local:test-model',
      },
      type: 'complete',
    });

    await expect(streamPromise).resolves.toMatchObject({
      dimensions: 3,
      model: 'local:test-model',
    });
    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
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
      id: 'other-request',
      phase: 'embedding',
      progress: 0.2,
      type: 'progress',
    });
    worker.emitMessage({
      phase: 'embedding',
      progress: 0.7,
      type: 'progress',
    });
    worker.emitMessage({
      id: 'embed-1',
      message: 'model exploded',
      type: 'error',
    });

    await expect(streamPromise).rejects.toThrow('model exploded');
    expect(onError).toHaveBeenCalledWith({
      id: 'embed-1',
      message: 'model exploded',
      type: 'error',
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
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      startIndex: 0,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3])],
    } satisfies EmbedWorkerBatch);

    await expect(streamPromise).rejects.toThrow('batch ack failed');
    expect(worker.postMessage).not.toHaveBeenCalledWith({
      batchIndex: 0,
      id: 'embed-1',
      type: 'stream-ack',
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
        createdWorkers.push({ options, url });
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
