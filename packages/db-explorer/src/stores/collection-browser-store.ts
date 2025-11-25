import type {
  CollectionSortDirection,
  CollectionSortKey,
  CollectionSortState,
} from '@brainstrike/ui';
import { createSafeStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

// Re-export types for convenience
export type { CollectionSortDirection, CollectionSortKey, CollectionSortState };

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
  /** Filter state - search query */
  searchQuery: string;
  /** Filter state - enabled node types */
  nodeTypes: string[];
  /** Filter state - embedding status filter */
  embeddingStatus: string;
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
  /** Set search query */
  setSearchQuery: (query: string) => void;
  /** Set enabled node types */
  setNodeTypes: (types: string[]) => void;
  /** Toggle a node type */
  toggleNodeType: (type: string) => void;
  /** Set embedding status filter */
  setEmbeddingStatus: (status: string) => void;
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
  searchQuery: '',
  nodeTypes: ['collection', 'file', 'chunk', 'embedding'],
  embeddingStatus: 'all',
};

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 */
const storage = createJSONStorage(() => createSafeStorageAdapter());

/**
 * Helper to cycle through sort directions: null -> asc -> desc -> null
 */
function getNextSortDirection(
  current: CollectionSortDirection | null
): CollectionSortDirection | null {
  if (current === null) return 'asc';
  if (current === 'asc') return 'desc';
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
        searchQuery: s.searchQuery,
        nodeTypes: s.nodeTypes,
        embeddingStatus: s.embeddingStatus,
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
  searchQuery: (s: CollectionBrowserStore) => s.searchQuery,
  nodeTypes: (s: CollectionBrowserStore) => s.nodeTypes,
  embeddingStatus: (s: CollectionBrowserStore) => s.embeddingStatus,
  filters: (s: CollectionBrowserStore) => ({
    searchQuery: s.searchQuery,
    nodeTypes: s.nodeTypes,
    embeddingStatus: s.embeddingStatus,
  }),
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
