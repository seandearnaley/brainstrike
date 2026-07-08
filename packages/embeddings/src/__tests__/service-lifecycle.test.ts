import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingConfig, EmbeddingProgress, ModelConfig } from '../types';

const setTargetDimensionsMock = vi.fn<(dim: number | null) => void>();
const generateEmbeddingMock =
  vi.fn<
    (
      text: string,
      modelId: string
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
    async generateEmbedding(text: string, modelId: string) {
      return generateEmbeddingMock(text, modelId);
    }
    getSelectedDevice() {
      return 'webgpu';
    }
    async dispose() {
      backendInitialized = false;
    }
  },
}));

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

const JINA_CODE_MODEL: ModelConfig = {
  description: 'test model',
  dimensions: 768,
  id: 'jinaai/jina-embeddings-v2-base-code',
  name: 'Jina Code',
  origin: 'hf',
  quantized: false,
  size: 'medium',
  tags: ['code'],
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
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await expect(svc.initializeWithModel(null as unknown as ModelConfig)).rejects.toThrow(
      'ModelConfig or model ID is required'
    );
  });

  it('returns early when already initializing', async () => {
    const svcModule = await import('../bge-m3-service');
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
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initialize();
    expect(initializeMock).toHaveBeenCalledTimes(1);

    await expect(svc.initialize({ modelId: 'alternate-model' })).rejects.toThrow(/dispose/i);
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when generating embeddings before initialization', async () => {
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    backendInitialized = false;
    await expect(svc.generateEmbedding('hello')).rejects.toThrow(/Service not initialized/);
  });

  it('prefixes query embeddings for non-M3 BGE models', async () => {
    // BGE-base and other non-M3 BGE models require query/passage prefixes
    // BGE-M3 specifically does NOT need prefixes per official BAAI docs:
    // https://huggingface.co/BAAI/bge-m3/discussions/35
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(BGE_BASE_MODEL);
    const result = await svc.generateQueryEmbedding('where is the library?');

    expect(generateEmbeddingMock).toHaveBeenCalled();
    const [prompt, modelId] = generateEmbeddingMock.mock.calls.at(-1)!;
    expect(prompt.startsWith('query: ')).toBe(true);
    expect(modelId).toBeDefined();
    expect(result.embedding).toHaveLength(2);
  });

  it('does not prefix query embeddings for BGE-M3', async () => {
    // BGE-M3 specifically does NOT need prefixes per official BAAI docs:
    // https://huggingface.co/BAAI/bge-m3/discussions/35
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(BGE_M3_MODEL);
    const result = await svc.generateQueryEmbedding('where is the library?');

    expect(generateEmbeddingMock).toHaveBeenCalled();
    const [prompt, modelId] = generateEmbeddingMock.mock.calls.at(-1)!;
    // BGE-M3 should NOT have the query: prefix
    expect(prompt).toBe('where is the library?');
    expect(prompt.startsWith('query: ')).toBe(false);
    expect(modelId).toBeDefined();
    expect(result.embedding).toHaveLength(2);
  });

  it('applies Jina code retrieval prompt for document embeddings', async () => {
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(JINA_CODE_MODEL);
    await svc.generateDocEmbedding('function test() {}');

    expect(generateEmbeddingMock).toHaveBeenCalled();
    const [prompt] = generateEmbeddingMock.mock.calls.at(-1)!;
    expect(prompt).toContain('Represent the following code snippet');
  });

  it('applies Jina code retrieval prompt for query embeddings', async () => {
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(JINA_CODE_MODEL);
    await svc.generateQueryEmbedding('how to sort an array');

    expect(generateEmbeddingMock).toHaveBeenCalled();
    const [prompt] = generateEmbeddingMock.mock.calls.at(-1)!;
    expect(prompt).toContain('Represent the programming question');
  });

  it('sets target dimensions when initializing with model config', async () => {
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(BGE_M3_MODEL);

    expect(setTargetDimensionsMock).toHaveBeenCalledWith(BGE_M3_MODEL.dimensions);
  });

  it('stores and returns current model config after initialization', async () => {
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    expect(svc.getCurrentModelConfig()).toBeNull();
    expect(svc.getCurrentModelKey()).toBeNull();

    await svc.initializeWithModel(BGE_BASE_MODEL);

    expect(svc.getCurrentModelConfig()).toEqual(BGE_BASE_MODEL);
    expect(svc.getCurrentModelKey()).toBe(BGE_BASE_MODEL.id);
  });

  it('clears model config after disposal', async () => {
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel(BGE_BASE_MODEL);
    expect(svc.getCurrentModelConfig()).toEqual(BGE_BASE_MODEL);

    await svc.dispose();

    expect(svc.getCurrentModelConfig()).toBeNull();
    expect(svc.getCurrentModelKey()).toBeNull();
    expect(svc.getStatus()).toBe('idle');
  });
});
