import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetVectorStatusUIStoreForTests,
  type CachedCollection,
  useVectorStatusUIStore,
} from '../stores/vector-status-ui-store';

/**
 * Test suite for vector-status-ui-store
 *
 * Particularly important for testing removeCachedCollection
 * which uses functional state updates to avoid stale closure bugs.
 */
describe('vector-status-ui-store', () => {
  beforeEach(() => {
    __resetVectorStatusUIStoreForTests();
  });

  describe('removeCachedCollection', () => {
    const mockCollection1: CachedCollection = {
      id: 'col-1',
      modelKey: 'openai:text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      distance: 'cosine',
      createdAt: '2024-01-01T00:00:00Z',
      name: 'Test Collection 1',
      description: null,
      tags: null,
      category: null,
      fileCount: 5,
      chunkCount: 100,
      embeddingCount: 100,
    };

    const mockCollection2: CachedCollection = {
      id: 'col-2',
      modelKey: 'openai:text-embedding-3-large',
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
      distance: 'cosine',
      createdAt: '2024-01-02T00:00:00Z',
      name: 'Test Collection 2',
      description: null,
      tags: null,
      category: null,
      fileCount: 10,
      chunkCount: 200,
      embeddingCount: 150,
    };

    const mockCollection3: CachedCollection = {
      id: 'col-3',
      modelKey: 'cohere:embed-english-v3.0',
      modelId: 'embed-english-v3.0',
      dimensions: 1024,
      distance: 'l2',
      createdAt: '2024-01-03T00:00:00Z',
      name: 'Test Collection 3',
      description: 'A test collection',
      tags: 'test,demo',
      category: 'general',
      fileCount: 3,
      chunkCount: 50,
      embeddingCount: 50,
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
        id: 'col-1',
        modelKey: 'test',
        modelId: 'test',
        dimensions: 768,
        distance: 'cosine',
        createdAt: '2024-01-01T00:00:00Z',
        name: 'Test',
        description: null,
        tags: null,
        category: null,
        fileCount: 1,
        chunkCount: 10,
        embeddingCount: 10,
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
        requestId: 'backfill-1',
        progress: { done: 12, total: 48 },
      });

      expect(store.getState().activeBackfill).toEqual({
        embeddingSetId: 'set-1',
        requestId: 'backfill-1',
        progress: { done: 12, total: 48 },
      });

      store.getState().setActiveBackfill(null);

      expect(store.getState().activeBackfill).toBeNull();
    });
  });

  describe('setDurableQueueStats', () => {
    it('preserves store identity when queue stats are unchanged', () => {
      const store = useVectorStatusUIStore;
      const initialStats = {
        queued: 4,
        running: 1,
        failed: 0,
        succeeded: 9,
        nextRunnableAt: '2026-03-07T00:00:00.000Z',
      };

      store.getState().setDurableQueueStats(initialStats);
      const before = store.getState();

      store.getState().setDurableQueueStats({
        queued: 4,
        running: 1,
        failed: 0,
        succeeded: 9,
        nextRunnableAt: '2026-03-07T00:00:00.000Z',
      });

      expect(store.getState()).toBe(before);
    });
  });
});
