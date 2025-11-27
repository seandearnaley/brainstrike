import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistryManager } from '../model-registry';
import type { EmbeddingConfig, EmbeddingProgress } from '../types';

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
      embedding: [0.1, 0.2],
      model: 'bge-m3',
      dimensions: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when initializeWithModel receives an unknown key', async () => {
    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();
    const getModelSpy = vi
      .spyOn(ModelRegistryManager, 'getModel')
      .mockReturnValueOnce(undefined as never);

    await expect(svc.initializeWithModel('unknown-model')).rejects.toThrow(
      "Model 'unknown-model' not found in registry"
    );
    getModelSpy.mockRestore();
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
      return { resolve: resolve!, promise };
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
    const modelConfig = {
      id: 'Xenova/bge-base-en-v1.5',
      name: 'BGE Base',
      dimensions: 768,
      quantized: false,
      description: 'test model',
      tags: ['test'],
      origin: 'hf',
      size: 'small',
    };

    const defaultModelSpy = vi
      .spyOn(ModelRegistryManager, 'getDefaultModel')
      .mockReturnValue(modelConfig);
    const defaultKeySpy = vi
      .spyOn(ModelRegistryManager, 'getDefaultModelKey')
      .mockReturnValue('bge-base');
    const getModelSpy = vi.spyOn(ModelRegistryManager, 'getModel').mockReturnValue(modelConfig);
    const shouldQuantizeSpy = vi
      .spyOn(ModelRegistryManager, 'shouldQuantize')
      .mockReturnValue(false);

    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel('bge-base');
    const result = await svc.generateQueryEmbedding('where is the library?');

    expect(generateEmbeddingMock).toHaveBeenCalled();
    const [prompt, modelId] = generateEmbeddingMock.mock.calls.at(-1)!;
    expect(prompt.startsWith('query: ')).toBe(true);
    expect(modelId).toBeDefined();
    expect(result.embedding).toHaveLength(2);

    defaultModelSpy.mockRestore();
    defaultKeySpy.mockRestore();
    getModelSpy.mockRestore();
    shouldQuantizeSpy.mockRestore();
  });

  it('does not prefix query embeddings for BGE-M3', async () => {
    // BGE-M3 specifically does NOT need prefixes per official BAAI docs:
    // https://huggingface.co/BAAI/bge-m3/discussions/35
    const modelConfig = {
      id: 'Xenova/bge-m3',
      name: 'BGE M3',
      dimensions: 1024,
      quantized: false,
      description: 'test model',
      tags: ['test'],
      origin: 'hf',
      size: 'large',
    };

    const defaultModelSpy = vi
      .spyOn(ModelRegistryManager, 'getDefaultModel')
      .mockReturnValue(modelConfig);
    const defaultKeySpy = vi
      .spyOn(ModelRegistryManager, 'getDefaultModelKey')
      .mockReturnValue('bge-m3');
    const getModelSpy = vi.spyOn(ModelRegistryManager, 'getModel').mockReturnValue(modelConfig);
    const shouldQuantizeSpy = vi
      .spyOn(ModelRegistryManager, 'shouldQuantize')
      .mockReturnValue(false);

    const svcModule = await import('../bge-m3-service');
    const svc = new svcModule.SimpleEmbeddingService();

    await svc.initializeWithModel('bge-m3');
    const result = await svc.generateQueryEmbedding('where is the library?');

    expect(generateEmbeddingMock).toHaveBeenCalled();
    const [prompt, modelId] = generateEmbeddingMock.mock.calls.at(-1)!;
    // BGE-M3 should NOT have the query: prefix
    expect(prompt).toBe('where is the library?');
    expect(prompt.startsWith('query: ')).toBe(false);
    expect(modelId).toBeDefined();
    expect(result.embedding).toHaveLength(2);

    defaultModelSpy.mockRestore();
    defaultKeySpy.mockRestore();
    getModelSpy.mockRestore();
    shouldQuantizeSpy.mockRestore();
  });
});
