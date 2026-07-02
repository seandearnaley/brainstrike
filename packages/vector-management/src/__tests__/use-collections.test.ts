/**
 * @vitest-environment jsdom
 */

import type { EmbeddingSpaceListing } from '@brainstrike/db';
import { act, renderHook, waitFor } from '@testing-library/react';
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
    systemRole: null,
  },
];

const mockLiveQueryResult = {
  rows: mockCollectionRows,
  loading: false,
  error: null,
  refresh: vi.fn(),
};

const mockEmbeddingSetsRepository = {
  listEmbeddingSpaces: vi.fn<() => Promise<EmbeddingSpaceListing[]>>(async () => []),
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
  setCachedCollections: vi.fn((collections) => {
    mockStoreState.cachedCollections = collections;
  }),
  upsertCachedCollection: vi.fn((collection) => {
    mockStoreState.cachedCollections = [
      collection,
      ...mockStoreState.cachedCollections.filter((candidate) => candidate.id !== collection.id),
    ];
  }),
  removeCachedCollection: vi.fn((collectionId: string) => {
    mockStoreState.cachedCollections = mockStoreState.cachedCollections.filter(
      (collection) => collection.id !== collectionId
    );
  }),
  setCachedFileData: vi.fn(),
  setSchemaVerified: vi.fn(),
};

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeLiveQuery: vi.fn(() => mockLiveQueryResult),
  useBrainstrikeLiveQueryCapability: vi.fn(() => true),
  useEmbeddingSetsRepository: vi.fn(() => mockEmbeddingSetsRepository),
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

import {
  useBrainstrikeLiveQuery,
  useBrainstrikeLiveQueryCapability,
  useEmbeddingSetsRepository,
} from '@brainstrike/db';
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
    mockEmbeddingSetsRepository.listEmbeddingSpaces.mockResolvedValue([]);
    vi.mocked(useBrainstrikeLiveQuery).mockReturnValue(mockLiveQueryResult);
    vi.mocked(useBrainstrikeLiveQueryCapability).mockReturnValue(true);
    vi.mocked(useEmbeddingSetsRepository).mockReturnValue(mockEmbeddingSetsRepository as never);
  });

  describe('Live Query Enabling', () => {
    it('should enable live query when db is available, schema is verified, and not importing', () => {
      renderHook(() => useCollections(mockDb as any));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
        })
      );
    });

    it('uses incremental live query mode keyed by collection id', () => {
      renderHook(() => useCollections(mockDb as any));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'incremental',
          key: 'id',
        })
      );
    });

    it('selects durable system role metadata with collection rows', () => {
      renderHook(() => useCollections(mockDb as any));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('s.system_role AS "systemRole"'),
        })
      );
    });

    it('should disable live query when schema is not verified', () => {
      mockStoreState.schemaVerified = false;

      renderHook(() => useCollections(mockDb as any));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
    });

    it('should disable live query when importing files', () => {
      mockStoreState.isImporting = true;

      renderHook(() => useCollections(mockDb as any));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
    });

    it('should disable live query when db is null', () => {
      renderHook(() => useCollections(null));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
    });

    it('loads a repository snapshot when Turso intentionally withholds the generic db handle', async () => {
      vi.mocked(useBrainstrikeLiveQueryCapability).mockReturnValue(false);
      mockEmbeddingSetsRepository.listEmbeddingSpaces.mockResolvedValue([
        {
          category: 'search',
          createdAt: '2024-01-01T00:00:00Z',
          description: null,
          dimensions: 1536,
          distance: 'cosine',
          id: 'turso-set-1',
          modelId: 'text-embedding-3-small',
          modelKey: 'openai::text-embedding-3-small',
          name: 'Turso Collection',
          stats: {
            averageTokensPerChunk: 5,
            embeddedChunks: 7,
            fileCount: 3,
            tokenizedChunkCount: 8,
            totalChunks: 9,
            totalTokens: 45,
          },
          systemRole: null,
          tags: 'docs',
        },
      ]);

      const { result } = renderHook(() => useCollections(null));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
      await waitFor(() => expect(result.current.collections).toHaveLength(1));
      expect(result.current.collections[0]).toMatchObject({
        id: 'turso-set-1',
        fileCount: 3,
        chunkCount: 9,
        embeddingCount: 7,
        category: 'search',
        tags: 'docs',
      });
    });

    it('loads a repository snapshot before PGlite schema verification when only the repository is available', async () => {
      mockStoreState.schemaVerified = false;
      vi.mocked(useBrainstrikeLiveQueryCapability).mockReturnValue(false);
      mockEmbeddingSetsRepository.listEmbeddingSpaces.mockResolvedValue([
        {
          category: 'search',
          createdAt: '2024-01-01T00:00:00Z',
          description: null,
          dimensions: 1536,
          distance: 'cosine',
          id: 'turso-set-2',
          modelId: 'text-embedding-3-small',
          modelKey: 'openai::text-embedding-3-small',
          name: 'Turso Startup Collection',
          stats: {
            averageTokensPerChunk: 5,
            embeddedChunks: 6,
            fileCount: 2,
            tokenizedChunkCount: 6,
            totalChunks: 6,
            totalTokens: 30,
          },
          systemRole: null,
          tags: null,
        },
      ]);

      const { result } = renderHook(() => useCollections(null));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
      await waitFor(() => expect(result.current.collections).toHaveLength(1));
      expect(mockEmbeddingSetsRepository.listEmbeddingSpaces).toHaveBeenCalledWith({
        includeStats: true,
      });
      expect(result.current.collections[0]).toMatchObject({
        id: 'turso-set-2',
        fileCount: 2,
        chunkCount: 6,
        embeddingCount: 6,
      });
    });

    it('should disable live query and use snapshot data when no PGlite live source is available', async () => {
      vi.mocked(useBrainstrikeLiveQueryCapability).mockReturnValue(false);
      mockDb.query.mockResolvedValue({ rows: mockCollectionRows });
      vi.mocked(useEmbeddingSetsRepository).mockReturnValue(null as never);

      const { result } = renderHook(() => useCollections(mockDb as any));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );

      await waitFor(() => expect(result.current.collections).toHaveLength(1));
      expect(result.current.collections.at(0)?.id).toBe('set-1');
    });

    it('prefers the repository snapshot over raw SQL when Turso exposes a generic query handle', async () => {
      vi.mocked(useBrainstrikeLiveQueryCapability).mockReturnValue(false);
      mockDb.query.mockRejectedValue(new Error('raw SQL should not be used for Turso collections'));
      mockEmbeddingSetsRepository.listEmbeddingSpaces.mockResolvedValue([
        {
          category: 'search',
          createdAt: '2024-01-01T00:00:00Z',
          description: null,
          dimensions: 1536,
          distance: 'cosine',
          id: 'turso-set-query-handle',
          modelId: 'text-embedding-3-small',
          modelKey: 'openai::text-embedding-3-small',
          name: 'Turso Query Handle Collection',
          stats: {
            averageTokensPerChunk: 5,
            embeddedChunks: 11,
            fileCount: 4,
            tokenizedChunkCount: 12,
            totalChunks: 13,
            totalTokens: 60,
          },
          systemRole: null,
          tags: 'docs',
        },
      ]);

      const { result } = renderHook(() => useCollections(mockDb as any));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
      await waitFor(() => expect(result.current.collections).toHaveLength(1));
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockEmbeddingSetsRepository.listEmbeddingSpaces).toHaveBeenCalledWith({
        includeStats: true,
      });
      expect(result.current.collections.at(0)).toMatchObject({
        id: 'turso-set-query-handle',
        fileCount: 4,
        chunkCount: 13,
        embeddingCount: 11,
        category: 'search',
        tags: 'docs',
      });
    });

    it('keeps the collection live query attached during embedding generation', () => {
      mockStoreState.isEmbeddingActive = true;

      const { result } = renderHook(() => useCollections(mockDb as never));

      expect(useBrainstrikeLiveQuery).toHaveBeenCalledWith(
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
      vi.mocked(useBrainstrikeLiveQuery).mockReturnValue({
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
      vi.mocked(useBrainstrikeLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        loading: true,
      });

      const { result } = renderHook(() => useCollections(mockDb as any));

      expect(result.current.loading).toBe(true);
    });

    it('prefers live collections over stale cached collections while loading', () => {
      mockStoreState.cachedCollections = [
        {
          id: 'set-1',
          modelKey: 'openai',
          modelId: 'text-embedding-3-small',
          dimensions: 1536,
          distance: 'cosine',
          createdAt: '2024-01-01T00:00:00Z',
          name: 'Stale Cached Name',
          description: 'stale',
          tags: null,
          category: null,
          fileCount: 1,
          chunkCount: 2,
          embeddingCount: 3,
        },
      ];
      vi.mocked(useBrainstrikeLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        loading: true,
      });

      const { result } = renderHook(() => useCollections(mockDb as any));

      expect(result.current.collections).toEqual([
        expect.objectContaining({
          id: 'set-1',
          name: 'Test Collection',
          fileCount: 10,
          chunkCount: 100,
          embeddingCount: 50,
        }),
      ]);
    });

    it('should return error state from live query when enabled', () => {
      const testError = new Error('Test error');
      vi.mocked(useBrainstrikeLiveQuery).mockReturnValue({
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
          fileCount: 10,
          chunkCount: 100,
          embeddingCount: 50,
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
          new CustomEvent('brainstrike:queue-drained', {
            detail: { queue: 'embeddings', embeddingSetId: 'set-1' },
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
          new CustomEvent('brainstrike:embedding-set-updated', {
            detail: {
              id: 'set-2',
              reason: 'created',
              collection: {
                id: 'set-2',
                modelKey: 'openai',
                modelId: 'text-embedding-3-small',
                dimensions: 1536,
                distance: 'cosine',
                createdAt: '2024-01-02T00:00:00Z',
                name: 'Created Collection',
                description: null,
                tags: null,
                category: null,
                fileCount: 0,
                chunkCount: 0,
                embeddingCount: 0,
              },
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
          new CustomEvent('brainstrike:embedding-set-updated', {
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
          new CustomEvent('brainstrike:embedding-set-updated', {
            detail: {
              id: 'set-optimistic',
              reason: 'created',
              collection: {
                id: 'set-optimistic',
                modelKey: 'openai',
                modelId: 'text-embedding-3-small',
                dimensions: 1536,
                distance: 'cosine',
                createdAt: '2024-01-03T00:00:00Z',
                name: 'Optimistic Collection',
                description: null,
                tags: null,
                category: null,
                fileCount: 0,
                chunkCount: 0,
                embeddingCount: 0,
              },
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
          new CustomEvent('brainstrike:embedding-set-updated', {
            detail: {
              id: 'set-created',
              reason: 'created',
              collection: {
                id: 'set-created',
                modelKey: 'openai',
                modelId: 'text-embedding-3-small',
                dimensions: 1536,
                distance: 'cosine',
                createdAt: '2024-01-05T00:00:00Z',
                name: 'Created Without Tab Switch',
                description: null,
                tags: null,
                category: null,
                fileCount: 0,
                chunkCount: 0,
                embeddingCount: 0,
              },
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
          fileCount: 10,
          chunkCount: 100,
          embeddingCount: 50,
        },
      ];
      mockDb.query.mockResolvedValue({ rows: mockCollectionRows });

      const { result, rerender } = renderHook(() => useCollections(mockDb as never));
      await waitFor(() => {
        expect(mockDb.query).toHaveBeenCalled();
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('brainstrike:embedding-set-updated', {
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
      vi.mocked(useBrainstrikeLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        rows: [{ ...mockCollectionRows[0], fileCount: '42' }],
      });

      const { result } = renderHook(() => useCollections(mockDb as any));
      const first = result.current.collections.at(0);

      expect(first?.fileCount).toBe(42);
      expect(typeof first?.fileCount).toBe('number');
    });

    it('should normalize string chunkCount to number', () => {
      vi.mocked(useBrainstrikeLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        rows: [{ ...mockCollectionRows[0], chunkCount: '200' }],
      });

      const { result } = renderHook(() => useCollections(mockDb as any));
      const first = result.current.collections.at(0);

      expect(first?.chunkCount).toBe(200);
      expect(typeof first?.chunkCount).toBe('number');
    });

    it('should normalize string embeddingCount to number', () => {
      vi.mocked(useBrainstrikeLiveQuery).mockReturnValue({
        ...mockLiveQueryResult,
        rows: [{ ...mockCollectionRows[0], embeddingCount: '75' }],
      });

      const { result } = renderHook(() => useCollections(mockDb as any));
      const first = result.current.collections.at(0);

      expect(first?.embeddingCount).toBe(75);
      expect(typeof first?.embeddingCount).toBe('number');
    });

    it('should handle null/undefined counts as 0', () => {
      vi.mocked(useBrainstrikeLiveQuery).mockReturnValue({
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
