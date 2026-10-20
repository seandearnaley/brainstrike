import type { CatalogModelFacts } from '@brainstrike/embeddings/inference-plan';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  dispose: vi.fn(async () => undefined),
  generateQueryEmbedding: vi.fn(async () => ({ embedding: new Float32Array([0.1]) })),
  initialize: vi.fn(async () => undefined),
}));
vi.mock('@brainstrike/embeddings/service', () => ({
  SimpleEmbeddingService: vi.fn(function SimpleEmbeddingService() {
    return service;
  }),
}));

const readModelCacheStatus = vi.hoisted(() => vi.fn(async () => [false, true]));
vi.mock('@brainstrike/embedding-worker', () => ({ readModelCacheStatus }));
vi.mock('@brainstrike/embedding-worker/vite', () => ({
  resolveViteEmbeddingWorkerUrlHref: () => '/assets/embedding.worker.js#ort',
}));

const { downloadWebEmbeddingModel, readWebDownloadedEmbeddingModels } = await import(
  '../settings-model-download'
);

/** A catalog row that pins its revision, per-device dtype and pooling (BST-1993). */
const GRANITE: CatalogModelFacts = {
  dimensions: 384,
  execution: { wasm: 'q8', webgpu: 'fp16' },
  id: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  pooling: 'cls',
  prompts: { document: '', query: '' },
  revision: '0123456789abcdef0123456789abcdef01234567',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('downloadWebEmbeddingModel (BST-2230)', () => {
  it('loads the catalog plan web indexing pins, then releases the worker', async () => {
    await downloadWebEmbeddingModel(GRANITE, 'wasm');

    expect(service.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        device: 'wasm',
        dtype: 'q8',
        modelId: GRANITE.id,
        pooling: 'cls',
        revision: GRANITE.revision,
      })
    );
    expect(service.generateQueryEmbedding).toHaveBeenCalledTimes(1);
    expect(service.dispose).toHaveBeenCalledTimes(1);
  });

  it('releases the worker when the load fails', async () => {
    service.initialize.mockRejectedValueOnce(new Error('offline'));

    await expect(downloadWebEmbeddingModel(GRANITE, 'webgpu')).rejects.toThrow('offline');
    expect(service.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('readWebDownloadedEmbeddingModels (BST-2241)', () => {
  it('asks a worker about the plans a download loads, and keeps the cached ids', async () => {
    const MINILM: CatalogModelFacts = { dimensions: 384, id: 'Xenova/all-MiniLM-L6-v2' };

    await expect(readWebDownloadedEmbeddingModels([GRANITE, MINILM], 'wasm')).resolves.toEqual([
      MINILM.id,
    ]);
    expect(readModelCacheStatus).toHaveBeenCalledWith('/assets/embedding.worker.js#ort', [
      { device: 'wasm', dtype: 'q8', modelId: GRANITE.id, revision: GRANITE.revision },
      { device: 'wasm', dtype: 'q4', modelId: MINILM.id },
    ]);
  });
});
