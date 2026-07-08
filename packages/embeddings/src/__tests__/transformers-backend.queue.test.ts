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

  it('prefers the browser queue when available', {
    timeout: QUEUE_BACKEND_TEST_TIMEOUT_MS,
  }, async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockResolvedValueOnce(createQueueResult('task', [0.4, 0.6]));

    const { TransformersBackend } = await import('../transformers-backend');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config'
    );

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    backend.setTargetDimensions(2);
    await backend.initialize({
      device: 'webgpu',
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
    expect((enqueueCall as QueueAddCall).truncateDim).toBe(2);
    expect(pipelineMock).not.toHaveBeenCalled();

    await backend.dispose();
    resetEmbeddingQueueFactory();
  });

  it('surfaces queue failures without falling back to local pipeline', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockRejectedValueOnce(new Error('queue offline'));

    const { TransformersBackend } = await import('../transformers-backend');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config'
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
    const { TransformersBackend } = await import('../transformers-backend');

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

    const { TransformersBackend } = await import('../transformers-backend');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config'
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

    const { TransformersBackend } = await import('../transformers-backend');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config'
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
    const { TransformersBackend } = await import('../transformers-backend');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config'
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

    const { TransformersBackend } = await import('../transformers-backend');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config'
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

    const { TransformersBackend } = await import('../transformers-backend');
    const { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } = await import(
      '../runtime-config'
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
