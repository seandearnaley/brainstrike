import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbedWorkerBatch, EmbedWorkerComplete, EmbedWorkerRequest } from '../src/shared';
import { StreamingEmbeddingWorkerClient } from '../src/streaming-worker-client';

class CompletionMockWorker {
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();

  addEventListener(
    type: string,
    listener: ((event: ErrorEvent) => void) | ((event: MessageEvent<unknown>) => void)
  ): void {
    if (type === 'error') {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    } else if (type === 'message') {
      this.messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  removeEventListener(
    type: string,
    listener: ((event: ErrorEvent) => void) | ((event: MessageEvent<unknown>) => void)
  ): void {
    if (type === 'error') {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void);
    } else if (type === 'message') {
      this.messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  emitMessage(message: unknown): void {
    const event = { data: message } as MessageEvent<unknown>;
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }
}

function createRequest(overrides: Partial<EmbedWorkerRequest> = {}): EmbedWorkerRequest {
  return {
    deviceHint: 'wasm',
    dtype: 'fp32',
    id: 'completion-request',
    model: 'local:test-model',
    texts: ['hello'],
    type: 'embed',
    ...overrides,
  };
}

function createComplete(
  overrides: Partial<EmbedWorkerComplete['metadata']> = {}
): EmbedWorkerComplete {
  return {
    id: 'completion-request',
    metadata: {
      batchSize: 1,
      device: 'wasm',
      dimensions: 3,
      dtype: 'fp32',
      elapsedMs: 1,
      fallbackApplied: false,
      model: 'local:test-model',
      pooling: 'mean',
      ...overrides,
    },
    type: 'complete',
  };
}

async function startCompletedStream(
  request: EmbedWorkerRequest,
  complete: EmbedWorkerComplete
): Promise<{
  readonly outcome: Promise<EmbedWorkerComplete['metadata']>;
  readonly worker: CompletionMockWorker;
}> {
  const worker = new CompletionMockWorker();
  const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
  const outcome = client.stream(request);
  await Promise.resolve();
  worker.emitMessage({
    batchIndex: 0,
    endIndex: 1,
    id: request.id,
    peakVectorsInFlight: 1,
    startIndex: 0,
    transferBytes: 12,
    type: 'batch',
    vectors: [new Float32Array([1, 2, 3])],
    vectorsInFlight: 1,
  } satisfies EmbedWorkerBatch);
  await Promise.resolve();
  worker.emitMessage(complete);
  return { outcome, worker };
}

describe('streaming completion request correlation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['a'.repeat(40), 'b'.repeat(40)])(
    'correlates explicit model revision %s',
    async (revision) => {
      const requestedRevision = 'a'.repeat(40);
      const { outcome } = await startCompletedStream(
        createRequest({ revision: requestedRevision }),
        createComplete({ revision })
      );
      if (revision === requestedRevision) {
        await expect(outcome).resolves.toMatchObject({ revision });
      } else {
        await expect(outcome).rejects.toThrow('metadata.revision');
      }
    }
  );

  it.each([1, 3])(
    'rejects a catalog model completion that disagrees with its batch ceiling or observed batches: %d',
    async (batchSize) => {
      const model = 'jinaai/jina-embeddings-v2-base-code';
      const worker = new CompletionMockWorker();
      const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
      const outcome = client.stream(
        createRequest({
          dtype: 'fp32',
          maxBatchSize: 3,
          model,
          texts: ['hello', 'world', 'hello world'],
        })
      );
      await Promise.resolve();
      for (let batchIndex = 0; batchIndex < 3; batchIndex += 1) {
        worker.emitMessage({
          batchIndex,
          endIndex: batchIndex + 1,
          id: 'completion-request',
          peakVectorsInFlight: 1,
          startIndex: batchIndex,
          transferBytes: 12,
          type: 'batch',
          vectors: [new Float32Array([1, 2, 3])],
          vectorsInFlight: 1,
        } satisfies EmbedWorkerBatch);
        await Promise.resolve();
      }
      worker.emitMessage(createComplete({ batchSize, dtype: 'fp32', model }));
      await expect(outcome).rejects.toThrow(
        batchSize === 1 ? 'request batch size' : 'observed stream batches'
      );
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['model', createComplete({ model: 'local:other-model' }), 'metadata.model'],
    ['dtype', createComplete({ dtype: 'fp16' }), 'metadata.dtype'],
    ['device', createComplete({ device: 'webgpu' }), 'metadata.device'],
    ['fallback', createComplete({ fallbackApplied: true }), 'metadata.fallbackApplied'],
    ['batch size', createComplete({ batchSize: 2 }), 'metadata.batchSize'],
    ['pooling', createComplete({ pooling: 'cls' }), 'metadata.pooling'],
  ])(
    'terminally rejects completion metadata with a mismatched %s',
    async (_case, complete, message) => {
      const { outcome, worker } = await startCompletedStream(createRequest(), complete);

      await expect(outcome).rejects.toThrow(message);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['mean', 'cls'] as const)(
    'correlates the requested CLS pooling against a %s completion (BST-1993)',
    async (pooling) => {
      const { outcome } = await startCompletedStream(
        createRequest({ pooling: 'cls' }),
        createComplete({ pooling })
      );
      if (pooling === 'cls') {
        await expect(outcome).resolves.toMatchObject({ pooling: 'cls' });
      } else {
        await expect(outcome).rejects.toThrow('metadata.pooling');
      }
    }
  );

  it('accepts a coherent WebGPU-to-WASM fallback pair', async () => {
    const request = createRequest({ deviceHint: 'webgpu' });
    const complete = createComplete({ device: 'wasm', fallbackApplied: true });
    const { outcome } = await startCompletedStream(request, complete);

    await expect(outcome).resolves.toMatchObject({ device: 'wasm', fallbackApplied: true });
  });

  it('rejects a configured batch size that disagrees with observed batches', async () => {
    const worker = new CompletionMockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const request = createRequest({ texts: ['hello', 'world'] });
    const outcome = client.stream(request);
    await Promise.resolve();
    for (let batchIndex = 0; batchIndex < 2; batchIndex += 1) {
      worker.emitMessage({
        batchIndex,
        endIndex: batchIndex + 1,
        id: request.id,
        peakVectorsInFlight: 1,
        startIndex: batchIndex,
        transferBytes: 12,
        type: 'batch',
        vectors: [new Float32Array([1, 2, 3])],
        vectorsInFlight: 1,
      } satisfies EmbedWorkerBatch);
      await Promise.resolve();
    }
    worker.emitMessage(createComplete({ batchSize: 2 }));

    await expect(outcome).rejects.toThrow(
      'Embedding worker complete.metadata.batchSize does not match the observed stream batches.'
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('device-loss recovery', () => {
  it('keeps the worker available for an explicit request after typed device loss', async () => {
    const worker = new CompletionMockWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const first = client.stream(createRequest());
    await Promise.resolve();
    worker.emitMessage({
      cause: 'destroyed: test device',
      code: 'EMBEDDING_DEVICE_LOST',
      id: 'completion-request',
      message: 'device lost',
      type: 'error',
    });
    await expect(first).rejects.toMatchObject({
      cause: 'destroyed: test device',
      code: 'EMBEDDING_DEVICE_LOST',
      name: 'DeviceLost',
    });
    expect(worker.terminate).not.toHaveBeenCalled();
    const second = client.stream({ ...createRequest(), id: 'explicit-retry' });
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ id: 'explicit-retry' }) })
    );
    worker.emitMessage({ id: 'explicit-retry', message: 'ordinary failure', type: 'error' });
    await expect(second).rejects.toThrow('ordinary failure');
    client.terminate();
  });
});
