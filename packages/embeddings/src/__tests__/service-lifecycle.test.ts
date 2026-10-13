import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbeddingConfig,
  EmbeddingExecutionOptions,
  EmbeddingProgress,
  ModelConfig,
} from '../types.js';

const setTargetDimensionsMock = vi.fn<(dim: number | null) => void>();
const generateEmbeddingMock =
  vi.fn<
    (
      text: string,
      modelId: string,
      options?: EmbeddingExecutionOptions
    ) => Promise<{ embedding: number[]; model: string; dimensions: number }>
  >();
const initializeMock =
  vi.fn<
    (config?: EmbeddingConfig, onProgress?: (progress: EmbeddingProgress) => void) => Promise<void>
  >();

let backendInitialized = false;

vi.mock('../transformers-backend', () => ({
  TransformersBackend: class {
    setTargetDimensions(dim: number | null) {
      setTargetDimensionsMock(dim);
    }
    async initialize(
      config: EmbeddingConfig | undefined,
      onProgress?: (progress: EmbeddingProgress) => void
    ) {
      return initializeMock(config, onProgress);
    }
    isInitialized() {
      return backendInitialized;
    }
    async generateEmbedding(text: string, modelId: string, options?: EmbeddingExecutionOptions) {
      return generateEmbeddingMock(text, modelId, options);
    }
    getSelectedDevice() {
      return 'webgpu';
    }
    async dispose() {
      backendInitialized = false;
    }
  },
}));

// BAAI's card: an optional instruction for short queries, none for passages.
const BGE_QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

// Test model configurations
const BGE_BASE_MODEL: ModelConfig = {
  description: 'test model',
  dimensions: 768,
  id: 'Xenova/bge-base-en-v1.5',
  name: 'BGE Base',
  origin: 'hf',
  quantized: false,
  size: 'small',
  tags: ['test'],
};

const BGE_M3_MODEL: ModelConfig = {
  description: 'test model',
  dimensions: 1024,
  id: 'Xenova/bge-m3',
  name: 'BGE M3',
  origin: 'hf',
  quantized: false,
  size: 'large',
  tags: ['test'],
};

describe('SimpleEmbeddingService lifecycle', () => {
  beforeEach(() => {
    backendInitialized = false;
    setTargetDimensionsMock.mockReset();
    generateEmbeddingMock.mockReset();
    initializeMock.mockReset();
    initializeMock.mockImplementation(async () => {
      backendInitialized = true;
    });
    generateEmbeddingMock.mockResolvedValue({
      dimensions: 2,
      embedding: [0.1, 0.2],
      model: 'bge-m3',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when initializeWithModel receives no config', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    await expect(svc.initializeWithModel(null as unknown as ModelConfig)).rejects.toThrow(
      'ModelConfig or model ID is required'
    );
  });

  it('returns early when already initializing', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    const deferred: { resolve: () => void; promise: Promise<void> } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = () => {
          backendInitialized = true;
          res();
        };
      });
      return { promise, resolve: resolve! };
    })();

    initializeMock.mockImplementationOnce(() => deferred.promise);

    const first = svc.initialize();

    // Second call should return immediately while the first is still pending.
    await svc.initialize();
    expect(initializeMock).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await first;
  });

  it('throws when switching models without disposing', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initialize();
    expect(initializeMock).toHaveBeenCalledTimes(1);

    await expect(svc.initialize({ modelId: 'alternate-model' })).rejects.toThrow(/dispose/i);
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when generating embeddings before initialization', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    backendInitialized = false;
    await expect(svc.generateEmbedding('hello')).rejects.toThrow(/Service not initialized/);
  });

  it('embeds raw text when the catalog states no prompts, whatever the model id says (BST-1993)', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(BGE_BASE_MODEL);
    await svc.generateQueryEmbedding('where is the library?');
    expect(generateEmbeddingMock.mock.calls.at(-1)?.[0]).toBe('where is the library?');
    await svc.generateDocEmbedding('the library is on main street');
    expect(generateEmbeddingMock.mock.calls.at(-1)?.[0]).toBe('the library is on main street');
  });

  it('applies exactly the prompts the catalog states (BST-1993)', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel({
      ...BGE_BASE_MODEL,
      prompts: { document: '', query: BGE_QUERY_INSTRUCTION },
    });
    const result = await svc.generateQueryEmbedding('where is the library?');
    expect(generateEmbeddingMock.mock.calls.at(-1)?.[0]).toBe(
      `${BGE_QUERY_INSTRUCTION}where is the library?`
    );
    expect(result.embedding).toHaveLength(2);
    await svc.generateDocEmbedding('the library is on main street');
    expect(generateEmbeddingMock.mock.calls.at(-1)?.[0]).toBe('the library is on main street');
  });

  it("applies a pinned plan's catalog prompts (BST-1993)", async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initialize({
      device: 'wasm',
      dtype: 'q8',
      modelConfig: BGE_BASE_MODEL,
      modelId: BGE_BASE_MODEL.id,
      prompts: { document: 'doc: ', query: 'ask: ' },
    });
    await svc.generateQueryEmbedding('q');
    expect(generateEmbeddingMock.mock.calls.at(-1)?.[0]).toBe('ask: q');
    await svc.generateDocEmbedding('d');
    expect(generateEmbeddingMock.mock.calls.at(-1)?.[0]).toBe('doc: d');
  });

  it("never carries a previous model's prompts or pooling into the next load (BST-1993)", async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel({
      ...BGE_BASE_MODEL,
      pooling: 'cls',
      prompts: { document: '', query: BGE_QUERY_INSTRUCTION },
    });
    await svc.dispose();
    await svc.initializeWithModel(BGE_M3_MODEL);
    await svc.generateQueryEmbedding('where is the library?');
    expect(generateEmbeddingMock.mock.calls.at(-1)?.[0]).toBe('where is the library?');
    expect(initializeMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('pooling');
  });

  it('passes query execution options to the backend', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();
    const controller = new AbortController();

    await svc.initializeWithModel(BGE_M3_MODEL);
    await svc.generateQueryEmbedding('cancelable query', { signal: controller.signal });

    expect(generateEmbeddingMock).toHaveBeenLastCalledWith('cancelable query', BGE_M3_MODEL.id, {
      signal: controller.signal,
    });
  });

  it('sets target dimensions when initializing with model config', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(BGE_M3_MODEL);

    expect(setTargetDimensionsMock).toHaveBeenCalledWith(BGE_M3_MODEL.dimensions);
  });

  it('stores and returns current model config after initialization', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    expect(svc.getCurrentModelConfig()).toBeNull();
    expect(svc.getCurrentModelKey()).toBeNull();

    await svc.initializeWithModel(BGE_BASE_MODEL);

    expect(svc.getCurrentModelConfig()).toEqual(BGE_BASE_MODEL);
    expect(svc.getCurrentModelKey()).toBe(BGE_BASE_MODEL.id);
  });

  it('clears model config after disposal', async () => {
    const svcModule = await import('../bge-m3-service.js');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(BGE_BASE_MODEL);
    expect(svc.getCurrentModelConfig()).toEqual(BGE_BASE_MODEL);

    await svc.dispose();

    expect(svc.getCurrentModelConfig()).toBeNull();
    expect(svc.getCurrentModelKey()).toBeNull();
    expect(svc.getStatus()).toBe('idle');
  });
});
