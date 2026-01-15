import type {
  CollectionSortDirection,
  CollectionSortKey,
  CollectionSortState,
  DistanceMetric,
  SearchMode,
} from '@brainstrike/ui';
import { createSafeJsonStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

// Re-export types for convenience
export type { CollectionSortDirection, CollectionSortKey, CollectionSortState, SearchMode };

/**
 * Persisted data for the CollectionBrowserView
 */
interface CollectionBrowserData {
  /** Expanded node IDs in the tree */
  expandedIds: string[];
  /** Currently selected node ID */
  selectedId: string | null;
  /** Hierarchical sort state for the tree (null = unsorted) */
  sortState: CollectionSortState | null;
  /** Whether the inspector panel is collapsed */
  isInspectorCollapsed: boolean;
  /** Width of the inspector panel as a percentage (0-100) */
  inspectorWidth: number;
  /** Filter state - search query (quick filter mode) */
  searchQuery: string;
  /** Filter state - enabled node types */
  nodeTypes: string[];
  /** Filter state - embedding status filter */
  embeddingStatus: string;
  // Semantic search state (persisted)
  /** Current search mode (quick filter or semantic search) */
  searchMode: SearchMode;
  /** Semantic search query text */
  semanticQuery: string;
  /** Semantic search similarity threshold */
  searchConfigThreshold: number;
  /** Semantic search result limit */
  searchConfigLimit: number;
  /** Semantic search distance metric */
  searchConfigDistanceMetric: DistanceMetric;
  /** Hybrid search retrieval mode (vector-only or hybrid) */
  searchConfigRetrievalMode: 'vector' | 'hybrid';
  /** Hybrid search vector weight (0-2) */
  searchConfigVectorWeight: number;
  /** Hybrid search FTS weight (0-2) */
  searchConfigFtsWeight: number;
  /** Whether the search config panel is expanded */
  searchConfigExpanded: boolean;
  /** Whether the filter bar is visible */
  isFilterVisible: boolean;
}

/**
 * Actions for the CollectionBrowserView store
 */
interface CollectionBrowserActions {
  /** Set expanded node IDs */
  setExpandedIds: (ids: string[]) => void;
  /** Toggle a single node's expansion */
  toggleExpanded: (id: string) => void;
  /** Expand all provided IDs */
  expandIds: (ids: string[]) => void;
  /** Collapse all nodes */
  collapseAll: () => void;
  /** Set the selected node ID */
  setSelectedId: (id: string | null) => void;
  /** Set the sort state */
  setSortState: (state: CollectionSortState | null) => void;
  /** Toggle sort for a key (cycles: null -> asc -> desc -> null) */
  toggleSort: (key: CollectionSortKey) => void;
  /** Set inspector collapsed state */
  setInspectorCollapsed: (collapsed: boolean) => void;
  /** Set the width of the inspector panel */
  setInspectorWidth: (width: number) => void;
  /** Set search query (quick filter mode) */
  setSearchQuery: (query: string) => void;
  /** Set enabled node types */
  setNodeTypes: (types: string[]) => void;
  /** Toggle a node type */
  toggleNodeType: (type: string) => void;
  /** Set embedding status filter */
  setEmbeddingStatus: (status: string) => void;
  // Semantic search actions
  /** Set the search mode (quick or semantic) */
  setSearchMode: (mode: SearchMode) => void;
  /** Set the semantic search query */
  setSemanticQuery: (query: string) => void;
  /** Set semantic search threshold */
  setSearchConfigThreshold: (threshold: number) => void;
  /** Set semantic search result limit */
  setSearchConfigLimit: (limit: number) => void;
  /** Set semantic search distance metric */
  setSearchConfigDistanceMetric: (metric: DistanceMetric) => void;
  /** Set hybrid search retrieval mode */
  setSearchConfigRetrievalMode: (mode: 'vector' | 'hybrid') => void;
  /** Set hybrid search vector weight */
  setSearchConfigVectorWeight: (weight: number) => void;
  /** Set hybrid search FTS weight */
  setSearchConfigFtsWeight: (weight: number) => void;
  /** Set search config panel expanded state */
  setSearchConfigExpanded: (expanded: boolean) => void;
  /** Set filter bar visibility */
  setIsFilterVisible: (visible: boolean) => void;
  /** Reset all state to defaults */
  reset: () => void;
}

export type CollectionBrowserStore = CollectionBrowserData & CollectionBrowserActions;

const STORE_NAME = 'collection-browser.v1' as const;

/**
 * Default values for the store
 */
const DEFAULT_STATE: CollectionBrowserData = {
  expandedIds: [],
  selectedId: null,
  sortState: null,
  isInspectorCollapsed: false,
  inspectorWidth: 25,
  searchQuery: '',
  nodeTypes: ['collection', 'file', 'chunk', 'embedding'],
  embeddingStatus: 'all',
  // Semantic search defaults
  searchMode: 'semantic',
  semanticQuery: '',
  searchConfigThreshold: 0.5,
  searchConfigLimit: 20,
  searchConfigDistanceMetric: 'cosine',
  // Hybrid search defaults
  searchConfigRetrievalMode: 'vector',
  searchConfigVectorWeight: 1.0,
  searchConfigFtsWeight: 1.0,
  searchConfigExpanded: false,
  isFilterVisible: false,
};

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

/**
 * Helper to cycle through sort directions: null -> asc -> desc -> null
 */
function getNextSortDirection(
  current: CollectionSortDirection | null
): CollectionSortDirection | null {
  if (current === null) {
    return 'asc';
  }
  if (current === 'asc') {
    return 'desc';
  }
  return null;
}

export const useCollectionBrowserStore = create<CollectionBrowserStore>()(
  persist(
    (set, get) => ({
      // Initial state
      ...DEFAULT_STATE,

      // Expansion actions
      setExpandedIds: (ids) => set({ expandedIds: ids }),

      toggleExpanded: (id) => {
        const { expandedIds } = get();
        const idSet = new Set(expandedIds);
        if (idSet.has(id)) {
          idSet.delete(id);
        } else {
          idSet.add(id);
        }
        set({ expandedIds: Array.from(idSet) });
      },

      expandIds: (ids) => {
        const { expandedIds } = get();
        const idSet = new Set([...expandedIds, ...ids]);
        set({ expandedIds: Array.from(idSet) });
      },

      collapseAll: () => set({ expandedIds: [] }),

      // Selection actions
      setSelectedId: (id) => set({ selectedId: id }),

      // Sort actions
      setSortState: (state) => set({ sortState: state }),

      toggleSort: (key) => {
        const { sortState } = get();
        const currentDirection = sortState?.key === key ? sortState.direction : null;
        const nextDirection = getNextSortDirection(currentDirection);

        if (nextDirection === null) {
          set({ sortState: null });
        } else {
          set({ sortState: { key, direction: nextDirection } });
        }
      },

      // Inspector actions
      setInspectorCollapsed: (collapsed) => set({ isInspectorCollapsed: collapsed }),
      setInspectorWidth: (width) => set({ inspectorWidth: width }),

      // Filter actions
      setSearchQuery: (query) => set({ searchQuery: query }),

      setNodeTypes: (types) => set({ nodeTypes: types }),

      toggleNodeType: (type) => {
        const { nodeTypes } = get();
        const typeSet = new Set(nodeTypes);
        if (typeSet.has(type)) {
          typeSet.delete(type);
        } else {
          typeSet.add(type);
        }
        set({ nodeTypes: Array.from(typeSet) });
      },

      setEmbeddingStatus: (status) => set({ embeddingStatus: status }),

      // Semantic search actions
      setSearchMode: (mode) => set({ searchMode: mode }),

      setSemanticQuery: (query) => set({ semanticQuery: query }),

      setSearchConfigThreshold: (threshold) => set({ searchConfigThreshold: threshold }),

      setSearchConfigLimit: (limit) => set({ searchConfigLimit: limit }),

      setSearchConfigDistanceMetric: (metric) => set({ searchConfigDistanceMetric: metric }),

      setSearchConfigRetrievalMode: (mode) => set({ searchConfigRetrievalMode: mode }),

      setSearchConfigVectorWeight: (weight) => set({ searchConfigVectorWeight: weight }),

      setSearchConfigFtsWeight: (weight) => set({ searchConfigFtsWeight: weight }),

      setSearchConfigExpanded: (expanded) => set({ searchConfigExpanded: expanded }),

      setIsFilterVisible: (visible) => set({ isFilterVisible: visible }),

      // Reset action
      reset: () => set(DEFAULT_STATE),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({
        expandedIds: s.expandedIds,
        selectedId: s.selectedId,
        sortState: s.sortState,
        isInspectorCollapsed: s.isInspectorCollapsed,
        inspectorWidth: s.inspectorWidth,
        searchQuery: s.searchQuery,
        nodeTypes: s.nodeTypes,
        embeddingStatus: s.embeddingStatus,
        // Semantic search state
        searchMode: s.searchMode,
        semanticQuery: s.semanticQuery,
        searchConfigThreshold: s.searchConfigThreshold,
        searchConfigLimit: s.searchConfigLimit,
        searchConfigDistanceMetric: s.searchConfigDistanceMetric,
        // Hybrid search state
        searchConfigRetrievalMode: s.searchConfigRetrievalMode,
        searchConfigVectorWeight: s.searchConfigVectorWeight,
        searchConfigFtsWeight: s.searchConfigFtsWeight,
        searchConfigExpanded: s.searchConfigExpanded,
        isFilterVisible: s.isFilterVisible,
      }),
    }
  )
);

/**
 * Selectors for optimized component subscriptions
 */
export const collectionBrowserSelectors = {
  expandedIds: (s: CollectionBrowserStore) => s.expandedIds,
  selectedId: (s: CollectionBrowserStore) => s.selectedId,
  sortState: (s: CollectionBrowserStore) => s.sortState,
  isInspectorCollapsed: (s: CollectionBrowserStore) => s.isInspectorCollapsed,
  inspectorWidth: (s: CollectionBrowserStore) => s.inspectorWidth,
  searchQuery: (s: CollectionBrowserStore) => s.searchQuery,
  nodeTypes: (s: CollectionBrowserStore) => s.nodeTypes,
  embeddingStatus: (s: CollectionBrowserStore) => s.embeddingStatus,
  filters: (s: CollectionBrowserStore) => ({
    searchQuery: s.searchQuery,
    nodeTypes: s.nodeTypes,
    embeddingStatus: s.embeddingStatus,
  }),
  // Semantic search selectors
  searchMode: (s: CollectionBrowserStore) => s.searchMode,
  semanticQuery: (s: CollectionBrowserStore) => s.semanticQuery,
  searchConfig: (s: CollectionBrowserStore) => ({
    threshold: s.searchConfigThreshold,
    resultLimit: s.searchConfigLimit,
    distanceMetric: s.searchConfigDistanceMetric,
    retrievalMode: s.searchConfigRetrievalMode,
    vectorWeight: s.searchConfigVectorWeight,
    ftsWeight: s.searchConfigFtsWeight,
  }),
  searchConfigExpanded: (s: CollectionBrowserStore) => s.searchConfigExpanded,
  isFilterVisible: (s: CollectionBrowserStore) => s.isFilterVisible,
};

/**
 * Test helper to reset persistent state between tests
 */
export function __resetCollectionBrowserStoreForTests(): void {
  try {
    useCollectionBrowserStore.setState(DEFAULT_STATE);
    const persistApi = (
      useCollectionBrowserStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset
    // This prevents test failures when localStorage is unavailable
  }
}
