import type {
  CollectionSortDirection,
  CollectionSortKey,
  CollectionSortState,
  DistanceMetric,
  GroupByKey,
  SearchMode,
} from '@brainstrike/ui';
import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
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
  /** Whether the search config panel is expanded */
  searchConfigExpanded: boolean;
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
  /** Set search config panel expanded state */
  setSearchConfigExpanded: (expanded: boolean) => void;
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
  searchPanelExpanded: false,
  groupBy: 'none',
  showCheckbox: false,
  multiSelectEnabled: false,
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

      // Expansion actions
      setExpandedIds: (ids) => set({ expandedIds: ids }),
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

      setSearchPanelExpanded: (expanded) => set({ searchPanelExpanded: expanded }),

      setGroupBy: (groupBy) => set({ groupBy }),

      setShowCheckbox: (show) => set({ showCheckbox: show }),

      setMultiSelectEnabled: (enabled) => set({ multiSelectEnabled: enabled }),

      // Reset action
      reset: () => set(DEFAULT_STATE),
    }),
    {
      name: STORE_NAME,
      version: STORE_VERSION,
      storage,
      migrate: migratePersistedState,
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
        searchPanelExpanded: s.searchPanelExpanded,
        // Persist grouping preference, but keep multi-select UI mode session-scoped.
        groupBy: s.groupBy,
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
  searchPanelExpanded: (s: CollectionBrowserStore) => s.searchPanelExpanded,
  groupBy: (s: CollectionBrowserStore) => s.groupBy,
  showCheckbox: (s: CollectionBrowserStore) => s.showCheckbox,
  multiSelectEnabled: (s: CollectionBrowserStore) => s.multiSelectEnabled,
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
