import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueueAddCall = Parameters<QueueAdapter['add']>[0];

const QUEUE_BACKEND_TEST_TIMEOUT_MS = 30_000;

const pipelineMock = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

function createQueueResult(id: string, vector: readonly number[]): QueueResult {
  return {
    id,
    metadata: {
      batchSize: 1,
      device: 'webgpu',
      dimensions: vector.length,
      dtype: 'fp16',
      elapsedMs: 1,
      fallbackApplied: false,
      model: 'bge-m3',
      pooling: 'mean',
    },
    type: 'result',
    vectors: [Float32Array.from(vector)],
  };
}

function createQueueStub() {
  const add = vi.fn<QueueAdapter['add']>();
  const queue: QueueAdapter = {
    add,
    addBulk: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    get isPaused() {
      return false;
    },
    get isProcessing() {
      return false;
    },
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return { add, queue };
}

describe('TransformersBackend queue integration', () => {
  beforeEach(() => {
    vi.resetModules();
    pipelineMock.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests explicit q8 WASM without changing the model ID', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});
    const { queue, add } = createQueueStub();
    const model = 'Xenova/all-MiniLM-L6-v2';
    const revision = '751bff37182d3f1213fa05d7196b954e230abad9';
    const result = createQueueResult('task', [0.4, 0.6]);
    add.mockResolvedValueOnce({
      ...result,
      metadata: { ...result.metadata, device: 'wasm', dtype: 'q8', model, revision },
    });
    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );
    registerEmbeddingQueueFactory(() => queue);
    const backend = new TransformersBackend();
    try {
      backend.setTargetDimensions(2);
      await backend.initialize({
        device: 'wasm',
        dtype: 'q8',
        modelId: model,
        quantized: false,
        revision,
      });
      await backend.generateEmbedding('hello world', model);
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ deviceHint: 'wasm', dtype: 'q8', model, revision }),
        undefined
      );
      expect(pipelineMock).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
      resetEmbeddingQueueFactory();
    }
  });

  it('forwards only its own worker progress as completed texts, then unsubscribes', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});
    const { queue, add } = createQueueStub();
    const listeners = new Set<Parameters<QueueAdapter['onProgress']>[0]>();
    const unsubscribe = vi.fn();
    vi.mocked(queue.onProgress).mockImplementation((listener) => {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    });
    const model = 'Xenova/all-MiniLM-L6-v2';
    const revision = '751bff37182d3f1213fa05d7196b954e230abad9';
    add.mockImplementationOnce(async (request) => {
      const id = (request as QueueAddCall & { id: string }).id;
      for (const listener of listeners) {
        listener({ id: 'other-task', phase: 'embedding', progress: 1, type: 'progress' });
        listener({ id, phase: 'embedding', progress: 0.5, type: 'progress' });
        listener({ id, phase: 'complete', progress: 1, type: 'progress' });
      }
      const result = createQueueResult(id, [0.4, 0.6]);
      return {
        ...result,
        metadata: {
          ...result.metadata,
          batchSize: 2,
          device: 'wasm',
          dtype: 'q8',
          model,
          revision,
        },
        vectors: [Float32Array.from([0.4, 0.6]), Float32Array.from([0.6, 0.4])],
      };
    });
    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );
    registerEmbeddingQueueFactory(() => queue);
    const backend = new TransformersBackend();
    try {
      backend.setTargetDimensions(2);
      await backend.initialize({
        device: 'wasm',
        dtype: 'q8',
        modelId: model,
        quantized: false,
        revision,
      });
      const onProgress = vi.fn();
      await backend.generateEmbeddings(['first', 'second'], model, { onProgress });
      expect(onProgress.mock.calls).toEqual([[1]]);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
    } finally {
      await backend.dispose();
      resetEmbeddingQueueFactory();
    }
  });

  it.each([
    ['webgpu', 384],
    ['wasm', 384],
    ['wasm', 1024],
  ] as const)(
    'an unpinned %s catalog load at %i dimensions requests the shared unpinned dtype',
    async (device, dimensions) => {
      vi.stubGlobal('window', {});
      vi.stubGlobal('Worker', class {});
      vi.stubGlobal('navigator', { gpu: {} });
      const { queue, add } = createQueueStub();
      const model = 'Xenova/bge-small-en-v1.5';
      const { unpinnedCatalogEmbeddingPlan } = await import('../inference-plan.js');
      const { dtype } = unpinnedCatalogEmbeddingPlan({ dimensions, id: model }, device);
      const result = createQueueResult('task', new Array<number>(dimensions).fill(0.1));
      add.mockResolvedValueOnce({
        ...result,
        metadata: { ...result.metadata, device, dtype, model },
      });
      const { SimpleEmbeddingService } = await import('../bge-m3-service.js');
      const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
        '../runtime-config.js'
      );
      registerEmbeddingQueueFactory(() => queue);
      const service = new SimpleEmbeddingService();
      try {
        // The embedding host's unpinned query load: a catalog model config, never pre-quantized.
        await service.initializeWithModel(
          {
            description: '',
            dimensions,
            id: model,
            name: model,
            quantized: false,
            tags: ['local'],
          },
          undefined,
          device
        );
        await service.generateQueryEmbedding('hello');
        expect(add).toHaveBeenCalledWith(
          expect.objectContaining({ deviceHint: device, dtype, model }),
          undefined
        );
      } finally {
        await service.dispose();
        resetEmbeddingQueueFactory();
      }
    }
  );

  it('a pinned CLS model requests CLS pooling and requires the CLS completion (BST-1993)', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('navigator', { gpu: {} });
    const { queue, add } = createQueueStub();
    const model = 'onnx-community/granite-embedding-small-english-r2-ONNX';
    const revision = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';
    const result = createQueueResult('task', [0.4, 0.6]);
    const pinned = { ...result.metadata, device: 'webgpu' as const, model, revision };
    add
      .mockResolvedValueOnce({ ...result, metadata: { ...pinned, pooling: 'cls' } })
      .mockResolvedValueOnce({ ...result, metadata: { ...pinned, pooling: 'mean' } });
    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );
    registerEmbeddingQueueFactory(() => queue);
    const backend = new TransformersBackend();
    try {
      backend.setTargetDimensions(2);
      await backend.initialize({
        device: 'webgpu',
        dtype: 'fp16',
        modelId: model,
        pooling: 'cls',
        revision,
      });
      await expect(backend.generateEmbedding('hello', model)).resolves.toMatchObject({
        runtime: { pooling: 'cls' },
      });
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ model, pooling: 'cls' }),
        undefined
      );
      await expect(backend.generateEmbedding('hello', model)).rejects.toThrow('pinned');
    } finally {
      await backend.dispose();
      resetEmbeddingQueueFactory();
    }
  });

  it('a catalog model config carries its CLS pooling into the legacy load (BST-1993)', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('navigator', { gpu: {} });
    const { queue, add } = createQueueStub();
    const model = 'onnx-community/granite-embedding-small-english-r2-ONNX';
    const result = createQueueResult('task', new Array<number>(384).fill(0.1));
    add.mockResolvedValueOnce({
      ...result,
      metadata: { ...result.metadata, device: 'webgpu', dimensions: 384, model, pooling: 'cls' },
    });
    const { SimpleEmbeddingService } = await import('../bge-m3-service.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );
    registerEmbeddingQueueFactory(() => queue);
    const service = new SimpleEmbeddingService();
    try {
      await service.initializeWithModel(
        {
          description: '',
          dimensions: 384,
          id: model,
          name: 'Granite',
          pooling: 'cls',
          quantized: false,
          tags: ['local', 'embedding'],
        },
        undefined,
        'webgpu'
      );
      await service.generateEmbedding('hello');
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ model, pooling: 'cls' }),
        undefined
      );
    } finally {
      await service.dispose();
      resetEmbeddingQueueFactory();
    }
  });

  it.each([
    { revision: undefined },
    { revision: 'main' },
    { pooling: 'cls' },
    { model: 'other-model' },
    { device: 'webgpu' },
    { dtype: 'q4' },
    { fallbackApplied: true },
    { dimensions: 768 },
  ] as const)('rejects mismatched pinned queue completion %j', async (metadata) => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});
    const { queue, add } = createQueueStub();
    const model = 'Xenova/all-MiniLM-L6-v2';
    const revision = '751bff37182d3f1213fa05d7196b954e230abad9';
    const result = createQueueResult('task', [0.4, 0.6]);
    const completion = {
      ...result.metadata,
      device: 'wasm' as const,
      dtype: 'q8' as const,
      model,
      revision,
      ...metadata,
    };
    const { revision: completionRevision, ...completionFields } = completion;
    add.mockResolvedValueOnce({
      ...result,
      metadata: {
        ...completionFields,
        ...(completionRevision === undefined ? {} : { revision: completionRevision }),
      },
    });
    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );
    registerEmbeddingQueueFactory(() => queue);
    const backend = new TransformersBackend();
    try {
      backend.setTargetDimensions(2);
      await backend.initialize({ device: 'wasm', dtype: 'q8', modelId: model, revision });
      await expect(backend.generateEmbedding('hello', model)).rejects.toThrow('pinned');
    } finally {
      await backend.dispose();
      resetEmbeddingQueueFactory();
    }
  });

  it('prefers the browser queue when available', {
    timeout: QUEUE_BACKEND_TEST_TIMEOUT_MS,
  }, async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockResolvedValueOnce(createQueueResult('task', [0.4, 0.6]));

    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    backend.setTargetDimensions(2);
    await backend.initialize({
      device: 'webgpu',
      modelConfig: {
        description: 'Local embedding model',
        dimensions: 2,
        id: 'bge-m3',
        name: 'BGE M3',
        size: '~300MB',
        tags: ['local'],
      },
      modelId: 'bge-m3',
      quantized: false,
    });

    const result = await backend.generateEmbedding('queue-text', 'bge-m3');

    expect(result.embedding).toHaveLength(2);
    expect(result.embedding[0]).toBeCloseTo(0.4, 5);
    expect(result.embedding[1]).toBeCloseTo(0.6, 5);
    expect(result.dimensions).toBe(2);
    expect(add).toHaveBeenCalledTimes(1);
    const enqueueCall = add.mock.calls[0]![0] as QueueAddCall;
    expect((enqueueCall as QueueAddCall).texts).toEqual(['queue-text']);
    expect((enqueueCall as QueueAddCall).estimatedModelBytes).toBe(300 * 1024 * 1024);
    expect((enqueueCall as QueueAddCall).truncateDim).toBe(2);
    expect(pipelineMock).not.toHaveBeenCalled();

    await backend.dispose();
    resetEmbeddingQueueFactory();
  });

  it('forwards the exact abort signal so the queue halts in-flight work', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    let queueCanceled = false;
    let workerCompleted = false;
    let finishWork: () => void = () => {
      throw new Error('Queue work did not start');
    };
    add.mockImplementation(
      (task, options) =>
        new Promise<QueueResult>((resolve, reject) => {
          let settled = false;
          const handleAbort = () => {
            if (settled) {
              return;
            }
            settled = true;
            queueCanceled = true;
            reject(options?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          options?.signal?.addEventListener('abort', handleAbort, { once: true });
          finishWork = () => {
            if (settled) {
              return;
            }
            settled = true;
            options?.signal?.removeEventListener('abort', handleAbort);
            workerCompleted = true;
            resolve(createQueueResult(task.id, [0.4, 0.6]));
          };
        })
    );

    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    await backend.initialize({
      device: 'webgpu',
      modelId: 'bge-m3',
      quantized: false,
    });

    const controller = new AbortController();
    const pendingEmbedding = backend.generateEmbedding('cancel-me', 'bge-m3', {
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    controller.abort(new Error('query context hidden'));
    finishWork();

    try {
      await expect(pendingEmbedding).rejects.toThrow('query context hidden');
      expect(add.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
      expect(queueCanceled).toBe(true);
      expect(workerCompleted).toBe(false);
    } finally {
      finishWork();
      await backend.dispose();
      resetEmbeddingQueueFactory();
    }
  });

  it('surfaces queue failures without falling back to local pipeline', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockRejectedValueOnce(new Error('queue offline'));

    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    await backend.initialize({
      device: 'webgpu',
      modelId: 'bge-m3',
      quantized: false,
    });

    await expect(backend.generateEmbedding('queue-text', 'bge-m3')).rejects.toThrow(
      'queue offline'
    );
    expect(add).toHaveBeenCalledTimes(1);
    expect(pipelineMock).not.toHaveBeenCalled();

    await backend.dispose();
    resetEmbeddingQueueFactory();
  });

  it('reports device availability across environments', async () => {
    const { TransformersBackend } = await import('../transformers-backend.js');

    expect(TransformersBackend.isDeviceAvailable('cpu')).toBe(false);
    expect(TransformersBackend.isDeviceAvailable('wasm')).toBe(false);
    expect(TransformersBackend.isDeviceAvailable('webgpu')).toBe(false);
    expect(() => TransformersBackend.getBestDevice()).toThrow();

    vi.stubGlobal('window', {});
    expect(TransformersBackend.isDeviceAvailable('wasm')).toBe(true);

    vi.stubGlobal('navigator', { gpu: {} });
    expect(TransformersBackend.isDeviceAvailable('webgpu')).toBe(true);
    expect(TransformersBackend.getBestDevice()).toBe('webgpu');
  });

  it('applies and clears target dimension hints when enqueueing tasks', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockResolvedValueOnce(createQueueResult('first', [0.3, 0.7]));
    add.mockResolvedValueOnce(createQueueResult('second', [0.6, 0.4]));

    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    backend.setTargetDimensions(3.7);
    await backend.initialize({
      device: 'webgpu',
      modelId: 'bge-m3',
      quantized: false,
    });

    await backend.generateEmbedding('first-text', 'bge-m3');
    backend.setTargetDimensions(-10);
    await backend.generateEmbedding('second-text', 'bge-m3');

    const firstCall = add.mock.calls[0]![0] as QueueAddCall;
    expect((firstCall as QueueAddCall).truncateDim).toBe(3);

    const secondCall = add.mock.calls[1]![0] as QueueAddCall;
    expect((secondCall as QueueAddCall).truncateDim).toBeUndefined();

    await backend.dispose();
    resetEmbeddingQueueFactory();
  });

  it('uses configured stream batch size as the worker max batch size', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockResolvedValueOnce({
      id: 'batch',
      metadata: {
        batchSize: 3,
        device: 'webgpu',
        dimensions: 2,
        dtype: 'fp16',
        elapsedMs: 1,
        fallbackApplied: false,
        model: 'bge-m3',
        pooling: 'mean',
      },
      type: 'result',
      vectors: Array.from({ length: 10 }, () => Float32Array.from([0.1, 0.2])),
    });

    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    await backend.initialize({
      device: 'webgpu',
      modelId: 'bge-m3',
      quantized: false,
      streamBatchSize: 3,
    });

    await backend.generateEmbeddings(
      Array.from({ length: 10 }, (_, index) => `text ${index}`),
      'bge-m3'
    );

    const call = add.mock.calls[0]![0] as QueueAddCall;
    expect(call.maxBatchSize).toBe(3);

    await backend.dispose();
    resetEmbeddingQueueFactory();
  });

  it('creates a fresh stream worker only for explicit work after joined device-loss retirement', async () => {
    const workers: StreamWorker[] = [];
    class StreamWorker extends EventTarget {
      readonly postMessage = vi.fn();
      readonly terminate = vi.fn();
      constructor() {
        super();
        workers.push(this);
      }
      emit(data: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data }));
      }
    }
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', StreamWorker);
    const { queue } = createQueueStub();
    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );
    registerEmbeddingQueueFactory(() => queue);
    const backend = new TransformersBackend();
    try {
      backend.setTargetDimensions(2);
      await backend.initialize({
        device: 'webgpu',
        dtype: 'fp16',
        modelId: 'bge-m3',
        quantized: false,
        streamingWorkerUrl: '/worker.js',
      });
      const first = backend
        .generateEmbeddingsStream(['hello'], 'bge-m3', vi.fn())
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(workers[0]?.postMessage).toHaveBeenCalled());
      const id = (workers[0]!.postMessage.mock.calls[0]![0] as { request: { id: string } }).request
        .id;
      workers[0]!.emit({
        cause: 'destroyed: device1',
        code: 'EMBEDDING_DEVICE_LOST',
        id,
        message: 'device lost',
        type: 'error',
      });
      expect(await first).toMatchObject({ code: 'EMBEDDING_DEVICE_LOST' });
      expect(workers[0]!.terminate).toHaveBeenCalledOnce();
      expect(workers).toHaveLength(1);
      const batches = vi.fn();
      const next = backend.generateEmbeddingsStream(['explicit next'], 'bge-m3', batches);
      // Observe rejection even when the pre-fix owner wrongly reuses its failed client.
      void next.catch(() => undefined);
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      const replacement = workers[1]!;
      const nextId = (replacement.postMessage.mock.calls[0]![0] as { request: { id: string } })
        .request.id;
      replacement.emit({
        batchIndex: 0,
        endIndex: 1,
        id: nextId,
        peakVectorsInFlight: 1,
        startIndex: 0,
        transferBytes: 8,
        type: 'batch',
        vectors: [new Float32Array([1, 0])],
        vectorsInFlight: 1,
      });
      await vi.waitFor(() =>
        expect(replacement.postMessage).toHaveBeenCalledWith({
          batchIndex: 0,
          id: nextId,
          type: 'stream-ack',
        })
      );
      replacement.emit({
        id: nextId,
        metadata: {
          batchSize: 1,
          device: 'webgpu',
          dimensions: 2,
          dtype: 'fp16',
          elapsedMs: 1,
          fallbackApplied: false,
          model: 'bge-m3',
          pooling: 'mean',
        },
        type: 'complete',
      });
      await expect(next).resolves.toMatchObject({ device: 'webgpu', fallbackApplied: false });
      expect(batches).toHaveBeenCalledOnce();
      expect(workers[0]!.postMessage).toHaveBeenCalledOnce();
    } finally {
      await backend.dispose();
      resetEmbeddingQueueFactory();
    }
  });

  it('disposes without touching the local pipeline when using the queue', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    await backend.initialize({
      device: 'wasm',
      modelId: 'bge-m3',
      quantized: false,
    });

    await backend.dispose();
    expect(add).not.toHaveBeenCalled();
    expect(pipelineMock).not.toHaveBeenCalled();
    resetEmbeddingQueueFactory();
  });

  it('throws when queue creation fails on initialization', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});

    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );

    registerEmbeddingQueueFactory(() => {
      throw new Error('creation failed');
    });

    const backend = new TransformersBackend();
    await expect(
      backend.initialize({
        device: 'wasm',
        modelId: 'bge-m3',
        quantized: false,
      })
    ).rejects.toThrow('creation failed');

    expect(pipelineMock).not.toHaveBeenCalled();
    resetEmbeddingQueueFactory();
  });

  it('surfaces inference failures without rebuilding', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockRejectedValueOnce(new Error('runtime explode'));

    const { TransformersBackend } = await import('../transformers-backend.js');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config.js'
    );

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    await backend.initialize({
      device: 'wasm',
      modelId: 'bge-m3',
      quantized: false,
    });

    await expect(backend.generateEmbedding('hello world', 'bge-m3')).rejects.toThrow(
      'runtime explode'
    );
    expect(add).toHaveBeenCalledTimes(1);
    expect(pipelineMock).not.toHaveBeenCalled();
    resetEmbeddingQueueFactory();
  });
});
