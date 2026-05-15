/**
 * File Tree Provider
 *
 * Provides a single source of truth for the file tree state across all components.
 * This ensures that when expand-all completes, all consumers see the updated tree.
 *
 * Also provides a shared FileTreeIndex for O(1) node and handle lookups,
 * eliminating duplicate O(N) tree traversals across features.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { FileTreeIndex, type FileTreeIndexStats, type HandleInfo } from './file-tree-index';
import {
  type RestorationProgress,
  useExpandedPathRestoration,
} from './use-expanded-path-restoration';
import { type CancellableFileTreeHook, useFileTree } from './use-file-tree-context';
import type { NormalizedFileTreeState } from './utils/normalized-file-tree';
import { createEmptyNormalizedFileTreeState } from './utils/normalized-file-tree';

type FileTreeContextType = CancellableFileTreeHook & {
  isRestorationSettled: boolean;
  isRestoringExpandedPaths: boolean;
  restorationProgress: RestorationProgress | null;
  rootDirectoryHandle: DirectoryHandle | null;
};

const FileTreeContext = createContext<FileTreeContextType | null>(null);

/**
 * Context value for FileTreeIndex.
 * Provides O(1) lookups for nodes and handles by folder ID and path.
 */
export interface FileTreeIndexContextValue {
  /** Get handle info by folder ID and path - O(1) lookup */
  getHandle: (folderId: string, path: string) => HandleInfo | undefined;
  /** Get a node by folder ID and path - O(1) lookup */
  getNode: (folderId: string, path: string) => IFileNode | undefined;
  /** Current index statistics */
  stats: FileTreeIndexStats;
  /**
   * Increments when the index is mutated (coalesced via microtask).
   * Consumers can use this as a dependency to retry lookups when the index fills.
   */
  version: number;
}

const FileTreeIndexContext = createContext<FileTreeIndexContextValue | null>(null);

export interface FileTreeNormalizedContextValue {
  getDescendantFileCount: (path: string) => number;
  getDescendantFilePaths: (path: string, maxCount?: number) => string[];
  materializeSubtree: (path: string) => IFileNode | undefined;
  normalizedTreeRef: React.RefObject<NormalizedFileTreeState>;
  version: number;
}

const FileTreeNormalizedContext = createContext<FileTreeNormalizedContextValue | null>(null);

export interface FileTreeProviderProps {
  children: ReactNode;
  /**
   * Filter function to apply workspace include/exclude filters to a tree.
   * Called in the slow path when directories are loaded from the worker,
   * ensuring workspace filters are respected before file selection.
   */
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
  rootDirectoryHandle: DirectoryHandle | null;
}

/**
 * Provider component that creates a single file tree state.
 * All child components can access the shared tree via useFileTreeContext.
 *
 * Also provides a shared FileTreeIndex for O(1) lookups via useFileTreeIndexContext.
 *
 * @param props.filterTreeFn - Optional filter function for workspace filters.
 *   When provided, this is used in the slow path of selectAllRecursively
 *   to ensure workspace include/exclude filters are applied to loaded directories.
 */
export function FileTreeProvider({
  children,
  rootDirectoryHandle,
  filterTreeFn,
}: FileTreeProviderProps): React.ReactElement {
  const store = useFileExplorerStoreContext();
  const setExpandedPaths = useFileExplorerStoreSelector((state) => state.setExpandedPaths);
  const selectionVersion = useFileExplorerStoreSelector((state) => state.selectionVersion);
  // Create a single FileTreeIndex instance that persists across renders
  // Using useState with lazy initializer avoids reading ref during render
  const [index] = useState<FileTreeIndex>(() => new FileTreeIndex());

  // Version counter to signal index mutations to consumers
  // Coalesced via microtask to avoid excessive re-renders during multi-step updates
  const [indexVersion, setIndexVersion] = useState(0);
  const bumpScheduledRef = useRef(false);
  const bumpIndexVersion = useCallback(() => {
    if (bumpScheduledRef.current) {
      return;
    }
    bumpScheduledRef.current = true;
    queueMicrotask(() => {
      bumpScheduledRef.current = false;
      setIndexVersion((v: number) => v + 1);
    });
  }, []);

  // Track the last root handle path to detect root changes
  const lastRootPathRef = useRef<string | null>(null);
  const currentRootPath = rootDirectoryHandle?.path ?? null;

  // Clear index when root changes using useEffect to avoid render-phase mutations
  // which are unsafe in React's Concurrent Mode (render can be called multiple times)
  // biome-ignore lint/plugin: This is intentional - index.clear() is a mutation that must run after commit, not during render
  useEffect(() => {
    if (lastRootPathRef.current !== currentRootPath) {
      index.clear();
      lastRootPathRef.current = currentRootPath;
      bumpIndexVersion();
    }
  }, [currentRootPath, index, bumpIndexVersion]);

  // Callback to add nodes to the index - passed to useFileTree
  const onNodesIndexed = useCallback(
    (nodes: IFileNode[], parentPath: string | null) => {
      index.addNodes(nodes, parentPath);
      bumpIndexVersion();
    },
    [index, bumpIndexVersion]
  );

  // Build options object conditionally to satisfy exactOptionalPropertyTypes
  const options = useMemo(() => {
    const base: { onNodesIndexed: typeof onNodesIndexed; filterTreeFn?: typeof filterTreeFn } = {
      onNodesIndexed,
    };
    if (filterTreeFn) {
      base.filterTreeFn = filterTreeFn;
    }
    return base;
  }, [onNodesIndexed, filterTreeFn]);

  const fileTreeState = useFileTree(rootDirectoryHandle, options);
  const restorationState = useExpandedPathRestoration({
    currentRootFolderId: rootDirectoryHandle?.path ?? null,
    fileTree: fileTreeState.fileTree,
    isTreeLoading: fileTreeState.isLoading,
    loadSpecificPaths: fileTreeState.loadSpecificPaths,
    restorationKey: `selection:${selectionVersion}`,
    setExpandedPaths,
    store,
  });
  const fallbackNormalizedTreeRef = useRef<NormalizedFileTreeState>(
    createEmptyNormalizedFileTreeState()
  );

  const normalizedContextValue = useMemo<FileTreeNormalizedContextValue>(
    () => ({
      getDescendantFileCount: fileTreeState.__internalGetDescendantFileCount ?? (() => 0),
      getDescendantFilePaths: fileTreeState.__internalGetDescendantFilePaths ?? (() => []),
      materializeSubtree: fileTreeState.__internalMaterializeSubtree ?? (() => undefined),
      normalizedTreeRef: fileTreeState.__internalNormalizedTreeRef ?? fallbackNormalizedTreeRef,
      version: fileTreeState.__internalNormalizedTreeVersion ?? 0,
    }),
    [
      fileTreeState.__internalGetDescendantFileCount,
      fileTreeState.__internalGetDescendantFilePaths,
      fileTreeState.__internalMaterializeSubtree,
      fileTreeState.__internalNormalizedTreeRef,
      fileTreeState.__internalNormalizedTreeVersion,
    ]
  );

  // Stable lookup functions - identity never changes since index instance is stable
  // This prevents downstream effects from re-running when only version changes
  const getNode = useCallback(
    (folderId: string, path: string) => index.getNode(folderId, path),
    [index]
  );
  const getHandle = useCallback(
    (folderId: string, path: string) => index.getHandle(folderId, path),
    [index]
  );

  // Create context value with stable function references
  // Version changes trigger re-renders, but getNode/getHandle identities remain stable
  const indexContextValue = useMemo<FileTreeIndexContextValue>(
    () => ({
      getNode,
      getHandle,
      stats: index.stats,
      version: indexVersion,
    }),
    [getNode, getHandle, index, indexVersion]
  );

  return (
    <FileTreeContext.Provider
      value={{ ...fileTreeState, ...restorationState, rootDirectoryHandle }}
    >
      <FileTreeNormalizedContext.Provider value={normalizedContextValue}>
        <FileTreeIndexContext.Provider value={indexContextValue}>
          {children}
        </FileTreeIndexContext.Provider>
      </FileTreeNormalizedContext.Provider>
    </FileTreeContext.Provider>
  );
}

/**
 * Hook to access the shared file tree state.
 * Must be used within a FileTreeProvider.
 */
export function useFileTreeContext(): FileTreeContextType {
  const context = useContext(FileTreeContext);
  if (!context) {
    throw new Error('useFileTreeContext must be used within a FileTreeProvider');
  }
  return context;
}

/**
 * Check if we're within a FileTreeProvider.
 * Useful for components that can work with or without the provider.
 */
export function useOptionalFileTreeContext(): FileTreeContextType | null {
  return useContext(FileTreeContext);
}

/**
 * Hook to access the shared FileTreeIndex for O(1) node and handle lookups.
 * Must be used within a FileTreeProvider.
 *
 * @example
 * ```typescript
 * const { getNode, getHandle, stats } = useFileTreeIndexContext();
 *
 * // O(1) node lookup
 * const node = getNode(folderId, 'src/components/Button.tsx');
 *
 * // O(1) handle lookup
 * const handleInfo = getHandle(folderId, 'src/components/Button.tsx');
 *
 * // Access current stats
 * console.log(`Indexed ${stats.totalFiles} files`);
 * ```
 */
export function useFileTreeIndexContext(): FileTreeIndexContextValue {
  const context = useContext(FileTreeIndexContext);
  if (!context) {
    throw new Error('useFileTreeIndexContext must be used within a FileTreeProvider');
  }
  return context;
}

/**
 * Check if we're within a FileTreeProvider with index access.
 * Useful for components that can work with or without the provider.
 */
export function useOptionalFileTreeIndexContext(): FileTreeIndexContextValue | null {
  return useContext(FileTreeIndexContext);
}

export function useOptionalFileTreeNormalizedContext(): FileTreeNormalizedContextValue | null {
  return useContext(FileTreeNormalizedContext);
}
