import type {
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
} from '@brainstrike/db';
import { EmbeddingProviderFactory } from '@brainstrike/embeddings/factory';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSearchFunctionality } from '../use-search-functionality';

const mockDb = {
  query: vi.fn(),
};

vi.mock('@brainstrike/db', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    usePGliteDatabase: () => mockDb,
  };
});

const initializeWithModel =
  vi.fn<
    (
      modelConfig: unknown,
      onProgress?: unknown,
      deviceOverride?: 'wasm' | 'webgpu'
    ) => Promise<void>
  >();
const dispose = vi.fn<() => void>();
const generateQueryEmbedding = vi.fn<(text: string) => Promise<{ embedding: Float32Array }>>();

vi.mock('@brainstrike/embeddings/factory', () => ({
  EmbeddingProviderFactory: {
    createProvider: vi.fn(),
  },
}));

vi.mock('@brainstrike/embeddings/service', () => {
  class MockSimpleEmbeddingService {
    initializeWithModel(
      modelConfig: unknown,
      onProgress?: unknown,
      deviceOverride?: 'wasm' | 'webgpu'
    ): Promise<void> {
      return initializeWithModel(modelConfig, onProgress, deviceOverride);
    }

    generateQueryEmbedding(text: string): Promise<{ embedding: Float32Array }> {
      return generateQueryEmbedding(text);
    }

    dispose(): void {
      dispose();
    }
  }

  return {
    SimpleEmbeddingService: MockSimpleEmbeddingService,
  };
});

vi.mock('@brainstrike/vector-management', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/vector-management')>();
  return {
    ...actual,
    getActiveEmbeddingSetId: () => 'set-1',
  };
});

type ToastFn = Parameters<typeof useSearchFunctionality>[2];

describe('useSearchFunctionality', () => {
  const originalSearchDefaultThreshold = process.env['SEARCH_DEFAULT_THRESHOLD'];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['SEARCH_DEFAULT_THRESHOLD'] = undefined;
    mockDb.query.mockResolvedValue({
      rows: [
        {
          dimensions: 768,
          modelKey: 'jinaai/jina-embeddings-v3',
        },
      ],
    });
    initializeWithModel.mockResolvedValue(undefined);
    generateQueryEmbedding.mockResolvedValue({ embedding: new Float32Array([0.1, 0.2, 0.3]) });
    useModelRegistryStore.setState({
      error: null,
      hasLoaded: true,
      isLoading: false,
      models: [
        {
          bestFor: ['code', 'default'],
          capabilities: { defaultDimension: 768, type: 'embedding' },
          description: 'Code-optimized embeddings',
          icon: null,
          id: 'jinaai/jina-embeddings-v3',
          isEnabled: true,
          name: 'Jina Code',
          parameters: { size: '~300MB' },
          providerId: 'transformers',
          sortOrder: 1,
          tagline: null,
        },
      ],
      providers: [],
    });
    useVectorPreferencesStore.setState({
      devicePref: 'wasm',
      devicePrefConfigured: true,
      hasHydrated: true,
      reinitEveryN: 200,
      setDetectedDevicePref: vi.fn(),
      setDevicePref: vi.fn(),
      setReinitEveryN: vi.fn(),
      setVerboseOrtLogs: vi.fn(),
      verboseOrtLogs: false,
    });
  });

  afterEach(() => {
    if (originalSearchDefaultThreshold === undefined) {
      process.env['SEARCH_DEFAULT_THRESHOLD'] = undefined;
    } else {
      process.env['SEARCH_DEFAULT_THRESHOLD'] = originalSearchDefaultThreshold;
    }
  });

  it('no-ops when query is empty', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    const chunkRepository = { searchSimilar: vi.fn() } as unknown as FileChunkRepository;
    const repository = { findById: vi.fn() } as unknown as FileRecordRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, repository, toast));

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(result.current.hasSearched).toBe(false);
    expect(result.current.searchResults).toEqual([]);
    expect(
      (chunkRepository as unknown as { searchSimilar: () => unknown }).searchSimilar
    ).not.toHaveBeenCalled();
  });

  it('runs a local embedding search and enriches chunk results with file records', async () => {
    const toast = vi.fn() as unknown as ToastFn;

    const chunk1 = {
      chunkIndex: 0,
      content: 'hello world',
      createdAt: new Date().toISOString(),
      fileRecordId: 'f1',
      id: 'c1',
      tokenCount: 10,
      updatedAt: new Date().toISOString(),
    } as unknown as FileChunk;

    const chunk2 = {
      chunkIndex: 1,
      content: 'hello line 10',
      createdAt: new Date().toISOString(),
      fileRecordId: 'f1',
      id: 'c2',
      tokenCount: 12,
      updatedAt: new Date().toISOString(),
    } as unknown as FileChunk;

    const file = {
      createdAt: new Date().toISOString(),
      id: 'f1',
      name: 'app.tsx',
      path: '/repo/app.tsx',
      size: 123,
      updatedAt: new Date().toISOString(),
    } as unknown as FileRecord;

    const searchSimilar = vi.fn().mockResolvedValue([
      { chunk: chunk1, similarity: 0.6 },
      { chunk: chunk2, similarity: 0.9 },
    ]);

    const findById = vi.fn().mockResolvedValue(file);

    const chunkRepository = { searchSimilar } as unknown as FileChunkRepository;
    const repository = { findById } as unknown as FileRecordRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, repository, toast));

    act(() => {
      result.current.setSearchQuery('hello line');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    await waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
      expect(result.current.searching).toBe(false);
      expect(result.current.searchResults.length).toBe(2);
    });

    expect(initializeWithModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jinaai/jina-embeddings-v3' }),
      undefined,
      'wasm'
    );
    expect(generateQueryEmbedding).toHaveBeenCalledWith('hello line');

    // We should enrich each chunk with file record metadata
    for (const res of result.current.searchResults) {
      expect(res.fileRecord.id).toBe('f1');
      expect(res.fileRecord.name).toBe('app.tsx');
      expect(typeof res.similarity).toBe('number');
    }
  });

  it('passes code-query search options and uses fallback file records when metadata is missing', async () => {
    process.env['SEARCH_DEFAULT_THRESHOLD'] = '0.9';
    const toast = vi.fn() as unknown as ToastFn;
    const chunk = {
      chunkIndex: 0,
      content: 'export function runSearch() { return true; }',
      createdAt: '2026-06-01T00:00:00.000Z',
      fileRecordId: 'missing-file',
      id: 'c1',
      tokenCount: 10,
      updatedAt: '2026-06-01T00:00:00.000Z',
    } as unknown as FileChunk;
    const searchSimilar = vi.fn().mockResolvedValue([{ chunk, similarity: 0.7 }]);
    const findById = vi.fn().mockResolvedValue(null);
    const chunkRepository = { searchSimilar } as unknown as FileChunkRepository;
    const repository = { findById } as unknown as FileRecordRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, repository, toast));

    expect(result.current.searchThreshold).toBe(0.9);

    act(() => {
      result.current.setSearchThreshold(0.65);
      result.current.setSearchQuery('export function runSearch()');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    const [embeddingArg, optionsArg] = searchSimilar.mock.calls[0] ?? [];
    expect(embeddingArg).toEqual([expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3)]);
    expect(optionsArg).toEqual({
      chunkType: 'recursive',
      embeddingSetId: 'set-1',
      limit: 20,
      threshold: 0.65,
    });
    expect(findById).toHaveBeenCalledWith('missing-file');
    expect(result.current.searchResults[0]?.fileRecord).toMatchObject({
      id: 'missing-file',
      name: 'Unknown file',
      path: '(unavailable)',
      size: 0,
    });
  });

  it('runs a hosted embedding search through the provider factory', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    const embed = vi.fn().mockResolvedValue({
      ok: true,
      value: { embedding: [0.4, 0.5, 0.6] },
    });
    vi.mocked(EmbeddingProviderFactory.createProvider).mockResolvedValue({
      ok: true,
      value: { embed },
    } as unknown as Awaited<ReturnType<typeof EmbeddingProviderFactory.createProvider>>);
    mockDb.query.mockResolvedValue({
      rows: [
        {
          dimensions: 1536,
          modelKey: 'openai::text-embedding-3-small',
        },
      ],
    });
    const searchSimilar = vi.fn().mockResolvedValue([]);
    const chunkRepository = { searchSimilar } as unknown as FileChunkRepository;
    const repository = { findById: vi.fn() } as unknown as FileRecordRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, repository, toast));

    act(() => {
      result.current.setSearchQuery('hosted search');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(EmbeddingProviderFactory.createProvider).toHaveBeenCalledWith({
      dimensions: 1536,
      modelId: 'text-embedding-3-small',
      provider: 'openai',
      runtime: 'hosted',
    });
    expect(embed).toHaveBeenCalledWith({
      modelId: 'text-embedding-3-small',
      text: 'hosted search',
    });
    expect(searchSimilar).toHaveBeenCalledWith([0.4, 0.5, 0.6], {
      embeddingSetId: 'set-1',
      limit: 20,
      threshold: 0.5,
    });
  });

  it.each([
    [
      'google',
      'text-embedding-004',
      {
        modelId: 'text-embedding-004',
        outputDimensionality: 768,
        provider: 'google',
        runtime: 'hosted',
      },
    ],
    [
      'cohere',
      'embed-v4.0',
      {
        inputType: 'search_query',
        modelId: 'embed-v4.0',
        provider: 'cohere',
        runtime: 'hosted',
      },
    ],
    [
      'voyage',
      'voyage-3-large',
      {
        inputType: 'query',
        modelId: 'voyage-3-large',
        provider: 'voyage',
        runtime: 'hosted',
      },
    ],
  ] as const)('builds %s hosted embedding config for semantic search', async (provider, modelId, expectedConfig) => {
    const toast = vi.fn() as unknown as ToastFn;
    const embed = vi.fn().mockResolvedValue({
      ok: true,
      value: { embedding: [0.7, 0.8] },
    });
    vi.mocked(EmbeddingProviderFactory.createProvider).mockResolvedValue({
      ok: true,
      value: { embed },
    } as unknown as Awaited<ReturnType<typeof EmbeddingProviderFactory.createProvider>>);
    mockDb.query.mockResolvedValue({
      rows: [
        {
          dimensions: 768,
          modelKey: `${provider}::${modelId}`,
        },
      ],
    });
    const searchSimilar = vi.fn().mockResolvedValue([]);
    const chunkRepository = { searchSimilar } as unknown as FileChunkRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, null, toast));

    act(() => {
      result.current.setSearchQuery(`${provider} query`);
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(EmbeddingProviderFactory.createProvider).toHaveBeenCalledWith(expectedConfig);
    expect(embed).toHaveBeenCalledWith({
      modelId,
      text: `${provider} query`,
    });
  });

  it('surfaces hosted provider initialization failures through the search toast', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    vi.mocked(EmbeddingProviderFactory.createProvider).mockResolvedValue({
      error: { type: 'api_key_missing' },
      ok: false,
    } as unknown as Awaited<ReturnType<typeof EmbeddingProviderFactory.createProvider>>);
    mockDb.query.mockResolvedValue({
      rows: [
        {
          dimensions: 1536,
          modelKey: 'openai::text-embedding-3-small',
        },
      ],
    });
    const chunkRepository = { searchSimilar: vi.fn() } as unknown as FileChunkRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, null, toast));

    act(() => {
      result.current.setSearchQuery('hosted failure');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Failed to initialize hosted provider: api_key_missing',
        title: 'Search Failed',
        variant: 'destructive',
      })
    );
  });

  it('surfaces hosted embedding failures with original provider error messages', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    const embed = vi.fn().mockResolvedValue({
      error: {
        originalError: new Error('provider is unavailable'),
        type: 'provider_error',
      },
      ok: false,
    });
    vi.mocked(EmbeddingProviderFactory.createProvider).mockResolvedValue({
      ok: true,
      value: { embed },
    } as unknown as Awaited<ReturnType<typeof EmbeddingProviderFactory.createProvider>>);
    mockDb.query.mockResolvedValue({
      rows: [
        {
          dimensions: 1536,
          modelKey: 'openai::text-embedding-3-small',
        },
      ],
    });
    const chunkRepository = { searchSimilar: vi.fn() } as unknown as FileChunkRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, null, toast));

    act(() => {
      result.current.setSearchQuery('embed failure');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Embedding failed: provider is unavailable',
      })
    );
  });

  it('uses synthesized file records when search runs without a file repository', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    const chunk = {
      chunkIndex: 0,
      content: 'searchable content',
      createdAt: '2026-06-01T00:00:00.000Z',
      fileRecordId: 'file-without-repo',
      id: 'chunk-without-repo',
      tokenCount: 10,
      updatedAt: '2026-06-01T00:00:00.000Z',
    } as unknown as FileChunk;
    const searchSimilar = vi.fn().mockResolvedValue([{ chunk, similarity: 0.8 }]);
    const chunkRepository = { searchSimilar } as unknown as FileChunkRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, null, toast));

    act(() => {
      result.current.setSearchQuery('searchable content');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(result.current.searchResults[0]?.fileRecord).toMatchObject({
      id: 'file-without-repo',
      name: 'Unknown file',
      path: '(unavailable)',
      size: 0,
    });
  });

  it('completes with empty results when no chunk repository is available after embedding', async () => {
    const toast = vi.fn() as unknown as ToastFn;

    const { result } = renderHook(() => useSearchFunctionality(null, null, toast));

    act(() => {
      result.current.setSearchQuery('query without repository');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(generateQueryEmbedding).not.toHaveBeenCalled();
    expect(result.current.hasSearched).toBe(false);
    expect(result.current.searchResults).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('surfaces missing active embedding set model rows through the search toast', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    mockDb.query.mockResolvedValue({ rows: [] });
    const chunkRepository = { searchSimilar: vi.fn() } as unknown as FileChunkRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, null, toast));

    act(() => {
      result.current.setSearchQuery('missing model row');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Select an active embedding set in Vector Status, then retry.',
        title: 'Search Failed',
        variant: 'destructive',
      })
    );
    expect(result.current.searchResults).toEqual([]);
  });

  it('surfaces missing local model configuration through the search toast', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    useModelRegistryStore.setState({
      error: null,
      hasLoaded: true,
      isLoading: false,
      models: [],
      providers: [],
    });
    const chunkRepository = { searchSimilar: vi.fn() } as unknown as FileChunkRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, null, toast));

    act(() => {
      result.current.setSearchQuery('missing local model config');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          'Embedding set references unknown model: jinaai/jina-embeddings-v3. Available models: none. If the model exists but is disabled, enable it in Settings > Models.',
        title: 'Search Failed',
        variant: 'destructive',
      })
    );
    expect(initializeWithModel).not.toHaveBeenCalled();
  });

  it('treats non-array repository search responses as empty results', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    const searchSimilar = vi.fn().mockResolvedValue(null);
    const chunkRepository = { searchSimilar } as unknown as FileChunkRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, null, toast));

    act(() => {
      result.current.setSearchQuery('non array response');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    expect(result.current.searchResults).toEqual([]);
    expect(result.current.hasSearched).toBe(true);
  });

  it('surfaces a friendly toast when embeddingSetId is required', async () => {
    const toast = vi.fn() as unknown as ToastFn;
    const searchSimilar = vi.fn().mockRejectedValue(new Error('requires embeddingSetId'));
    const chunkRepository = { searchSimilar } as unknown as FileChunkRepository;
    const repository = { findById: vi.fn() } as unknown as FileRecordRepository;

    const { result } = renderHook(() => useSearchFunctionality(chunkRepository, repository, toast));

    act(() => {
      result.current.setSearchQuery('test');
    });

    await act(async () => {
      await result.current.handleSearch();
    });

    await waitFor(() => {
      expect(result.current.searching).toBe(false);
      expect(result.current.searchResults).toEqual([]);
      expect(result.current.hasSearched).toBe(true);
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Select an active embedding set in Vector Status, then retry.',
        title: 'Search Failed',
        variant: 'destructive',
      })
    );
  });
});
