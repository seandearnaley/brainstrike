/**
 * @vitest-environment jsdom
 */
import {
  EMBEDDING_SET_UPDATED_EVENT,
  QUEUE_DRAINED_EVENT,
} from '@brainstrike/utils/browser-events';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock data
const mockCollectionRows = [
  {
    category: null,
    chunkCount: '100',
    createdAt: '2024-01-01T00:00:00Z',
    description: null,
    dimensions: 1536,
    distance: 'cosine',
    embeddingCount: '50',
    fileCount: '10',
    id: 'set-1',
    modelId: 'text-embedding-3-small',
    modelKey: 'openai',
    name: 'Test Collection',
    systemRole: null,
    tags: null,
  },
];

const mockLiveQueryResult = {
  error: null,
  loading: false,
  refresh: vi.fn(),
  rows: mockCollectionRows,
};

// Mock store state with proper typing
const mockStoreState = {
  activeEmbeddingSetId: null as string | null,
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
  isEmbeddingActive: false,
  isEmbeddingQueueActive: false,
  isImporting: false,
  isJobQueueActive: false,
  removeCachedCollection: vi.fn((collectionId: string) => {
    mockStoreState.cachedCollections = mockStoreState.cachedCollections.filter(
      (collection) => collection.id !== collectionId
    );
  }),
  schemaVerified: true,
  setActiveEmbeddingSetId: vi.fn(),
  setCachedCollections: vi.fn((collections) => {
    mockStoreState.cachedCollections = collections;
  }),
  setCachedFileData: vi.fn(),
  setIsEmbeddingQueueActive: vi.fn(),
  setIsImporting: vi.fn(),
  setIsJobQueueActive: vi.fn(),
  setSchemaVerified: vi.fn(),
  upsertCachedCollection: vi.fn((collection) => {
    mockStoreState.cachedCollections = [
      collection,
      ...mockStoreState.cachedCollections.filter((candidate) => candidate.id !== collection.id),
    ];
  }),
};

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteLiveQuery: vi.fn(() => mockLiveQueryResult),
}));

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/preferences/stores/vector-status-ui-store')>();
  return {
    ...actual,
    useVectorStatusUIStore: vi.fn((selector: (state: typeof mockStoreState) => unknown) =>
      selector(mockStoreState)
    ),
  };
});

import { usePGliteLiveQuery } from '@brainstrike/db';
import { useCollections } from '../collection-select/collection-select';

describe('useCollections', () => {
  const mockDb = {
    query: vi.fn(),
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

    it('uses incremental live query mode keyed by collection id', () => {
      renderHook(() => useCollections(mockDb as any));

      expect(usePGliteLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'id',
          mode: 'incremental',
        })
      );
    });

    it('selects durable system role metadata with collection rows', () => {
      renderHook(() => useCollections(mockDb as any));

      expect(usePGliteLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('s.system_role AS "systemRole"'),
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

    it('keeps the collection live query attached during embedding generation', () => {
      mockStoreState.isEmbeddingActive = true;

      const { result } = renderHook(() => useCollections(mockDb as never));

      expect(usePGliteLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
        })
      );
      expect(result.current.collections.at(0)?.embeddingCount).toBe(50);
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

    it('preserves workspace index system role metadata from live rows', () => {
      vi.mocked(usePGliteLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        rows: [{ ...mockCollectionRows[0], systemRole: 'workspace-index' }],
      });

      const { result } = renderHook(() => useCollections(mockDb as any));

      expect(result.current.collections.at(0)?.systemRole).toBe('workspace-index');
    });

    it('should return cached collections when live query is disabled', () => {
      mockStoreState.isImporting = true;
      mockStoreState.cachedCollections = [
        {
          category: null,
          chunkCount: 50,
          createdAt: '2024-01-01T00:00:00Z',
          description: null,
          dimensions: 768,
          distance: 'cosine' as const,
          embeddingCount: 25,
          fileCount: 5,
          id: 'cached-1',
          modelId: 'cached-model',
          modelKey: 'cached',
          name: 'Cached Collection',
          tags: null,
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

    it('prefers live collections over stale cached collections while loading', () => {
      mockStoreState.cachedCollections = [
        {
          category: null,
          chunkCount: 2,
          createdAt: '2024-01-01T00:00:00Z',
          description: 'stale',
          dimensions: 1536,
          distance: 'cosine',
          embeddingCount: 3,
          fileCount: 1,
          id: 'set-1',
          modelId: 'text-embedding-3-small',
          modelKey: 'openai',
          name: 'Stale Cached Name',
          tags: null,
        },
      ];
      vi.mocked(usePGliteLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        loading: true,
      });

      const { result } = renderHook(() => useCollections(mockDb as any));

      expect(result.current.collections).toEqual([
        expect.objectContaining({
          chunkCount: 100,
          embeddingCount: 50,
          fileCount: 10,
          id: 'set-1',
          name: 'Test Collection',
        }),
      ]);
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

    it('does not rewrite the cached collection snapshot when the live rows already match', async () => {
      mockStoreState.cachedCollections = [
        {
          category: null,
          chunkCount: 100,
          createdAt: '2024-01-01T00:00:00Z',
          description: null,
          dimensions: 1536,
          distance: 'cosine',
          embeddingCount: 50,
          fileCount: 10,
          id: 'set-1',
          modelId: 'text-embedding-3-small',
          modelKey: 'openai',
          name: 'Test Collection',
          tags: null,
        },
      ];

      renderHook(() => useCollections(mockDb as any));

      await waitFor(() => {
        expect(mockStoreState.setCachedCollections).not.toHaveBeenCalled();
      });
    });

    it('should not update cache when live query is disabled', () => {
      mockStoreState.isImporting = true;

      renderHook(() => useCollections(mockDb as any));

      // setCachedCollections might be called from initial fetch, but not from live query sync
      // The key is that it returns cached data, not live data
      expect(mockStoreState.cachedCollections).toEqual([]);
    });

    it('does not reattach the live query when embedding activity settles', async () => {
      mockStoreState.isEmbeddingActive = true;

      const { rerender } = renderHook(() => useCollections(mockDb as any));

      expect(mockLiveQueryResult.refresh).not.toHaveBeenCalled();

      mockStoreState.isEmbeddingActive = false;
      rerender();

      expect(mockLiveQueryResult.refresh).not.toHaveBeenCalled();
    });

    it('refreshes cached collections when the embeddings queue drains', async () => {
      mockStoreState.isEmbeddingActive = true;
      mockDb.query.mockResolvedValue({
        rows: [{ ...mockCollectionRows[0], embeddingCount: '100' }],
      });

      renderHook(() => useCollections(mockDb as any));

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(QUEUE_DRAINED_EVENT, {
            detail: { embeddingSetId: 'set-1', queue: 'embeddings' },
          })
        );
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'));
      });
      expect(mockStoreState.setCachedCollections).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ embeddingCount: 100 })])
      );
    });

    it('refreshes cached collections when an embedding set is created while import pauses live queries', async () => {
      mockStoreState.isImporting = true;
      mockDb.query.mockResolvedValue({
        rows: [{ ...mockCollectionRows[0], id: 'set-2', name: 'Created Collection' }],
      });

      renderHook(() => useCollections(mockDb as never));

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(EMBEDDING_SET_UPDATED_EVENT, {
            detail: {
              collection: {
                category: null,
                chunkCount: 0,
                createdAt: '2024-01-02T00:00:00Z',
                description: null,
                dimensions: 1536,
                distance: 'cosine',
                embeddingCount: 0,
                fileCount: 0,
                id: 'set-2',
                modelId: 'text-embedding-3-small',
                modelKey: 'openai',
                name: 'Created Collection',
                tags: null,
              },
              id: 'set-2',
              reason: 'created',
            },
          })
        );
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'));
      });
      expect(mockStoreState.setCachedCollections).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'set-2', name: 'Created Collection' }),
        ])
      );
    });

    it('refreshes the paused collections snapshot when an embedding set update event arrives during import', async () => {
      mockStoreState.isImporting = true;
      let resolveInitialQuery: ((value: { rows: typeof mockCollectionRows }) => void) | undefined;
      const initialQuery = new Promise<{ rows: typeof mockCollectionRows }>((resolve) => {
        resolveInitialQuery = resolve;
      });

      mockDb.query
        .mockImplementationOnce(() => initialQuery)
        .mockResolvedValueOnce({ rows: mockCollectionRows });

      const { result } = renderHook(() => useCollections(mockDb as never));

      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });
      await waitFor(() => {
        expect(mockDb.query).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(EMBEDDING_SET_UPDATED_EVENT, {
            detail: { id: 'set-1', reason: 'updated' },
          })
        );
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mockDb.query.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(mockStoreState.setCachedCollections).toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ id: 'set-1' })])
        );
      });

      expect(resolveInitialQuery).toBeDefined();
      await act(async () => {
        resolveInitialQuery?.({ rows: mockCollectionRows });
      });
    });

    it('shows a newly created collection immediately before the refresh query resolves', async () => {
      mockStoreState.isImporting = true;
      let resolveQuery: ((value: { rows: typeof mockCollectionRows }) => void) | undefined;
      const delayedQuery = new Promise<{ rows: typeof mockCollectionRows }>((resolve) => {
        resolveQuery = resolve;
      });
      mockDb.query.mockImplementation(() => delayedQuery);

      const { result, rerender } = renderHook(() => useCollections(mockDb as never));
      await waitFor(() => {
        expect(mockDb.query).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(EMBEDDING_SET_UPDATED_EVENT, {
            detail: {
              collection: {
                category: null,
                chunkCount: 0,
                createdAt: '2024-01-03T00:00:00Z',
                description: null,
                dimensions: 1536,
                distance: 'cosine',
                embeddingCount: 0,
                fileCount: 0,
                id: 'set-optimistic',
                modelId: 'text-embedding-3-small',
                modelKey: 'openai',
                name: 'Optimistic Collection',
                tags: null,
              },
              id: 'set-optimistic',
              reason: 'created',
            },
          })
        );
        await Promise.resolve();
      });

      rerender();

      expect(result.current.collections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'set-optimistic', name: 'Optimistic Collection' }),
        ])
      );

      await act(async () => {
        resolveQuery?.({ rows: mockCollectionRows });
      });
    });

    it('does not let stale live-query rows erase a newly created collection before refresh catches up', async () => {
      mockStoreState.cachedCollections = [];
      mockDb.query.mockResolvedValue({ rows: mockCollectionRows });

      renderHook(() => useCollections(mockDb as never));
      await waitFor(() => {
        expect(mockDb.query).toHaveBeenCalled();
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(EMBEDDING_SET_UPDATED_EVENT, {
            detail: {
              collection: {
                category: null,
                chunkCount: 0,
                createdAt: '2024-01-05T00:00:00Z',
                description: null,
                dimensions: 1536,
                distance: 'cosine',
                embeddingCount: 0,
                fileCount: 0,
                id: 'set-created',
                modelId: 'text-embedding-3-small',
                modelKey: 'openai',
                name: 'Created Without Tab Switch',
                tags: null,
              },
              id: 'set-created',
              reason: 'created',
            },
          })
        );
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mockStoreState.cachedCollections).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'set-created', name: 'Created Without Tab Switch' }),
          ])
        );
      });
    });

    it('does not resurface a deleted collection from stale live-query rows before refresh catches up', async () => {
      mockStoreState.cachedCollections = [
        {
          category: null,
          chunkCount: 100,
          createdAt: '2024-01-01T00:00:00Z',
          description: null,
          dimensions: 1536,
          distance: 'cosine',
          embeddingCount: 50,
          fileCount: 10,
          id: 'set-1',
          modelId: 'text-embedding-3-small',
          modelKey: 'openai',
          name: 'Test Collection',
          tags: null,
        },
      ];
      mockDb.query.mockResolvedValue({ rows: mockCollectionRows });

      const { result, rerender } = renderHook(() => useCollections(mockDb as never));
      await waitFor(() => {
        expect(mockDb.query).toHaveBeenCalled();
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(EMBEDDING_SET_UPDATED_EVENT, {
            detail: { id: 'set-1', reason: 'deleted' },
          })
        );
        await Promise.resolve();
      });

      rerender();

      expect(
        result.current.collections.find((collection) => collection.id === 'set-1')
      ).toBeUndefined();
      expect(
        mockStoreState.cachedCollections.find((collection) => collection.id === 'set-1')
      ).toBeUndefined();
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
              fileCount: 10,
              id: 'set-1',
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
            chunkCount: undefined as unknown as string,
            fileCount: null as unknown as string,
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
