import { createSafeJsonStorageAdapter } from '@brainstrike/storage';
import type {
  CollectionSortDirection,
  CollectionSortKey,
  CollectionSortState,
  DistanceMetric,
  GroupByKey,
  SearchMode,
} from '@brainstrike/ui';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

// Re-export types for convenience
export type { CollectionSortDirection, CollectionSortKey, CollectionSortState, SearchMode };

/**
 * Persisted data for the CollectionBrowserView
 */
interface CollectionBrowserData {
  /** Filter state - embedding status filter */
  embeddingStatus: string;
  /** Expanded node IDs in the tree */
  expandedIds: string[];
  /** Grouping key for the tree (default: 'none') */
  groupBy: GroupByKey;
  /** Width of the inspector panel as a percentage (0-100) */
  inspectorWidth: number;
  /** Whether the inspector panel is collapsed */
  isInspectorCollapsed: boolean;
  /** Whether multi-select mode is enabled */
  multiSelectEnabled: boolean;
  /** Filter state - enabled node types */
  nodeTypes: string[];
  /** Semantic search distance metric */
  searchConfigDistanceMetric: DistanceMetric;
  /** Hybrid search FTS weight (0-2) */
  searchConfigFtsWeight: number;
  /** Semantic search result limit */
  searchConfigLimit: number;
  /** Hybrid search retrieval mode (vector-only or hybrid) */
  searchConfigRetrievalMode: 'vector' | 'hybrid';
  /** Semantic search similarity threshold */
  searchConfigThreshold: number;
  /** Hybrid search vector weight (0-2) */
  searchConfigVectorWeight: number;
  // Semantic search state (persisted)
  /** Current search mode (quick filter or semantic search) */
  searchMode: SearchMode;
  /** Whether the hybrid search panel is expanded */
  searchPanelExpanded: boolean;
  /** Filter state - search query (quick filter mode) */
  searchQuery: string;
  /** Currently selected node ID */
  selectedId: string | null;
  /** Semantic search query text */
  semanticQuery: string;
  /** Whether to show checkboxes for multi-select */
  showCheckbox: boolean;
  /** Hierarchical sort state for the tree (null = unsorted) */
  sortState: CollectionSortState | null;
}

/**
 * Actions for the CollectionBrowserView store
 */
interface CollectionBrowserActions {
  /** Collapse all nodes */
  collapseAll: () => void;
  /** Expand all provided IDs */
  expandIds: (ids: string[]) => void;
  /** Remove specific IDs from the expanded set */
  removeExpandedIds: (ids: Iterable<string>) => void;
  /** Reset all state to defaults */
  reset: () => void;
  /** Set embedding status filter */
  setEmbeddingStatus: (status: string) => void;
  /** Set expanded node IDs */
  setExpandedIds: (ids: string[]) => void;
  /** Set grouping key */
  setGroupBy: (groupBy: GroupByKey) => void;
  /** Set inspector collapsed state */
  setInspectorCollapsed: (collapsed: boolean) => void;
  /** Set the width of the inspector panel */
  setInspectorWidth: (width: number) => void;
  /** Set multi-select mode */
  setMultiSelectEnabled: (enabled: boolean) => void;
  /** Set enabled node types */
  setNodeTypes: (types: string[]) => void;
  /** Set semantic search distance metric */
  setSearchConfigDistanceMetric: (metric: DistanceMetric) => void;
  /** Set hybrid search FTS weight */
  setSearchConfigFtsWeight: (weight: number) => void;
  /** Set semantic search result limit */
  setSearchConfigLimit: (limit: number) => void;
  /** Set hybrid search retrieval mode */
  setSearchConfigRetrievalMode: (mode: 'vector' | 'hybrid') => void;
  /** Set semantic search threshold */
  setSearchConfigThreshold: (threshold: number) => void;
  /** Set hybrid search vector weight */
  setSearchConfigVectorWeight: (weight: number) => void;
  // Semantic search actions
  /** Set the search mode (quick or semantic) */
  setSearchMode: (mode: SearchMode) => void;
  /** Set hybrid search panel expanded state */
  setSearchPanelExpanded: (expanded: boolean) => void;
  /** Set search query (quick filter mode) */
  setSearchQuery: (query: string) => void;
  /** Set the selected node ID */
  setSelectedId: (id: string | null) => void;
  /** Set the semantic search query */
  setSemanticQuery: (query: string) => void;
  /** Set checkbox visibility */
  setShowCheckbox: (show: boolean) => void;
  /** Set the sort state */
  setSortState: (state: CollectionSortState | null) => void;
  /** Toggle a single node's expansion */
  toggleExpanded: (id: string) => void;
  /** Toggle a node type */
  toggleNodeType: (type: string) => void;
  /** Toggle sort for a key (cycles: null -> asc -> desc -> null) */
  toggleSort: (key: CollectionSortKey) => void;
}

export type CollectionBrowserStore = CollectionBrowserData & CollectionBrowserActions;

// Keep the existing key stable so persisted snapshots can migrate in place.
const STORE_NAME = 'collection-browser.v1' as const;
const STORE_VERSION = 3 as const;
type PersistedCollectionBrowserData = Partial<CollectionBrowserData>;

/**
 * Default values for the store
 */
const DEFAULT_STATE: CollectionBrowserData = {
  embeddingStatus: 'all',
  expandedIds: [],
  groupBy: 'none',
  inspectorWidth: 25,
  isInspectorCollapsed: false,
  multiSelectEnabled: false,
  nodeTypes: ['collection', 'file', 'chunk', 'embedding'],
  searchConfigDistanceMetric: 'cosine',
  searchConfigFtsWeight: 1.0,
  searchConfigLimit: 20,
  // Hybrid search defaults
  searchConfigRetrievalMode: 'vector',
  searchConfigThreshold: 0.5,
  searchConfigVectorWeight: 1.0,
  // Semantic search defaults
  searchMode: 'semantic',
  searchPanelExpanded: false,
  searchQuery: '',
  selectedId: null,
  semanticQuery: '',
  showCheckbox: false,
  sortState: null,
};

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

function migratePersistedState(
  persistedState: unknown,
  version: number
): PersistedCollectionBrowserData | undefined {
  const snapshot =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as PersistedCollectionBrowserData)
      : undefined;
  if (!snapshot) {
    return snapshot;
  }

  // Chain future version migrations here (v3->v4, etc.) to preserve upgrade paths.
  if (version < 3) {
    const { contextSelectedIds: _contextSelectedIds, ...rest } =
      snapshot as PersistedCollectionBrowserData & { contextSelectedIds?: unknown };
    return rest;
  }

  return snapshot;
}

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

      collapseAll: () => set({ expandedIds: [] }),

      expandIds: (ids) => {
        const { expandedIds } = get();
        const idSet = new Set([...expandedIds, ...ids]);
        set({ expandedIds: Array.from(idSet) });
      },
      removeExpandedIds: (ids) => {
        const idsToRemove = new Set(ids);
        if (idsToRemove.size === 0) {
          return;
        }

        const { expandedIds } = get();
        if (expandedIds.length === 0) {
          return;
        }

        const nextExpandedIds = expandedIds.filter((id) => !idsToRemove.has(id));
        if (nextExpandedIds.length !== expandedIds.length) {
          set({ expandedIds: nextExpandedIds });
        }
      },

      // Reset action
      reset: () => set(DEFAULT_STATE),

      setEmbeddingStatus: (status) => set({ embeddingStatus: status }),

      // Expansion actions
      setExpandedIds: (ids) => set({ expandedIds: ids }),

      setGroupBy: (groupBy) => set({ groupBy }),

      // Inspector actions
      setInspectorCollapsed: (collapsed) => set({ isInspectorCollapsed: collapsed }),
      setInspectorWidth: (width) => set({ inspectorWidth: width }),

      setMultiSelectEnabled: (enabled) => set({ multiSelectEnabled: enabled }),

      setNodeTypes: (types) => set({ nodeTypes: types }),

      setSearchConfigDistanceMetric: (metric) => set({ searchConfigDistanceMetric: metric }),

      setSearchConfigFtsWeight: (weight) => set({ searchConfigFtsWeight: weight }),

      setSearchConfigLimit: (limit) => set({ searchConfigLimit: limit }),

      setSearchConfigRetrievalMode: (mode) => set({ searchConfigRetrievalMode: mode }),

      setSearchConfigThreshold: (threshold) => set({ searchConfigThreshold: threshold }),

      setSearchConfigVectorWeight: (weight) => set({ searchConfigVectorWeight: weight }),

      // Semantic search actions
      setSearchMode: (mode) => set({ searchMode: mode }),

      setSearchPanelExpanded: (expanded) => set({ searchPanelExpanded: expanded }),

      // Filter actions
      setSearchQuery: (query) => set({ searchQuery: query }),

      // Selection actions
      setSelectedId: (id) => set({ selectedId: id }),

      setSemanticQuery: (query) => set({ semanticQuery: query }),

      setShowCheckbox: (show) => set({ showCheckbox: show }),

      // Sort actions
      setSortState: (state) => set({ sortState: state }),

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

      toggleSort: (key) => {
        const { sortState } = get();
        const currentDirection = sortState?.key === key ? sortState.direction : null;
        const nextDirection = getNextSortDirection(currentDirection);

        if (nextDirection === null) {
          set({ sortState: null });
        } else {
          set({ sortState: { direction: nextDirection, key } });
        }
      },
    }),
    {
      migrate: migratePersistedState,
      name: STORE_NAME,
      partialize: (s) => ({
        embeddingStatus: s.embeddingStatus,
        expandedIds: s.expandedIds,
        // Persist grouping preference, but keep multi-select UI mode session-scoped.
        groupBy: s.groupBy,
        inspectorWidth: s.inspectorWidth,
        isInspectorCollapsed: s.isInspectorCollapsed,
        nodeTypes: s.nodeTypes,
        searchConfigDistanceMetric: s.searchConfigDistanceMetric,
        searchConfigFtsWeight: s.searchConfigFtsWeight,
        searchConfigLimit: s.searchConfigLimit,
        // Hybrid search state
        searchConfigRetrievalMode: s.searchConfigRetrievalMode,
        searchConfigThreshold: s.searchConfigThreshold,
        searchConfigVectorWeight: s.searchConfigVectorWeight,
        // Semantic search state
        searchMode: s.searchMode,
        searchPanelExpanded: s.searchPanelExpanded,
        searchQuery: s.searchQuery,
        selectedId: s.selectedId,
        semanticQuery: s.semanticQuery,
        sortState: s.sortState,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

/**
 * Selectors for optimized component subscriptions
 */
export const collectionBrowserSelectors = {
  embeddingStatus: (s: CollectionBrowserStore) => s.embeddingStatus,
  expandedIds: (s: CollectionBrowserStore) => s.expandedIds,
  filters: (s: CollectionBrowserStore) => ({
    embeddingStatus: s.embeddingStatus,
    nodeTypes: s.nodeTypes,
    searchQuery: s.searchQuery,
  }),
  groupBy: (s: CollectionBrowserStore) => s.groupBy,
  inspectorWidth: (s: CollectionBrowserStore) => s.inspectorWidth,
  isInspectorCollapsed: (s: CollectionBrowserStore) => s.isInspectorCollapsed,
  multiSelectEnabled: (s: CollectionBrowserStore) => s.multiSelectEnabled,
  nodeTypes: (s: CollectionBrowserStore) => s.nodeTypes,
  searchConfig: (s: CollectionBrowserStore) => ({
    distanceMetric: s.searchConfigDistanceMetric,
    ftsWeight: s.searchConfigFtsWeight,
    resultLimit: s.searchConfigLimit,
    retrievalMode: s.searchConfigRetrievalMode,
    threshold: s.searchConfigThreshold,
    vectorWeight: s.searchConfigVectorWeight,
  }),
  // Semantic search selectors
  searchMode: (s: CollectionBrowserStore) => s.searchMode,
  searchPanelExpanded: (s: CollectionBrowserStore) => s.searchPanelExpanded,
  searchQuery: (s: CollectionBrowserStore) => s.searchQuery,
  selectedId: (s: CollectionBrowserStore) => s.selectedId,
  semanticQuery: (s: CollectionBrowserStore) => s.semanticQuery,
  showCheckbox: (s: CollectionBrowserStore) => s.showCheckbox,
  sortState: (s: CollectionBrowserStore) => s.sortState,
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
