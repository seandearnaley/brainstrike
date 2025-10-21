import { describe, expect, it, vi } from 'vitest';
import type { EmbedWorkerRequest, EmbedWorkerSuccess } from '../src';

const workerEmitMock = vi.fn();
const transferMock = vi.fn(function TransferStub<T>(value: T) {
  return value;
});
const pipelineMock = vi.fn();
const registeredHandlers: { runEmbedding?: (payload: EmbedWorkerRequest) => Promise<EmbedWorkerSuccess> } =
  {};

class MockTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];

  constructor(values: readonly number[], dims: readonly number[]) {
    this.data = Float32Array.from(values);
    this.dims = dims;
  }

  tolist() {
    return Array.from(this.data);
  }
}

vi.mock('workerpool', () => ({
  worker: (handlers: { runEmbedding: (payload: EmbedWorkerRequest) => Promise<EmbedWorkerSuccess> }) => {
    registeredHandlers.runEmbedding = handlers.runEmbedding;
  },
  workerEmit: workerEmitMock,
  Transfer: transferMock,
}));

vi.mock('@huggingface/transformers', () => ({
  env: { allowRemoteModels: false },
  pipeline: (...args: unknown[]) => pipelineMock(...args),
  Tensor: MockTensor,
}));

describe('embedding worker runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    workerEmitMock.mockReset();
    pipelineMock.mockReset();
    transferMock.mockClear();
    registeredHandlers.runEmbedding = undefined;
    vi.unstubAllGlobals();
  });

  async function loadWorker() {
    await import('../src/embedding.worker');
    if (!registeredHandlers.runEmbedding) {
      throw new Error('Embedding worker was not registered');
    }
    return registeredHandlers.runEmbedding;
  }

  it('short-circuits when no texts are provided', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.1, 0.2]));
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      type: 'embed',
      id: 'empty',
      model: 'bge-m3',
      texts: [],
    });
    expect(result.vectors).toHaveLength(0);
    expect(result.metadata.batchSize).toBe(0);
    expect(pipelineMock).not.toHaveBeenCalled();
    expect(workerEmitMock).not.toHaveBeenCalled();
  });

  it('falls back to wasm when the webgpu pipeline creation fails', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    pipelineMock.mockRejectedValueOnce(new Error('webgpu unavailable'));
    pipelineMock.mockResolvedValueOnce(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      type: 'embed',
      id: 'doc-1',
      model: 'bge-m3',
      texts: ['hello world'],
      truncateDim: 2,
    });
    expect(result.metadata.device).toBe('webgpu');
    expect(Array.from(result.vectors[0])).toHaveLength(2);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(destructurePipelineDevices()).toEqual(['webgpu', 'wasm']);
    expect(workerEmitMock.mock.calls[0]?.[0]).toMatchObject({ phase: 'initializing', progress: 0 });
    expect(workerEmitMock.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'complete', progress: 1 });
  });

  it('supports tasks requesting non-default embedding dimensions', async () => {
    const vector = new Float32Array(1024).fill(0.25);
    pipelineMock.mockResolvedValue(async () => vector);
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      type: 'embed',
      id: 'custom-dim',
      model: 'bge-m3',
      texts: ['hello'],
      targetDimension: 1024,
      dimensionParameter: 'dimensions',
      provider: 'openai',
    });
    expect(result.metadata.dimensions).toBe(1024);
    expect(Array.from(result.vectors[0])).toHaveLength(1024);
  });

  it('shrinks batch size after pipeline errors and falls back to wasm execution', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const failingExtractor = vi.fn(async () => {
      throw new Error('batch failed');
    });
    const recoveringExtractor = vi.fn(async (texts: string | readonly string[]) => {
      const inputs = Array.isArray(texts) ? texts : [texts];
      return inputs.map(() => [0.5, 0.5]);
    });
    pipelineMock.mockResolvedValueOnce(failingExtractor);
    pipelineMock.mockResolvedValueOnce(recoveringExtractor);
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      type: 'embed',
      id: 'bulk',
      model: 'bge-m3',
      texts: Array.from({ length: 32 }, (_, index) => `text-${index}`),
      truncateDim: 2,
    });
    expect(failingExtractor).toHaveBeenCalled();
    expect(recoveringExtractor).toHaveBeenCalled();
    expect(result.metadata.fallbackApplied).toBe(true);
    expect(result.metadata.device).toBe('wasm');
    expect(result.metadata.batchSize).toBeGreaterThanOrEqual(1);
    expect(result.vectors).toHaveLength(32);
  });

  it('emits an error event when the pipeline returns no tensors', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const emptyExtractor = vi.fn(async () => []);
    pipelineMock.mockResolvedValue(emptyExtractor);
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'empty-output',
        model: 'bge-m3',
        texts: ['nope'],
      })
    ).rejects.toThrow('Embedding pipeline returned no tensors');
    const errorCall = workerEmitMock.mock.calls.find(([event]) => event?.type === 'error');
    expect(errorCall?.[0]).toMatchObject({
      type: 'error',
      id: 'empty-output',
      message: 'Embedding pipeline returned no tensors',
    });
  });

  it('normalizes batched tensors returned by transformers', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    pipelineMock.mockResolvedValue(async (texts: string | readonly string[]) => {
      const inputs = Array.isArray(texts) ? texts : [texts];
      const values = inputs.flatMap((_, index) => [index + 1, index + 2, index + 3]);
      return new MockTensor(values, [inputs.length, 3]);
    });
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      type: 'embed',
      id: 'tensor',
      model: 'bge-m3',
      texts: Array.from({ length: 9 }, (_, index) => `item-${index}`),
      truncateDim: 3,
    });
    expect(result.vectors).toHaveLength(9);
    expect(Array.from(result.vectors[0])).toHaveLength(3);
    const length = Math.sqrt(result.vectors[0].reduce((sum, value) => sum + value * value, 0));
    expect(length).toBeCloseTo(1, 5);
  });
});

function destructurePipelineDevices() {
  return pipelineMock.mock.calls.map(([, , config]) => (config as { device?: string }).device);
}
