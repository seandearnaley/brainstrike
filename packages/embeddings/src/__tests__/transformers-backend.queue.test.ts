import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueueAddCall = Parameters<QueueAdapter['add']>[0];

const pipelineMock = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

function createQueueResult(id: string, vector: readonly number[]): QueueResult {
  return {
    type: 'result',
    id,
    vectors: [Float32Array.from(vector)],
    metadata: {
      model: 'bge-m3',
      device: 'webgpu',
      dtype: 'fp16',
      batchSize: 1,
      elapsedMs: 1,
      fallbackApplied: false,
      dimensions: vector.length,
    },
  };
}

function createQueueStub() {
  const add = vi.fn<QueueAdapter['add']>();
  const queue: QueueAdapter = {
    add,
    addBulk: vi.fn(async () => []),
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(async () => {}),
  };
  return { queue, add };
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

  it('prefers the browser queue when available', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockResolvedValueOnce(createQueueResult('warmup', [0.1, 0.2]));
    add.mockResolvedValueOnce(createQueueResult('task', [0.4, 0.6]));

    const { TransformersBackend, registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } =
      await import('../transformers-backend');

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    backend.setTargetDimensions(2);
    await backend.initialize({
      modelId: 'bge-m3',
      device: 'webgpu',
      quantized: false,
    });

    const result = await backend.generateEmbedding('queue-text', 'bge-m3');

    expect(result.embedding).toHaveLength(2);
    expect(result.embedding[0]).toBeCloseTo(0.4, 5);
    expect(result.embedding[1]).toBeCloseTo(0.6, 5);
    expect(result.dimensions).toBe(2);
    expect(add).toHaveBeenCalledTimes(2);
    const warmupCall = add.mock.calls[0]?.[0] as QueueAddCall;
    expect(warmupCall.texts).toEqual(['.']);
    const enqueueCall = add.mock.calls[1]?.[0] as QueueAddCall;
    expect(enqueueCall.texts).toEqual(['queue-text']);
    expect(enqueueCall.truncateDim).toBe(2);
    expect(pipelineMock).not.toHaveBeenCalled();

    await backend.dispose();
    resetEmbeddingQueueFactory();
  });

  it('falls back to local pipeline when the queue rejects requests', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {});

    const { queue, add } = createQueueStub();
    add.mockResolvedValueOnce(createQueueResult('warmup', [0.1, 0.2]));
    add.mockRejectedValueOnce(new Error('queue offline'));

    pipelineMock.mockResolvedValue(async (_text: string) => ({
      data: Float32Array.from([0.3, 0.7]),
    }));

    const { TransformersBackend, registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } =
      await import('../transformers-backend');

    registerEmbeddingQueueFactory(() => queue);

    const backend = new TransformersBackend();
    await backend.initialize({
      modelId: 'bge-m3',
      device: 'webgpu',
      quantized: false,
    });

    const result = await backend.generateEmbedding('fallback-text', 'bge-m3');

    expect(result.embedding).toHaveLength(2);
    expect(result.embedding[0]).toBeCloseTo(0.3, 5);
    expect(result.embedding[1]).toBeCloseTo(0.7, 5);
    expect(add).toHaveBeenCalledTimes(2);
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    await backend.dispose();
    resetEmbeddingQueueFactory();
  });

  it('reports device availability across environments', async () => {
    const { TransformersBackend } = await import('../transformers-backend');

    expect(TransformersBackend.isDeviceAvailable('cpu')).toBe(true);
    expect(TransformersBackend.isDeviceAvailable('wasm')).toBe(false);
    expect(TransformersBackend.isDeviceAvailable('webgpu')).toBe(false);
    expect(TransformersBackend.getBestDevice()).toBe('cpu');

    vi.stubGlobal('window', {});
    expect(TransformersBackend.isDeviceAvailable('wasm')).toBe(true);

    vi.stubGlobal('navigator', { gpu: {} });
    expect(TransformersBackend.isDeviceAvailable('webgpu')).toBe(true);
    expect(TransformersBackend.getBestDevice()).toBe('webgpu');
  });
});
