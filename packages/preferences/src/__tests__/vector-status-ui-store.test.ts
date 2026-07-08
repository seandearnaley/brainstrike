import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetVectorStatusUIStoreForTests,
  type CachedCollection,
  compareCollectionsDesc,
  useVectorStatusUIStore,
  vectorStatusUISelectors,
} from '../stores/vector-status-ui-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useVectorStatusUIStore as PersistApi<typeof useVectorStatusUIStore>;

/**
 * Test suite for vector-status-ui-store
 *
 * Particularly important for testing removeCachedCollection
 * which uses functional state updates to avoid stale closure bugs.
 */
describe('vector-status-ui-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(
      window as Window & {
        electronAPI?: unknown;
      },
      'electronAPI'
    );
    __resetVectorStatusUIStoreForTests();
  });

  it('persists the active embedding set id only', () => {
    const snapshot = useVectorStatusUIStore.getState();

    snapshot.setActiveEmbeddingSetId('embedding-set-1');
    snapshot.setIsImporting(true);

    expect(vectorStatusUISelectors.activeSet(useVectorStatusUIStore.getState())).toBe(
      'embedding-set-1'
    );

    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const persisted = options.storage.getItem(options.name);
    if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
      throw new Error('expected persisted snapshot');
    }

    expect(persisted).toEqual({
      state: { activeEmbeddingSetId: 'embedding-set-1' },
      version: 1,
    });
  });

  it('clears malformed persisted JSON before hydration', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    window.localStorage.setItem(options.name, '{not-valid-json');

    expect(options.storage.getItem(options.name)).toBeNull();
    expect(window.localStorage.getItem(options.name)).toBeNull();
  });

  describe('removeCachedCollection', () => {
    const mockCollection1: CachedCollection = {
      category: null,
      chunkCount: 100,
      createdAt: '2024-01-01T00:00:00Z',
      description: null,
      dimensions: 1536,
      distance: 'cosine',
      embeddingCount: 100,
      fileCount: 5,
      id: 'col-1',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai:text-embedding-3-small',
      name: 'Test Collection 1',
      tags: null,
    };

    const mockCollection2: CachedCollection = {
      category: null,
      chunkCount: 200,
      createdAt: '2024-01-02T00:00:00Z',
      description: null,
      dimensions: 3072,
      distance: 'cosine',
      embeddingCount: 150,
      fileCount: 10,
      id: 'col-2',
      modelId: 'text-embedding-3-large',
      modelKey: 'openai:text-embedding-3-large',
      name: 'Test Collection 2',
      tags: null,
    };

    const mockCollection3: CachedCollection = {
      category: 'general',
      chunkCount: 50,
      createdAt: '2024-01-03T00:00:00Z',
      description: 'A test collection',
      dimensions: 1024,
      distance: 'l2',
      embeddingCount: 50,
      fileCount: 3,
      id: 'col-3',
      modelId: 'embed-english-v3.0',
      modelKey: 'cohere:embed-english-v3.0',
      name: 'Test Collection 3',
      tags: 'test,demo',
    };

    it('removes a collection by ID from the cache', () => {
      // Setup: Add collections to cache
      useVectorStatusUIStore.setState({
        cachedCollections: [mockCollection1, mockCollection2, mockCollection3],
      });

      // Verify initial state
      expect(useVectorStatusUIStore.getState().cachedCollections).toHaveLength(3);

      // Act: Remove collection 2
      useVectorStatusUIStore.getState().removeCachedCollection('col-2');

      // Assert: Collection 2 should be removed
      const remaining = useVectorStatusUIStore.getState().cachedCollections;
      expect(remaining).toHaveLength(2);
      expect(remaining.map((c) => c.id)).toEqual(['col-1', 'col-3']);
    });

    it('handles removing non-existent collection gracefully', () => {
      // Setup
      useVectorStatusUIStore.setState({
        cachedCollections: [mockCollection1],
      });

      // Act: Try to remove non-existent collection
      useVectorStatusUIStore.getState().removeCachedCollection('non-existent-id');

      // Assert: Original collection still present
      const collections = useVectorStatusUIStore.getState().cachedCollections;
      expect(collections).toHaveLength(1);
      expect(collections[0]?.id).toBe('col-1');
    });

    it('handles removing from empty cache gracefully', () => {
      // Setup: Empty cache
      useVectorStatusUIStore.setState({ cachedCollections: [] });

      // Act: Try to remove from empty cache
      useVectorStatusUIStore.getState().removeCachedCollection('any-id');

      // Assert: Still empty, no errors
      expect(useVectorStatusUIStore.getState().cachedCollections).toHaveLength(0);
    });

    it('uses current state (functional update) to avoid stale closures', () => {
      // Setup: Start with one collection
      useVectorStatusUIStore.setState({
        cachedCollections: [mockCollection1],
      });

      // Capture the remove function BEFORE we add more collections
      const removeFn = useVectorStatusUIStore.getState().removeCachedCollection;

      // Simulate another component adding collections (like what happens
      // when the live query fires while delete dialog is open)
      useVectorStatusUIStore.setState({
        cachedCollections: [mockCollection1, mockCollection2, mockCollection3],
      });

      // Verify all 3 are now in cache
      expect(useVectorStatusUIStore.getState().cachedCollections).toHaveLength(3);

      // Act: Use the captured (potentially "stale") function to remove col-1
      // If this used a closure over the old state, it would only remove from the
      // old state [mockCollection1] and potentially lose col-2 and col-3
      removeFn('col-1');

      // Assert: Should have col-2 and col-3 remaining (not empty or just col-1)
      const remaining = useVectorStatusUIStore.getState().cachedCollections;
      expect(remaining).toHaveLength(2);
      expect(remaining.map((c) => c.id)).toEqual(['col-2', 'col-3']);
    });

    it('removes only the targeted collection when multiple removals occur', () => {
      // Setup
      useVectorStatusUIStore.setState({
        cachedCollections: [mockCollection1, mockCollection2, mockCollection3],
      });

      // Act: Remove multiple collections
      useVectorStatusUIStore.getState().removeCachedCollection('col-1');
      useVectorStatusUIStore.getState().removeCachedCollection('col-3');

      // Assert: Only col-2 remains
      const remaining = useVectorStatusUIStore.getState().cachedCollections;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe('col-2');
    });
  });

  describe('setCachedCollections', () => {
    it('replaces the entire cache', () => {
      const mockCollection: CachedCollection = {
        category: null,
        chunkCount: 10,
        createdAt: '2024-01-01T00:00:00Z',
        description: null,
        dimensions: 768,
        distance: 'cosine',
        embeddingCount: 10,
        fileCount: 1,
        id: 'col-1',
        modelId: 'test',
        modelKey: 'test',
        name: 'Test',
        tags: null,
      };

      useVectorStatusUIStore.getState().setCachedCollections([mockCollection]);
      const cached = useVectorStatusUIStore.getState().cachedCollections;
      expect(cached).toHaveLength(1);
      expect(cached[0]?.id).toBe('col-1');

      // Replace with empty
      useVectorStatusUIStore.getState().setCachedCollections([]);
      expect(useVectorStatusUIStore.getState().cachedCollections).toHaveLength(0);
    });
  });

  describe('cached collection ordering', () => {
    it('sorts cached collection upserts by newest createdAt and then id', () => {
      const older: CachedCollection = {
        category: null,
        chunkCount: 10,
        createdAt: '2024-01-01T00:00:00Z',
        description: null,
        dimensions: 768,
        distance: 'cosine',
        embeddingCount: 10,
        fileCount: 1,
        id: 'a',
        modelId: 'test',
        modelKey: 'test',
        name: 'Older',
        tags: null,
      };
      const newerB: CachedCollection = {
        ...older,
        createdAt: '2024-01-02T00:00:00Z',
        id: 'b',
        name: 'Newer B',
      };
      const newerC: CachedCollection = {
        ...older,
        createdAt: '2024-01-02T00:00:00Z',
        id: 'c',
        name: 'Newer C',
      };

      expect(compareCollectionsDesc(newerB, newerC)).toBe(1);
      expect(compareCollectionsDesc(newerC, newerB)).toBe(-1);
      expect(compareCollectionsDesc(newerB, newerB)).toBe(0);

      const store = useVectorStatusUIStore.getState();
      store.upsertCachedCollection(older);
      store.upsertCachedCollection(newerB);
      store.upsertCachedCollection(newerC);
      store.upsertCachedCollection({ ...older, fileCount: 99 });

      expect(
        useVectorStatusUIStore.getState().cachedCollections.map((collection) => collection.id)
      ).toEqual(['c', 'b', 'a']);
      expect(useVectorStatusUIStore.getState().cachedCollections.at(-1)?.fileCount).toBe(99);
    });
  });

  describe('cached file data and schema status', () => {
    it('stores cached file data, schema verification, and exposes selectors', () => {
      const cachedFileData = {
        chunks: [
          {
            chunkIndex: 0,
            chunkSize: 12,
            chunkType: 'text' as const,
            contentHash: 'chunk-hash',
            createdAt: '2026-01-01T00:00:00.000Z',
            embeddingDimensions: 1536,
            embeddingHash: 'embedding-hash',
            embeddingSetId: 'set-1',
            embeddingUpdatedAt: '2026-01-01T00:00:00.000Z',
            fileRecordId: 'file-1',
            hasEmbedding: true,
            id: 'chunk-1',
            tokenCount: 12,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        collectionCounts: {
          chunks: 2,
          embeddings: 1,
          records: 1,
        },
        collectionId: 'collection-1',
        page: 1,
        pageSize: 25,
        records: [
          {
            chunkingStrategy: 'recursive',
            chunksCount: 2,
            chunksProcessedAt: '2026-01-01T00:00:00.000Z',
            contentHash: 'hash',
            createdAt: '2026-01-01T00:00:00.000Z',
            embeddedChunksCount: 1,
            embeddingSetId: 'set-1',
            hasEmbedding: true,
            id: 'file-1',
            name: 'file.md',
            path: '/workspace/file.md',
            processedAt: '2026-01-01T00:00:00.000Z',
            size: 128,
            tokenCount: 20,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        totalRecords: 1,
      };

      const store = useVectorStatusUIStore.getState();
      store.setCachedFileData(cachedFileData);
      store.setSchemaVerified(true);
      store.setIsImporting(true);

      const state = useVectorStatusUIStore.getState();
      expect(vectorStatusUISelectors.cachedFileData(state)).toBe(cachedFileData);
      expect(vectorStatusUISelectors.schemaVerified(state)).toBe(true);
      expect(vectorStatusUISelectors.isImporting(state)).toBe(true);
    });
  });

  describe('import and embedding flags', () => {
    it('correctly computes isEmbeddingActive from queue and job flags', () => {
      const store = useVectorStatusUIStore;

      // Initially both false
      expect(store.getState().isEmbeddingActive).toBe(false);

      // Set embedding queue active
      store.getState().setIsEmbeddingQueueActive(true);
      expect(store.getState().isEmbeddingActive).toBe(true);

      // Turn off queue, turn on job queue
      store.getState().setIsEmbeddingQueueActive(false);
      store.getState().setIsJobQueueActive(true);
      expect(store.getState().isEmbeddingActive).toBe(true);

      // Turn off both
      store.getState().setIsJobQueueActive(false);
      expect(store.getState().isEmbeddingActive).toBe(false);
    });
  });

  describe('activeBackfill', () => {
    it('stores and clears active backfill progress across remount-safe state updates', () => {
      const store = useVectorStatusUIStore;

      store.getState().setActiveBackfill({
        embeddingSetId: 'set-1',
        progress: { done: 12, total: 48 },
        requestId: 'backfill-1',
      });

      expect(store.getState().activeBackfill).toEqual({
        embeddingSetId: 'set-1',
        progress: { done: 12, total: 48 },
        requestId: 'backfill-1',
      });

      store.getState().setActiveBackfill(null);

      expect(store.getState().activeBackfill).toBeNull();
    });
  });

  describe('setDurableQueueStats', () => {
    it('preserves store identity when queue stats are unchanged', () => {
      const store = useVectorStatusUIStore;
      const initialStats = {
        failed: 0,
        nextRunnableAt: '2026-03-07T00:00:00.000Z',
        queued: 4,
        running: 1,
        succeeded: 9,
        succeededLifetime: 9,
      };

      store.getState().setDurableQueueStats(initialStats);
      const before = store.getState();

      store.getState().setDurableQueueStats({
        failed: 0,
        nextRunnableAt: '2026-03-07T00:00:00.000Z',
        queued: 4,
        running: 1,
        succeeded: 9,
        succeededLifetime: 9,
      });

      expect(store.getState()).toBe(before);
    });

    it('updates state when queue stats change or are cleared', () => {
      const store = useVectorStatusUIStore;

      store.getState().setDurableQueueStats({
        failed: 0,
        nextRunnableAt: null,
        queued: 1,
        running: 0,
        succeeded: 0,
        succeededLifetime: 0,
      });
      expect(vectorStatusUISelectors.durableQueueStats(store.getState())?.queued).toBe(1);

      store.getState().setDurableQueueStats({
        failed: 0,
        nextRunnableAt: null,
        queued: 2,
        running: 0,
        succeeded: 0,
        succeededLifetime: 0,
      });
      expect(vectorStatusUISelectors.durableQueueStats(store.getState())?.queued).toBe(2);

      store.getState().setDurableQueueStats(null);
      expect(vectorStatusUISelectors.durableQueueStats(store.getState())).toBeNull();
    });
  });

  describe('persistence storage', () => {
    it('uses the Electron storage bridge when available', async () => {
      const electronStorage = {
        getItem: vi.fn(async () => null),
        removeItem: vi.fn(async () => undefined),
        setItem: vi.fn(async () => undefined),
      };
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: { storage: electronStorage },
      });

      vi.resetModules();
      const module = await import('../stores/vector-status-ui-store');
      const persistApi = (
        module.useVectorStatusUIStore as typeof module.useVectorStatusUIStore & {
          persist?: {
            getOptions?: () => {
              name?: string;
              storage?: {
                getItem: (key: string) => unknown;
                removeItem: (key: string) => unknown;
                setItem: (key: string, value: unknown) => unknown;
              };
            };
          };
        }
      ).persist;
      const options = persistApi?.getOptions?.();
      if (!(options?.storage && options.name)) {
        throw new Error('persist storage unavailable for test');
      }

      await options.storage.setItem(options.name, { state: { activeEmbeddingSetId: 'set-1' } });
      await options.storage.getItem(options.name);
      await options.storage.removeItem(options.name);

      expect(electronStorage.setItem).toHaveBeenCalledWith(
        options.name,
        JSON.stringify({ state: { activeEmbeddingSetId: 'set-1' } })
      );
      expect(electronStorage.getItem).toHaveBeenCalledWith(options.name);
      expect(electronStorage.removeItem).toHaveBeenCalledWith(options.name);
    });
  });
});
