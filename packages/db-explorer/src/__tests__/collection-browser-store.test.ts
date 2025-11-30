import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCollectionBrowserStoreForTests,
  useCollectionBrowserStore,
} from '../stores/collection-browser-store';

type PersistApi<T> = T & {
  persist?: {
    getOptions?: () => {
      name: string;
      storage: {
        getItem: (name: string) => string | null;
        setItem: (name: string, value: string) => void;
        removeItem: (name: string) => void;
      };
    };
    clearStorage?: () => void;
  };
};

const storeWithPersist = useCollectionBrowserStore as PersistApi<typeof useCollectionBrowserStore>;

describe('collection-browser-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetCollectionBrowserStoreForTests();
  });

  describe('expansion state', () => {
    it('initializes with empty expanded IDs', () => {
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual([]);
    });

    it('sets expanded IDs', () => {
      useCollectionBrowserStore.getState().setExpandedIds(['node-1', 'node-2']);
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['node-1', 'node-2']);
    });

    it('toggles expansion state for a node', () => {
      const store = useCollectionBrowserStore.getState();

      // Toggle on
      store.toggleExpanded('node-1');
      expect(useCollectionBrowserStore.getState().expandedIds).toContain('node-1');

      // Toggle off
      store.toggleExpanded('node-1');
      expect(useCollectionBrowserStore.getState().expandedIds).not.toContain('node-1');
    });

    it('expands multiple IDs at once', () => {
      const store = useCollectionBrowserStore.getState();
      store.setExpandedIds(['existing']);
      store.expandIds(['new-1', 'new-2']);

      const expanded = useCollectionBrowserStore.getState().expandedIds;
      expect(expanded).toContain('existing');
      expect(expanded).toContain('new-1');
      expect(expanded).toContain('new-2');
    });

    it('collapses all nodes', () => {
      const store = useCollectionBrowserStore.getState();
      store.setExpandedIds(['node-1', 'node-2', 'node-3']);
      expect(useCollectionBrowserStore.getState().expandedIds.length).toBe(3);

      store.collapseAll();
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual([]);
    });

    it('deduplicates expanded IDs', () => {
      const store = useCollectionBrowserStore.getState();
      store.setExpandedIds(['node-1']);
      store.expandIds(['node-1', 'node-2']);

      const expanded = useCollectionBrowserStore.getState().expandedIds;
      expect(expanded.filter((id) => id === 'node-1').length).toBe(1);
    });
  });

  describe('selection state', () => {
    it('initializes with null selected ID', () => {
      expect(useCollectionBrowserStore.getState().selectedId).toBeNull();
    });

    it('sets selected ID', () => {
      useCollectionBrowserStore.getState().setSelectedId('file-123');
      expect(useCollectionBrowserStore.getState().selectedId).toBe('file-123');
    });

    it('clears selection with null', () => {
      const store = useCollectionBrowserStore.getState();
      store.setSelectedId('file-123');
      store.setSelectedId(null);
      expect(useCollectionBrowserStore.getState().selectedId).toBeNull();
    });
  });

  describe('sort state', () => {
    it('initializes with null sort state', () => {
      const { sortState } = useCollectionBrowserStore.getState();
      expect(sortState).toBeNull();
    });

    it('sets sort state directly', () => {
      useCollectionBrowserStore.getState().setSortState({
        key: 'name',
        direction: 'asc',
      });
      const { sortState } = useCollectionBrowserStore.getState();
      expect(sortState?.key).toBe('name');
      expect(sortState?.direction).toBe('asc');
    });

    it('toggles sort through asc -> desc -> null cycle', () => {
      const store = useCollectionBrowserStore.getState();

      // First toggle: null -> asc
      store.toggleSort('name');
      let { sortState } = useCollectionBrowserStore.getState();
      expect(sortState?.key).toBe('name');
      expect(sortState?.direction).toBe('asc');

      // Second toggle: asc -> desc
      store.toggleSort('name');
      sortState = useCollectionBrowserStore.getState().sortState;
      expect(sortState?.key).toBe('name');
      expect(sortState?.direction).toBe('desc');

      // Third toggle: desc -> null
      store.toggleSort('name');
      sortState = useCollectionBrowserStore.getState().sortState;
      expect(sortState).toBeNull();
    });

    it('resets sort when switching keys', () => {
      const store = useCollectionBrowserStore.getState();

      // Sort by name descending
      store.setSortState({ key: 'name', direction: 'desc' });

      // Toggle a different key - should start at asc
      store.toggleSort('size');
      const { sortState } = useCollectionBrowserStore.getState();
      expect(sortState?.key).toBe('size');
      expect(sortState?.direction).toBe('asc');
    });
  });

  describe('inspector state', () => {
    it('initializes with inspector expanded', () => {
      expect(useCollectionBrowserStore.getState().isInspectorCollapsed).toBe(false);
    });

    it('sets inspector collapsed state', () => {
      useCollectionBrowserStore.getState().setInspectorCollapsed(true);
      expect(useCollectionBrowserStore.getState().isInspectorCollapsed).toBe(true);

      useCollectionBrowserStore.getState().setInspectorCollapsed(false);
      expect(useCollectionBrowserStore.getState().isInspectorCollapsed).toBe(false);
    });
  });

  describe('filter state', () => {
    it('initializes with default filter values', () => {
      const state = useCollectionBrowserStore.getState();
      expect(state.searchQuery).toBe('');
      expect(state.nodeTypes).toEqual(['collection', 'file', 'chunk', 'embedding']);
      expect(state.embeddingStatus).toBe('all');
    });

    it('sets search query', () => {
      useCollectionBrowserStore.getState().setSearchQuery('test query');
      expect(useCollectionBrowserStore.getState().searchQuery).toBe('test query');
    });

    it('sets node types', () => {
      useCollectionBrowserStore.getState().setNodeTypes(['file', 'chunk']);
      expect(useCollectionBrowserStore.getState().nodeTypes).toEqual(['file', 'chunk']);
    });

    it('toggles node type', () => {
      const store = useCollectionBrowserStore.getState();

      // Remove a type
      store.toggleNodeType('embedding');
      let nodeTypes = useCollectionBrowserStore.getState().nodeTypes;
      expect(nodeTypes).not.toContain('embedding');

      // Add it back
      store.toggleNodeType('embedding');
      nodeTypes = useCollectionBrowserStore.getState().nodeTypes;
      expect(nodeTypes).toContain('embedding');
    });

    it('sets embedding status', () => {
      useCollectionBrowserStore.getState().setEmbeddingStatus('complete');
      expect(useCollectionBrowserStore.getState().embeddingStatus).toBe('complete');
    });
  });

  describe('reset', () => {
    it('resets all state to defaults', () => {
      const store = useCollectionBrowserStore.getState();

      // Modify all state
      store.setExpandedIds(['node-1', 'node-2']);
      store.setSelectedId('file-123');
      store.setSortState({ key: 'name', direction: 'asc' });
      store.setInspectorCollapsed(true);
      store.setSearchQuery('test');
      store.setNodeTypes(['file']);
      store.setEmbeddingStatus('complete');

      // Reset
      store.reset();

      // Verify defaults
      const state = useCollectionBrowserStore.getState();
      expect(state.expandedIds).toEqual([]);
      expect(state.selectedId).toBeNull();
      expect(state.sortState).toBeNull();
      expect(state.isInspectorCollapsed).toBe(false);
      expect(state.searchQuery).toBe('');
      expect(state.nodeTypes).toEqual(['collection', 'file', 'chunk', 'embedding']);
      expect(state.embeddingStatus).toBe('all');
    });
  });

  describe('persistence', () => {
    it('has persist API defined', () => {
      expect(storeWithPersist.persist).toBeDefined();
    });

    it('persists through fallback storage when localStorage fails', () => {
      const persistApi = storeWithPersist.persist;
      expect(persistApi).toBeDefined();
      const options = persistApi?.getOptions?.();
      expect(options?.storage).toBeDefined();
      if (!(persistApi && options?.storage && options.name)) {
        throw new Error('persist storage unavailable for test');
      }

      const storage = options.storage;
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
        throw new Error('blocked');
      });

      const store = useCollectionBrowserStore.getState();
      store.setExpandedIds(['node-1']);
      store.setSortState({ key: 'name', direction: 'desc' });

      const persistedValue = storage.getItem(options.name);
      expect(persistedValue).not.toBeNull();

      if (
        !persistedValue ||
        typeof (persistedValue as { state?: unknown }) !== 'object' ||
        Array.isArray(persistedValue)
      ) {
        throw new Error('unexpected persisted snapshot');
      }

      const snapshot = persistedValue as {
        state?: {
          expandedIds: string[];
          sortState: { key: string; direction: string };
        };
      };

      expect(snapshot.state?.expandedIds).toContain('node-1');
      expect(snapshot.state?.sortState.key).toBe('name');
      expect(snapshot.state?.sortState.direction).toBe('desc');

      persistApi.clearStorage?.();
      const afterClear = storage.getItem(options.name);
      expect(afterClear).toBeNull();
    });
  });

  describe('selectors', () => {
    it('provides selector functions', async () => {
      const { collectionBrowserSelectors } = await import('../stores/collection-browser-store');

      const store = useCollectionBrowserStore.getState();
      store.setExpandedIds(['a', 'b']);
      store.setSelectedId('test-id');
      store.setSortState({ key: 'size', direction: 'asc' });
      store.setSearchQuery('search');

      const state = useCollectionBrowserStore.getState();
      expect(collectionBrowserSelectors.expandedIds(state)).toEqual(['a', 'b']);
      expect(collectionBrowserSelectors.selectedId(state)).toBe('test-id');
      expect(collectionBrowserSelectors.sortState(state)).toEqual({
        key: 'size',
        direction: 'asc',
      });
      expect(collectionBrowserSelectors.searchQuery(state)).toBe('search');
      expect(collectionBrowserSelectors.filters(state)).toEqual({
        searchQuery: 'search',
        nodeTypes: ['collection', 'file', 'chunk', 'embedding'],
        embeddingStatus: 'all',
      });
    });
  });
});
