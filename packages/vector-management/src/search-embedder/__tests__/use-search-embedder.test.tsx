import type { EmbeddingModelConfig } from '@brainstrike/indexing-contract';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingSetModelInfo } from '../use-search-embedder';
import { useSearchEmbedder } from '../use-search-embedder';

// Shared, persistent mocks. Wiring the service constructor once (instead of
// swapping mockImplementation per test) keeps each `new SimpleEmbeddingService()`
// pointed at the SAME generateQueryEmbedding fn, so a `mockRejectedValueOnce`
// device-loss error correctly carries across the retry's fresh instance.
const { MockSimpleEmbeddingService, mockGenerateQueryEmbedding, mockCreateProvider, mockEmbed } =
  vi.hoisted(() => ({
    MockSimpleEmbeddingService: vi.fn(),
    mockCreateProvider: vi.fn(),
    mockEmbed: vi.fn(),
    mockGenerateQueryEmbedding: vi.fn(),
  }));

vi.mock('@brainstrike/embeddings/factory', () => ({
  EmbeddingProviderFactory: { createProvider: mockCreateProvider },
}));

vi.mock('@brainstrike/embeddings/service', () => {
  MockSimpleEmbeddingService.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {
      dispose: vi.fn(),
      generateQueryEmbedding: mockGenerateQueryEmbedding,
      initializeWithModel: vi.fn().mockResolvedValue(undefined),
    });
  });
  return { SimpleEmbeddingService: MockSimpleEmbeddingService };
});

const localModelConfig: EmbeddingModelConfig = {
  description: 'Code-optimized embeddings',
  dimensions: 1024,
  id: 'jinaai/jina-embeddings-v3',
  name: 'Jina Code',
  origin: 'transformers',
  quantized: false,
  tags: ['code'],
};

const hostedInfo: EmbeddingSetModelInfo = {
  dimensions: 1536,
  modelConfig: null,
  modelKey: 'openai::text-embedding-3-small',
};

const localInfo: EmbeddingSetModelInfo = {
  dimensions: 1024,
  modelConfig: localModelConfig,
  modelKey: 'jinaai/jina-embeddings-v3',
};

describe('useSearchEmbedder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVectorPreferencesStore.setState({ devicePref: 'wasm' });
    mockGenerateQueryEmbedding.mockReset();
    mockGenerateQueryEmbedding.mockResolvedValue({ embedding: new Array(1024).fill(0.25) });
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue({ ok: true, value: { embedding: new Array(1536).fill(0.1) } });
    mockCreateProvider.mockReset();
    mockCreateProvider.mockResolvedValue({ ok: true, value: { embed: mockEmbed } });
  });

  it('resolves a hosted embedder whose embedQuery maps provider results', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const embedder = await result.current.ensureEmbedderReady(hostedInfo);

    expect(embedder.runtime).toBe('hosted');
    const { embedding } = await embedder.embedQuery('hello');
    expect(embedding).toHaveLength(1536);
    expect(mockEmbed).toHaveBeenCalledWith({ modelId: 'text-embedding-3-small', text: 'hello' });
    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
        runtime: 'hosted',
      })
    );
  });

  it('reuses the cached embedder for the same model (factory called once)', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const first = await result.current.ensureEmbedderReady(hostedInfo);
    const second = await result.current.ensureEmbedderReady(hostedInfo);

    expect(second).toBe(first);
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
  });

  it('embedQueryWithRecovery retries exactly once on a device-loss error', async () => {
    mockGenerateQueryEmbedding.mockReset();
    mockGenerateQueryEmbedding
      .mockRejectedValueOnce(new Error('WebGPU device was lost: Device.Destroyed'))
      .mockResolvedValue({ embedding: new Array(1024).fill(0.5) });

    const { result } = renderHook(() => useSearchEmbedder());

    const embedding = await result.current.embedQueryWithRecovery(localInfo, 'query');

    expect(embedding).toHaveLength(1024);
    // A fresh embedder is built for the retry.
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(2);
    expect(mockGenerateQueryEmbedding).toHaveBeenCalledTimes(2);
  });

  it('embedQueryWithRecovery rethrows non-device-loss errors without rebuilding', async () => {
    mockGenerateQueryEmbedding.mockReset();
    mockGenerateQueryEmbedding.mockRejectedValue(new Error('out of memory'));

    const { result } = renderHook(() => useSearchEmbedder());

    await expect(result.current.embedQueryWithRecovery(localInfo, 'query')).rejects.toThrow(
      'out of memory'
    );
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
  });
});
