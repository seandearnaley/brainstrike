import type {
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
} from '@brainstrike/db';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../../vector-preferences', () => ({
  getActiveEmbeddingSetId: () => 'set-1',
}));

type ToastFn = Parameters<typeof useSearchFunctionality>[2];

describe('useSearchFunctionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockResolvedValue({
      rows: [
        {
          modelKey: 'jinaai/jina-embeddings-v3',
          dimensions: 768,
        },
      ],
    });
    initializeWithModel.mockResolvedValue(undefined);
    generateQueryEmbedding.mockResolvedValue({ embedding: new Float32Array([0.1, 0.2, 0.3]) });
    useModelRegistryStore.setState({
      models: [
        {
          id: 'jinaai/jina-embeddings-v3',
          providerId: 'transformers',
          name: 'Jina Code',
          description: 'Code-optimized embeddings',
          tagline: null,
          bestFor: ['code', 'default'],
          icon: null,
          isEnabled: true,
          capabilities: { type: 'embedding', defaultDimension: 768 },
          parameters: { size: '~300MB' },
          sortOrder: 1,
        },
      ],
      providers: [],
      isLoading: false,
      hasLoaded: true,
      error: null,
    });
    useVectorPreferencesStore.setState({
      hasHydrated: true,
      devicePref: 'wasm',
      devicePrefConfigured: true,
      reinitEveryN: 200,
      verboseOrtLogs: false,
      setDetectedDevicePref: vi.fn(),
      setDevicePref: vi.fn(),
      setReinitEveryN: vi.fn(),
      setVerboseOrtLogs: vi.fn(),
    });
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
      id: 'c1',
      fileRecordId: 'f1',
      chunkIndex: 0,
      content: 'hello world',
      tokenCount: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as FileChunk;

    const chunk2 = {
      id: 'c2',
      fileRecordId: 'f1',
      chunkIndex: 1,
      content: 'hello line 10',
      tokenCount: 12,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as FileChunk;

    const file = {
      id: 'f1',
      name: 'app.tsx',
      path: '/repo/app.tsx',
      size: 123,
      createdAt: new Date().toISOString(),
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
        title: 'Search Failed',
        description: 'Select an active embedding set in Vector Status, then retry.',
        variant: 'destructive',
      })
    );
  });
});
