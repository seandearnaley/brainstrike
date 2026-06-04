import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetCollectionBrowserStoreForTests,
  collectionBrowserSelectors,
  useCollectionBrowserStore,
} from '../collection-browser-store';

describe('CollectionBrowserStore', () => {
  beforeEach(() => {
    __resetCollectionBrowserStoreForTests();
  });

  // ---------------------------------------------------------------------------
  // Default state
  // ---------------------------------------------------------------------------
  describe('default state', () => {
    it('starts with default values', () => {
      const state = useCollectionBrowserStore.getState();
      expect(state.expandedIds).toEqual([]);
      expect(state.selectedId).toBeNull();
      expect(state.sortState).toBeNull();
      expect(state.isInspectorCollapsed).toBe(false);
      expect(state.inspectorWidth).toBe(25);
      expect(state.searchQuery).toBe('');
      expect(state.nodeTypes).toEqual(['collection', 'file', 'chunk', 'embedding']);
      expect(state.embeddingStatus).toBe('all');
      expect(state.searchMode).toBe('semantic');
      expect(state.semanticQuery).toBe('');
      expect(state.searchConfigThreshold).toBe(0.5);
      expect(state.searchConfigLimit).toBe(20);
      expect(state.searchConfigDistanceMetric).toBe('cosine');
      expect(state.searchConfigRetrievalMode).toBe('vector');
      expect(state.searchConfigVectorWeight).toBe(1.0);
      expect(state.searchConfigFtsWeight).toBe(1.0);
      expect(state.groupBy).toBe('none');
      expect(state.showCheckbox).toBe(false);
      expect(state.multiSelectEnabled).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Expansion actions
  // ---------------------------------------------------------------------------
  describe('expansion actions', () => {
    it('setExpandedIds replaces expanded IDs', () => {
      useCollectionBrowserStore.getState().setExpandedIds(['a', 'b']);
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['a', 'b']);
    });

    it('toggleExpanded adds an ID when not present', () => {
      useCollectionBrowserStore.getState().toggleExpanded('a');
      expect(useCollectionBrowserStore.getState().expandedIds).toContain('a');
    });

    it('toggleExpanded removes an ID when already present', () => {
      useCollectionBrowserStore.getState().setExpandedIds(['a', 'b']);
      useCollectionBrowserStore.getState().toggleExpanded('a');
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['b']);
    });

    it('expandIds merges new IDs without duplicates', () => {
      useCollectionBrowserStore.getState().setExpandedIds(['a']);
      useCollectionBrowserStore.getState().expandIds(['a', 'b', 'c']);
      const ids = useCollectionBrowserStore.getState().expandedIds;
      expect(ids).toHaveLength(3);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toContain('c');
    });

    it('collapseAll clears all expanded IDs', () => {
      useCollectionBrowserStore.getState().setExpandedIds(['a', 'b', 'c']);
      useCollectionBrowserStore.getState().collapseAll();
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual([]);
    });

    it('removeExpandedIds removes specified IDs', () => {
      useCollectionBrowserStore.getState().setExpandedIds(['a', 'b', 'c']);
      useCollectionBrowserStore.getState().removeExpandedIds(['a', 'c']);
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['b']);
    });

    it('removeExpandedIds is a no-op when empty set provided', () => {
      useCollectionBrowserStore.getState().setExpandedIds(['a', 'b']);
      useCollectionBrowserStore.getState().removeExpandedIds([]);
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['a', 'b']);
    });

    it('removeExpandedIds is a no-op when expandedIds is empty', () => {
      useCollectionBrowserStore.getState().removeExpandedIds(['a']);
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual([]);
    });

    it('removeExpandedIds is a no-op when no IDs match', () => {
      useCollectionBrowserStore.getState().setExpandedIds(['a', 'b']);
      useCollectionBrowserStore.getState().removeExpandedIds(['x', 'y']);
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['a', 'b']);
    });
  });

  // ---------------------------------------------------------------------------
  // Selection actions
  // ---------------------------------------------------------------------------
  describe('selection actions', () => {
    it('setSelectedId updates the selected ID', () => {
      useCollectionBrowserStore.getState().setSelectedId('node-1');
      expect(useCollectionBrowserStore.getState().selectedId).toBe('node-1');
    });

    it('setSelectedId can clear selection with null', () => {
      useCollectionBrowserStore.getState().setSelectedId('node-1');
      useCollectionBrowserStore.getState().setSelectedId(null);
      expect(useCollectionBrowserStore.getState().selectedId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Sort actions
  // ---------------------------------------------------------------------------
  describe('sort actions', () => {
    it('setSortState sets the sort state', () => {
      useCollectionBrowserStore.getState().setSortState({ key: 'name', direction: 'asc' });
      expect(useCollectionBrowserStore.getState().sortState).toEqual({
        key: 'name',
        direction: 'asc',
      });
    });

    it('setSortState can clear sort with null', () => {
      useCollectionBrowserStore.getState().setSortState({ key: 'name', direction: 'asc' });
      useCollectionBrowserStore.getState().setSortState(null);
      expect(useCollectionBrowserStore.getState().sortState).toBeNull();
    });

    it('toggleSort cycles null -> asc -> desc -> null', () => {
      // null -> asc
      useCollectionBrowserStore.getState().toggleSort('name');
      expect(useCollectionBrowserStore.getState().sortState).toEqual({
        key: 'name',
        direction: 'asc',
      });

      // asc -> desc
      useCollectionBrowserStore.getState().toggleSort('name');
      expect(useCollectionBrowserStore.getState().sortState).toEqual({
        key: 'name',
        direction: 'desc',
      });

      // desc -> null
      useCollectionBrowserStore.getState().toggleSort('name');
      expect(useCollectionBrowserStore.getState().sortState).toBeNull();
    });

    it('toggleSort resets when a different key is toggled', () => {
      useCollectionBrowserStore.getState().toggleSort('name');
      expect(useCollectionBrowserStore.getState().sortState).toEqual({
        key: 'name',
        direction: 'asc',
      });

      // Toggling a different key starts from null -> asc
      useCollectionBrowserStore.getState().toggleSort('size');
      expect(useCollectionBrowserStore.getState().sortState).toEqual({
        key: 'size',
        direction: 'asc',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Inspector actions
  // ---------------------------------------------------------------------------
  describe('inspector actions', () => {
    it('setInspectorCollapsed updates collapsed state', () => {
      useCollectionBrowserStore.getState().setInspectorCollapsed(true);
      expect(useCollectionBrowserStore.getState().isInspectorCollapsed).toBe(true);
    });

    it('setInspectorWidth updates width', () => {
      useCollectionBrowserStore.getState().setInspectorWidth(50);
      expect(useCollectionBrowserStore.getState().inspectorWidth).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // Filter actions
  // ---------------------------------------------------------------------------
  describe('filter actions', () => {
    it('setSearchQuery updates the query', () => {
      useCollectionBrowserStore.getState().setSearchQuery('test');
      expect(useCollectionBrowserStore.getState().searchQuery).toBe('test');
    });

    it('setNodeTypes replaces node types', () => {
      useCollectionBrowserStore.getState().setNodeTypes(['file']);
      expect(useCollectionBrowserStore.getState().nodeTypes).toEqual(['file']);
    });

    it('toggleNodeType adds a type when not present', () => {
      useCollectionBrowserStore.getState().setNodeTypes(['file']);
      useCollectionBrowserStore.getState().toggleNodeType('chunk');
      const types = useCollectionBrowserStore.getState().nodeTypes;
      expect(types).toContain('file');
      expect(types).toContain('chunk');
    });

    it('toggleNodeType removes a type when already present', () => {
      useCollectionBrowserStore.getState().setNodeTypes(['file', 'chunk']);
      useCollectionBrowserStore.getState().toggleNodeType('file');
      expect(useCollectionBrowserStore.getState().nodeTypes).toEqual(['chunk']);
    });

    it('setEmbeddingStatus updates the filter', () => {
      useCollectionBrowserStore.getState().setEmbeddingStatus('embedded');
      expect(useCollectionBrowserStore.getState().embeddingStatus).toBe('embedded');
    });
  });

  // ---------------------------------------------------------------------------
  // Semantic search actions
  // ---------------------------------------------------------------------------
  describe('semantic search actions', () => {
    it('setSearchMode updates mode', () => {
      useCollectionBrowserStore.getState().setSearchMode('quick');
      expect(useCollectionBrowserStore.getState().searchMode).toBe('quick');
    });

    it('setSemanticQuery updates the query', () => {
      useCollectionBrowserStore.getState().setSemanticQuery('find similar');
      expect(useCollectionBrowserStore.getState().semanticQuery).toBe('find similar');
    });

    it('setSearchConfigThreshold updates threshold', () => {
      useCollectionBrowserStore.getState().setSearchConfigThreshold(0.8);
      expect(useCollectionBrowserStore.getState().searchConfigThreshold).toBe(0.8);
    });

    it('setSearchConfigLimit updates limit', () => {
      useCollectionBrowserStore.getState().setSearchConfigLimit(50);
      expect(useCollectionBrowserStore.getState().searchConfigLimit).toBe(50);
    });

    it('setSearchConfigDistanceMetric updates metric', () => {
      useCollectionBrowserStore.getState().setSearchConfigDistanceMetric('l2');
      expect(useCollectionBrowserStore.getState().searchConfigDistanceMetric).toBe('l2');
    });

    it('setSearchConfigRetrievalMode updates mode', () => {
      useCollectionBrowserStore.getState().setSearchConfigRetrievalMode('hybrid');
      expect(useCollectionBrowserStore.getState().searchConfigRetrievalMode).toBe('hybrid');
    });

    it('setSearchConfigVectorWeight updates weight', () => {
      useCollectionBrowserStore.getState().setSearchConfigVectorWeight(0.7);
      expect(useCollectionBrowserStore.getState().searchConfigVectorWeight).toBe(0.7);
    });

    it('setSearchConfigFtsWeight updates weight', () => {
      useCollectionBrowserStore.getState().setSearchConfigFtsWeight(1.5);
      expect(useCollectionBrowserStore.getState().searchConfigFtsWeight).toBe(1.5);
    });
  });

  // ---------------------------------------------------------------------------
  // Grouping and selection display actions
  // ---------------------------------------------------------------------------
  describe('grouping and selection display actions', () => {
    it('setGroupBy updates grouping', () => {
      useCollectionBrowserStore.getState().setGroupBy('type');
      expect(useCollectionBrowserStore.getState().groupBy).toBe('type');
    });

    it('setShowCheckbox updates checkbox visibility', () => {
      useCollectionBrowserStore.getState().setShowCheckbox(true);
      expect(useCollectionBrowserStore.getState().showCheckbox).toBe(true);
    });

    it('setMultiSelectEnabled updates multi-select mode', () => {
      useCollectionBrowserStore.getState().setMultiSelectEnabled(true);
      expect(useCollectionBrowserStore.getState().multiSelectEnabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------
  describe('reset', () => {
    it('reset restores all state to defaults', () => {
      const store = useCollectionBrowserStore.getState();
      store.setExpandedIds(['a']);
      store.setSelectedId('b');
      store.setSortState({ key: 'name', direction: 'asc' });
      store.setInspectorCollapsed(true);
      store.setSearchQuery('query');
      store.setSearchMode('quick');
      store.setGroupBy('type');

      useCollectionBrowserStore.getState().reset();

      const resetState = useCollectionBrowserStore.getState();
      expect(resetState.expandedIds).toEqual([]);
      expect(resetState.selectedId).toBeNull();
      expect(resetState.sortState).toBeNull();
      expect(resetState.isInspectorCollapsed).toBe(false);
      expect(resetState.searchQuery).toBe('');
      expect(resetState.searchMode).toBe('semantic');
      expect(resetState.groupBy).toBe('none');
    });
  });

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------
  describe('selectors', () => {
    it('filters selector returns combined filter state', () => {
      const store = useCollectionBrowserStore.getState();
      store.setSearchQuery('hello');
      store.setNodeTypes(['file']);
      store.setEmbeddingStatus('embedded');

      const state = useCollectionBrowserStore.getState();
      const filters = collectionBrowserSelectors.filters(state);
      expect(filters).toEqual({
        searchQuery: 'hello',
        nodeTypes: ['file'],
        embeddingStatus: 'embedded',
      });
    });

    it('searchConfig selector returns combined search config', () => {
      const store = useCollectionBrowserStore.getState();
      store.setSearchConfigThreshold(0.9);
      store.setSearchConfigLimit(100);
      store.setSearchConfigDistanceMetric('l2');
      store.setSearchConfigRetrievalMode('hybrid');
      store.setSearchConfigVectorWeight(0.5);
      store.setSearchConfigFtsWeight(1.5);

      const state = useCollectionBrowserStore.getState();
      const config = collectionBrowserSelectors.searchConfig(state);
      expect(config).toEqual({
        threshold: 0.9,
        resultLimit: 100,
        distanceMetric: 'l2',
        retrievalMode: 'hybrid',
        vectorWeight: 0.5,
        ftsWeight: 1.5,
      });
    });

    it('individual selectors return correct values', () => {
      const store = useCollectionBrowserStore.getState();
      store.setExpandedIds(['x']);
      store.setSelectedId('y');
      store.setGroupBy('type');
      store.setShowCheckbox(true);

      const state = useCollectionBrowserStore.getState();
      expect(collectionBrowserSelectors.expandedIds(state)).toEqual(['x']);
      expect(collectionBrowserSelectors.selectedId(state)).toBe('y');
      expect(collectionBrowserSelectors.groupBy(state)).toBe('type');
      expect(collectionBrowserSelectors.showCheckbox(state)).toBe(true);
    });
  });
});
