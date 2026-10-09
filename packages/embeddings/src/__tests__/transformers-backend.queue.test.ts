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

  it.each([
    { revision: undefined },
    { revision: 'main' },
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
