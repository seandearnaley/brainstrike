import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEmbeddingTelemetrySnapshot,
  resetEmbeddingTelemetryForTests,
} from '../src/embedding-telemetry';
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
    dtype: 'fp32',
    id: 'embed-1',
    model: 'local:test-model',
    texts: ['hello'],
    type: 'embed',
  };
}

function createPipelineCacheEntry() {
  return {
    cacheKey: 'local:test-model|wasm|fp32',
    createdAt: 1000,
    device: 'wasm' as const,
    dtype: 'fp32' as const,
    lastUsedAt: 1000,
    memory: {
      gpuBytes: null,
      heapBytes: null,
      reason: 'browser-runtime-unavailable' as const,
    },
    model: 'local:test-model',
    residencyMs: 0,
  };
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('StreamingEmbeddingWorkerClient', () => {
  beforeEach(() => {
    resetEmbeddingTelemetryForTests();
  });

  it('aggregates streamed vectors through embed()', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    const embedPromise = client.embed(createRequest());
    await flushMicrotasks();
    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      peakVectorsInFlight: 1,
      startIndex: 0,
      transferBytes: 8,
      type: 'batch',
      vectors: [new Float32Array([1, 2])],
      vectorsInFlight: 1,
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
        pooling: 'mean',
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

    const entry = createPipelineCacheEntry();
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
      entries: [entry],
      entry,
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
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
      peakVectorsInFlight: 1,
      startIndex: 0,
      transferBytes: 12,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3])],
      vectorsInFlight: 1,
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
        pooling: 'mean',
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
    expect(getEmbeddingTelemetrySnapshot()).toMatchObject({
      batchTransfer: {
        batchCount: 1,
        totalBytes: 12,
      },
      cache: {
        residentCount: 1,
      },
      peakVectorsInFlight: 1,
    });

    client.terminate();
    expect(getEmbeddingTelemetrySnapshot()).toMatchObject({
      batchTransfer: {
        batchCount: 0,
        totalBytes: 0,
      },
      cache: {
        residentCount: 0,
      },
    });
  });

  it('forwards id-less diagnostics emitted during an active stream', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onDiagnostic = vi.fn();

    const streamPromise = client.stream({ ...createRequest(), texts: [] }, { onDiagnostic });
    await flushMicrotasks();

    const diagnostic = {
      cacheSize: 0,
      diagnostic: 'pipeline-cache',
      emittedAt: 1234,
      entries: [],
      event: 'invalidated',
      reason: 'device-lost',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
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
        pooling: 'mean',
      },
      type: 'complete',
    });

    await expect(streamPromise).resolves.toMatchObject({
      dimensions: 3,
      model: 'local:test-model',
    });
    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
  });

  it('terminally rejects a malformed request-scoped cache diagnostic', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onDiagnostic = vi.fn();
    const streamPromise = client.stream(createRequest(), { onDiagnostic });
    await flushMicrotasks();

    worker.emitMessage({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 1000,
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    });

    await expect(streamPromise).rejects.toThrow(
      'Embedding worker pipeline-cache diagnostic.loaded requires an entry.'
    );
    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(getEmbeddingTelemetrySnapshot().cache.residentCount).toBe(0);
  });

  it('terminally rejects a cache hit that reports an empty cache', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onDiagnostic = vi.fn();
    const streamPromise = client.stream(createRequest(), { onDiagnostic });
    await flushMicrotasks();

    worker.emitMessage({
      cacheSize: 0,
      diagnostic: 'pipeline-cache',
      emittedAt: 1000,
      entry: createPipelineCacheEntry(),
      event: 'hit',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    });

    await expect(streamPromise).rejects.toThrow(
      'Embedding worker pipeline-cache diagnostic.hit requires a positive cacheSize.'
    );
    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(getEmbeddingTelemetrySnapshot().cache.residentCount).toBe(0);
  });

  it('terminally rejects request-scoped cache hits that contradict tracked state', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const streamPromise = client.stream(createRequest());
    await flushMicrotasks();
    const residentEntry = createPipelineCacheEntry();

    worker.emitMessage({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 1000,
      entries: [residentEntry],
      entry: residentEntry,
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);
    worker.emitMessage({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 1001,
      entry: {
        ...residentEntry,
        cacheKey: 'local:other-model|wasm|fp32',
        model: 'local:other-model',
      },
      event: 'hit',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);

    await expect(streamPromise).rejects.toThrow(
      'Embedding telemetry cache hit must reference tracked resident cache state.'
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminally latches id-less cache hits that contradict tracked state', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const firstStream = client.stream({ ...createRequest(), texts: [] });
    await flushMicrotasks();
    const residentEntry = createPipelineCacheEntry();

    worker.emitMessage({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 1000,
      entries: [residentEntry],
      entry: residentEntry,
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);
    worker.emitMessage({
      id: 'embed-1',
      metadata: {
        batchSize: 1,
        device: 'wasm',
        dimensions: 3,
        dtype: 'fp32',
        elapsedMs: 1,
        fallbackApplied: false,
        model: 'local:test-model',
        pooling: 'mean',
      },
      type: 'complete',
    });
    await firstStream;

    worker.emitMessage({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 1001,
      entry: {
        ...residentEntry,
        cacheKey: 'local:other-model|wasm|fp32',
        model: 'local:other-model',
      },
      event: 'hit',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);

    await expect(client.stream(createRequest())).rejects.toThrow(
      'Embedding telemetry cache hit must reference tracked resident cache state.'
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminally rejects contradictory cache memory diagnostics', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const streamPromise = client.stream(createRequest());
    await flushMicrotasks();
    const entry = {
      ...createPipelineCacheEntry(),
      memory: {
        gpuBytes: 128,
        heapBytes: null,
        reason: 'model-size-unknown' as const,
      },
    };

    worker.emitMessage({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 1000,
      entries: [entry],
      entry,
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);

    await expect(streamPromise).rejects.toThrow(
      'Embedding worker pipeline-cache diagnostic.entry.memory must not report bytes when its reason is model-size-unknown.'
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminally latches a malformed id-less cache diagnostic', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    worker.emitMessage({
      cacheSize: 0,
      diagnostic: 'pipeline-cache',
      emittedAt: 1000,
      event: 'invalidated',
      reason: 'device-lost',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    });

    await expect(client.stream(createRequest())).rejects.toThrow(
      'Embedding worker pipeline-cache diagnostic.invalidated requires a full entries snapshot.'
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(getEmbeddingTelemetrySnapshot().cache.residentCount).toBe(0);
  });
  it.each([
    ['missing type', { diagnostic: 'pipeline-cache' }],
    ['incorrect type', { diagnostic: 'pipeline-cache', type: 'progress' }],
  ])('terminally latches an id-less cache diagnostic with %s', (_case, diagnostic) => {
    const worker = new MockWorker();
    new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    worker.emitMessage(diagnostic);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('terminally rejects malformed completion metadata', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const streamPromise = client.stream({ ...createRequest(), texts: [] });
    await flushMicrotasks();
    worker.emitMessage({ id: 'embed-1', metadata: undefined, type: 'complete' });
    await expect(streamPromise).rejects.toThrow('Embedding worker complete.metadata');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('records id-less cache eviction diagnostics after a stream completes', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const streamPromise = client.stream({ ...createRequest(), texts: [] });
    await flushMicrotasks();

    const entry = {
      cacheKey: 'local:test-model|wasm|fp32',
      createdAt: 1000,
      device: 'wasm' as const,
      dtype: 'fp32' as const,
      lastUsedAt: 1000,
      memory: {
        gpuBytes: 0,
        heapBytes: 128,
        reason: 'model-size-estimate' as const,
      },
      model: 'local:test-model',
      residencyMs: 0,
    };
    worker.emitMessage({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 1000,
      entries: [entry],
      entry,
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);
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
        pooling: 'mean',
      },
      type: 'complete',
    });
    await streamPromise;
    expect(getEmbeddingTelemetrySnapshot().cache.residentCount).toBe(1);

    worker.emitMessage({
      cacheSize: 0,
      diagnostic: 'pipeline-cache',
      emittedAt: 301_000,
      entries: [],
      entry,
      event: 'evicted',
      reason: 'idle-timeout',
      type: 'diagnostic',
      workerInstanceId: 'stream-worker-1',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);

    expect(getEmbeddingTelemetrySnapshot().cache.residentCount).toBe(0);
    client.terminate();
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

  it.each([
    [
      'synchronously',
      () => {
        throw new Error('batch ack failed');
      },
    ],
    [
      'asynchronously',
      async () => {
        throw new Error('batch ack failed');
      },
    ],
  ])('terminally fails when the batch handler rejects %s', async (_timing, onBatch) => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    const streamPromise = client.stream(createRequest(), {
      onBatch,
    });
    await flushMicrotasks();

    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      peakVectorsInFlight: 1,
      startIndex: 0,
      transferBytes: 12,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3])],
      vectorsInFlight: 1,
    } satisfies EmbedWorkerBatch);

    await expect(streamPromise).rejects.toThrow('batch ack failed');
    expect(worker.postMessage).not.toHaveBeenCalledWith({
      batchIndex: 0,
      id: 'embed-1',
      type: 'stream-ack',
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(getEmbeddingTelemetrySnapshot()).toMatchObject({
      batchTransfer: { batchCount: 0, totalBytes: 0 },
      cache: { residentCount: 0 },
    });
    await expect(client.stream(createRequest())).rejects.toThrow('batch ack failed');
  });

  it.each([
    ['transfer byte count', { transferBytes: 11 }],
    ['vector count', { endIndex: 2 }],
    ['vectors in flight', { vectorsInFlight: 2 }],
    ['peak vectors in flight', { peakVectorsInFlight: 0 }],
    ['safe integer fields', { batchIndex: Number.MAX_SAFE_INTEGER + 1 }],
    [
      'vector shape',
      {
        endIndex: 2,
        peakVectorsInFlight: 2,
        transferBytes: 20,
        vectors: [new Float32Array([1, 2]), new Float32Array([1, 2, 3])],
        vectorsInFlight: 2,
      },
    ],
  ])('terminally rejects a malformed batch with invalid %s', async (_field, override) => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onBatch = vi.fn();
    const streamPromise = client.stream(createRequest(), { onBatch });
    await flushMicrotasks();

    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      peakVectorsInFlight: 1,
      startIndex: 0,
      transferBytes: 12,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3])],
      vectorsInFlight: 1,
      ...override,
    });

    await expect(streamPromise).rejects.toThrow('Embedding worker batch');
    expect(onBatch).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stream-ack' })
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(getEmbeddingTelemetrySnapshot()).toMatchObject({
      batchTransfer: { batchCount: 0, totalBytes: 0 },
      peakVectorsInFlight: 0,
    });
  });

  it('terminally rejects non-finite vector values before delivery or acknowledgement', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onBatch = vi.fn();
    const streamOutcome = client
      .stream(createRequest(), { onBatch })
      .catch((error: unknown) => error);
    await flushMicrotasks();

    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      peakVectorsInFlight: 1,
      startIndex: 0,
      transferBytes: 12,
      type: 'batch',
      vectors: [new Float32Array([1, Number.NaN, 3])],
      vectorsInFlight: 1,
    } satisfies EmbedWorkerBatch);
    await flushMicrotasks();

    expect(onBatch).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stream-ack' })
    );
    await expect(streamOutcome).resolves.toMatchObject({
      message: 'Embedding worker batch.vectors[0][1] must be finite.',
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminally rejects a vector dimension change before delivering the later batch', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onBatch = vi.fn();
    const streamOutcome = client
      .stream({ ...createRequest(), texts: ['hello', 'world'] }, { onBatch })
      .catch((error: unknown) => error);
    await flushMicrotasks();

    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      peakVectorsInFlight: 1,
      startIndex: 0,
      transferBytes: 12,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3])],
      vectorsInFlight: 1,
    } satisfies EmbedWorkerBatch);
    await flushMicrotasks();
    worker.emitMessage({
      batchIndex: 1,
      endIndex: 2,
      id: 'embed-1',
      peakVectorsInFlight: 1,
      startIndex: 1,
      transferBytes: 8,
      type: 'batch',
      vectors: [new Float32Array([4, 5])],
      vectorsInFlight: 1,
    } satisfies EmbedWorkerBatch);
    await flushMicrotasks();

    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(
      worker.postMessage.mock.calls.filter(([message]) => message?.type === 'stream-ack')
    ).toEqual([[{ batchIndex: 0, id: 'embed-1', type: 'stream-ack' }]]);
    await expect(streamOutcome).resolves.toMatchObject({
      message: 'Embedding worker batch vector dimensions changed from 3 to 2.',
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'duplicate batch index',
      { batchIndex: 0, endIndex: 2, startIndex: 1 },
      'batchIndex 0 does not match expected batchIndex 1',
    ],
    [
      'overlapping range',
      { batchIndex: 1, endIndex: 1, startIndex: 0 },
      'startIndex 0 does not match expected startIndex 1',
    ],
    [
      'range beyond the request',
      { batchIndex: 1, endIndex: 3, startIndex: 1 },
      'endIndex 3 exceeds request text count 2',
    ],
  ])(
    'terminally rejects an internally consistent batch with a %s',
    async (_condition, override, expectedMessage) => {
      const worker = new MockWorker();
      const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
      const onBatch = vi.fn();
      const request = { ...createRequest(), texts: ['hello', 'world'] };
      const streamPromise = client.stream(request, { onBatch });
      await flushMicrotasks();

      worker.emitMessage({
        batchIndex: 0,
        endIndex: 1,
        id: 'embed-1',
        peakVectorsInFlight: 1,
        startIndex: 0,
        transferBytes: 12,
        type: 'batch',
        vectors: [new Float32Array([1, 2, 3])],
        vectorsInFlight: 1,
      } satisfies EmbedWorkerBatch);
      await flushMicrotasks();

      const vectorCount = override.endIndex - override.startIndex;
      worker.emitMessage({
        batchIndex: override.batchIndex,
        endIndex: override.endIndex,
        id: 'embed-1',
        peakVectorsInFlight: vectorCount,
        startIndex: override.startIndex,
        transferBytes: vectorCount * 12,
        type: 'batch',
        vectors: Array.from({ length: vectorCount }, () => new Float32Array([4, 5, 6])),
        vectorsInFlight: vectorCount,
      } satisfies EmbedWorkerBatch);

      await expect(streamPromise).rejects.toThrow(expectedMessage);
      expect(onBatch).toHaveBeenCalledTimes(1);
      expect(
        worker.postMessage.mock.calls.filter(([message]) => message?.type === 'stream-ack')
      ).toEqual([[{ batchIndex: 0, id: 'embed-1', type: 'stream-ack' }]]);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(getEmbeddingTelemetrySnapshot()).toMatchObject({
        batchTransfer: { batchCount: 0, totalBytes: 0 },
        peakVectorsInFlight: 0,
      });
    }
  );

  it('terminally rejects completion before every requested text has a vector', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onBatch = vi.fn();
    const streamPromise = client.stream(
      { ...createRequest(), texts: ['hello', 'world'] },
      { onBatch }
    );
    await flushMicrotasks();

    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      peakVectorsInFlight: 1,
      startIndex: 0,
      transferBytes: 12,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3])],
      vectorsInFlight: 1,
    } satisfies EmbedWorkerBatch);
    await flushMicrotasks();
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
        pooling: 'mean',
      },
      type: 'complete',
    });

    await expect(streamPromise).rejects.toThrow(
      'Embedding worker completed after 1 of 2 requested texts.'
    );
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects a queued stream before posting when the active stream terminally fails', async () => {
    const worker = new MockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);

    const firstOutcome = client
      .stream(createRequest(), {
        onBatch: async () => {
          throw new Error('active batch failed');
        },
      })
      .catch((error: unknown) => error);
    const secondOutcome = client
      .stream({ ...createRequest(), id: 'embed-2' })
      .catch((error: unknown) => error);
    await flushMicrotasks();

    worker.emitMessage({
      batchIndex: 0,
      endIndex: 1,
      id: 'embed-1',
      peakVectorsInFlight: 1,
      startIndex: 0,
      transferBytes: 12,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3])],
      vectorsInFlight: 1,
    } satisfies EmbedWorkerBatch);

    await expect(firstOutcome).resolves.toMatchObject({ message: 'active batch failed' });
    await flushMicrotasks();
    const postedRequestIds = worker.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.type === 'stream-embed')
      .map((message) => message.request.id);

    client.terminate();

    await expect(secondOutcome).resolves.toMatchObject({ message: 'active batch failed' });
    expect(postedRequestIds).toEqual(['embed-1']);
    expect(worker.terminate).toHaveBeenCalledTimes(2);
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
