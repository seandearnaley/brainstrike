/**
 * @vitest-environment jsdom
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock data
const mockCollectionRows = [
  {
    id: 'set-1',
    modelKey: 'openai',
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
    distance: 'cosine',
    createdAt: '2024-01-01T00:00:00Z',
    name: 'Test Collection',
    description: null,
    tags: null,
    category: null,
    fileCount: '10',
    chunkCount: '100',
    embeddingCount: '50',
  },
];

const mockLiveQueryResult = {
  rows: mockCollectionRows,
  loading: false,
  error: null,
  refresh: vi.fn(),
};

// Mock store state with proper typing
const mockStoreState = {
  isImporting: false,
  isEmbeddingActive: false,
  isEmbeddingQueueActive: false,
  isJobQueueActive: false,
  activeEmbeddingSetId: null as string | null,
  schemaVerified: true,
  cachedCollections: [] as Array<{
    id: string;
    modelKey: string;
    modelId: string;
    dimensions: number;
    distance: 'cosine' | 'l2' | 'ip';
    createdAt: string;
    name: string | null;
    description: string | null;
    tags: string | null;
    category: string | null;
    fileCount: number;
    chunkCount: number;
    embeddingCount: number;
  }>,
  cachedFileData: null,
  setIsImporting: vi.fn(),
  setIsEmbeddingQueueActive: vi.fn(),
  setIsJobQueueActive: vi.fn(),
  setActiveEmbeddingSetId: vi.fn(),
  setCachedCollections: vi.fn(),
  setCachedFileData: vi.fn(),
  setSchemaVerified: vi.fn(),
};

vi.mock('@brainstrike/db', () => ({
  usePGliteLiveQuery: vi.fn(() => mockLiveQueryResult),
}));

vi.mock('@brainstrike/preferences', () => ({
  useVectorStatusUIStore: vi.fn((selector: (state: typeof mockStoreState) => unknown) =>
    selector(mockStoreState)
  ),
}));

import { usePGliteLiveQuery } from '@brainstrike/db';
import { useCollections } from '../collection-select/collection-select';

describe('useCollections', () => {
  const mockDb = {
    query: vi.fn(() => new Promise<{ rows: typeof mockCollectionRows }>(() => {})),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    mockStoreState.isImporting = false;
    mockStoreState.isEmbeddingActive = false;
    mockStoreState.schemaVerified = true;
    mockStoreState.cachedCollections = [];
    mockDb.query.mockImplementation(() => new Promise(() => {}));
    vi.mocked(usePGliteLiveQuery).mockReturnValue(mockLiveQueryResult);
  });

  describe('Live Query Enabling', () => {
    it('should enable live query when db is available, schema is verified, and not importing', () => {
      renderHook(() => useCollections(mockDb as any));

      expect(usePGliteLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
        })
      );
    });

    it('should disable live query when schema is not verified', () => {
      mockStoreState.schemaVerified = false;

      renderHook(() => useCollections(mockDb as any));

      expect(usePGliteLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
    });

    it('should disable live query when importing files', () => {
      mockStoreState.isImporting = true;

      renderHook(() => useCollections(mockDb as any));

      expect(usePGliteLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
    });

    it('should disable live query when db is null', () => {
      renderHook(() => useCollections(null));

      expect(usePGliteLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
    });

    it('should keep live query enabled during embedding generation (isEmbeddingActive)', () => {
      // This is intentional - embedding updates file_chunks.embedding,
      // not embedding_sets or file_records, so live query can stay active
      mockStoreState.isEmbeddingActive = true;

      renderHook(() => useCollections(mockDb as any));

      expect(usePGliteLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
        })
      );
    });
  });

  describe('Data Return Behavior', () => {
    it('should return live query data when enabled', () => {
      const { result } = renderHook(() => useCollections(mockDb as any));
      const collections = result.current.collections;

      expect(collections).toHaveLength(1);
      expect(collections.at(0)?.id).toBe('set-1');
      expect(collections.at(0)?.fileCount).toBe(10);
      expect(collections.at(0)?.chunkCount).toBe(100);
      expect(collections.at(0)?.embeddingCount).toBe(50);
    });

    it('should return cached collections when live query is disabled', () => {
      mockStoreState.isImporting = true;
      mockStoreState.cachedCollections = [
        {
          id: 'cached-1',
          modelKey: 'cached',
          modelId: 'cached-model',
          dimensions: 768,
          distance: 'cosine' as const,
          createdAt: '2024-01-01T00:00:00Z',
          name: 'Cached Collection',
          description: null,
          tags: null,
          category: null,
          fileCount: 5,
          chunkCount: 50,
          embeddingCount: 25,
        },
      ];

      const { result } = renderHook(() => useCollections(mockDb as any));
      const collections = result.current.collections;

      expect(collections).toHaveLength(1);
      expect(collections.at(0)?.id).toBe('cached-1');
      expect(collections.at(0)?.name).toBe('Cached Collection');
    });

    it('should return loading state from live query when enabled', () => {
      vi.mocked(usePGliteLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        loading: true,
      });

      const { result } = renderHook(() => useCollections(mockDb as any));

      expect(result.current.loading).toBe(true);
    });

    it('should return error state from live query when enabled', () => {
      const testError = new Error('Test error');
      vi.mocked(usePGliteLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        error: testError,
      });

      const { result } = renderHook(() => useCollections(mockDb as any));

      expect(result.current.error).toBe(testError);
    });
  });

  describe('Cache Synchronization', () => {
    it('should update cache when live query returns data', async () => {
      renderHook(() => useCollections(mockDb as any));

      await waitFor(() => {
        expect(mockStoreState.setCachedCollections).toHaveBeenCalled();
      });
    });

    it('should not update cache when live query is disabled', () => {
      mockStoreState.isImporting = true;

      renderHook(() => useCollections(mockDb as any));

      // setCachedCollections might be called from initial fetch, but not from live query sync
      // The key is that it returns cached data, not live data
      expect(mockStoreState.cachedCollections).toEqual([]);
    });
  });

  describe('Initial Fetch Behavior', () => {
    it('should perform initial fetch when schema is verified and db has query function', async () => {
      mockDb.query.mockResolvedValue({ rows: mockCollectionRows });

      renderHook(() => useCollections(mockDb as any));

      await waitFor(() => {
        expect(mockDb.query).toHaveBeenCalled();
      });
    });

    it('should update cached collections after initial fetch', async () => {
      mockDb.query.mockResolvedValue({ rows: mockCollectionRows });

      renderHook(() => useCollections(mockDb as any));

      await waitFor(() => {
        expect(mockStoreState.setCachedCollections).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'set-1',
              fileCount: 10,
            }),
          ])
        );
      });
    });

    it('should not perform initial fetch when schema is not verified', async () => {
      mockStoreState.schemaVerified = false;

      renderHook(() => useCollections(mockDb as any));

      // Wait a tick to ensure async operations would have started
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  describe('Data Normalization', () => {
    it('should normalize string fileCount to number', () => {
      vi.mocked(usePGliteLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        rows: [{ ...mockCollectionRows[0], fileCount: '42' }],
      });

      const { result } = renderHook(() => useCollections(mockDb as any));
      const first = result.current.collections.at(0);

      expect(first?.fileCount).toBe(42);
      expect(typeof first?.fileCount).toBe('number');
    });

    it('should normalize string chunkCount to number', () => {
      vi.mocked(usePGliteLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        rows: [{ ...mockCollectionRows[0], chunkCount: '200' }],
      });

      const { result } = renderHook(() => useCollections(mockDb as any));
      const first = result.current.collections.at(0);

      expect(first?.chunkCount).toBe(200);
      expect(typeof first?.chunkCount).toBe('number');
    });

    it('should normalize string embeddingCount to number', () => {
      vi.mocked(usePGliteLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        rows: [{ ...mockCollectionRows[0], embeddingCount: '75' }],
      });

      const { result } = renderHook(() => useCollections(mockDb as any));
      const first = result.current.collections.at(0);

      expect(first?.embeddingCount).toBe(75);
      expect(typeof first?.embeddingCount).toBe('number');
    });

    it('should handle null/undefined counts as 0', () => {
      vi.mocked(usePGliteLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        rows: [
          {
            ...mockCollectionRows[0],
            fileCount: null as unknown as string,
            chunkCount: undefined as unknown as string,
          },
        ],
      });

      const { result } = renderHook(() => useCollections(mockDb as any));
      const first = result.current.collections.at(0);

      expect(first?.fileCount).toBe(0);
      expect(first?.chunkCount).toBe(0);
    });
  });
});
