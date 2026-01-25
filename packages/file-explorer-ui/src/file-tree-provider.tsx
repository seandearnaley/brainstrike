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
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from 'react';
import { FileTreeIndex, type FileTreeIndexStats, type HandleInfo } from './file-tree-index';
import { type CancellableFileTreeHook, useFileTree } from './use-file-tree-context';

type FileTreeContextType = CancellableFileTreeHook & {
  rootDirectoryHandle: DirectoryHandle | null;
};

const FileTreeContext = createContext<FileTreeContextType | null>(null);

/**
 * Context value for FileTreeIndex.
 * Provides O(1) lookups for nodes and handles by folder ID and path.
 */
export interface FileTreeIndexContextValue {
  /** Get a node by folder ID and path - O(1) lookup */
  getNode: (folderId: string, path: string) => IFileNode | undefined;
  /** Get handle info by folder ID and path - O(1) lookup */
  getHandle: (folderId: string, path: string) => HandleInfo | undefined;
  /** Current index statistics */
  stats: FileTreeIndexStats;
}

const FileTreeIndexContext = createContext<FileTreeIndexContextValue | null>(null);

export interface FileTreeProviderProps {
  children: ReactNode;
  rootDirectoryHandle: DirectoryHandle | null;
  /**
   * Filter function to apply workspace include/exclude filters to a tree.
   * Called in the slow path when directories are loaded from the worker,
   * ensuring workspace filters are respected before file selection.
   */
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
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
  // Create a single FileTreeIndex instance that persists across renders
  const indexRef = useRef<FileTreeIndex | null>(null);
  if (indexRef.current === null) {
    indexRef.current = new FileTreeIndex();
  }
  const index = indexRef.current;

  // Track the last root handle path to detect root changes
  // Clear index synchronously during render when root changes
  // This avoids the effect-for-state-sync anti-pattern that Biome flags
  const lastRootPathRef = useRef<string | null>(null);
  const currentRootPath = rootDirectoryHandle?.path ?? null;
  if (lastRootPathRef.current !== currentRootPath) {
    index.clear();
    lastRootPathRef.current = currentRootPath;
  }

  // Callback to add nodes to the index - passed to useFileTree
  const onNodesIndexed = useCallback(
    (nodes: IFileNode[], parentPath: string | null) => {
      index.addNodes(nodes, parentPath);
    },
    [index]
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

  // Create stable context value with bound methods
  // We use useMemo but include a version counter to trigger updates when index changes
  // For now, since lookups are synchronous and always return current data, we can use stable references
  const indexContextValue = useMemo<FileTreeIndexContextValue>(
    () => ({
      getNode: (folderId: string, path: string) => index.getNode(folderId, path),
      getHandle: (folderId: string, path: string) => index.getHandle(folderId, path),
      get stats() {
        return index.stats;
      },
    }),
    [index]
  );

  return (
    <FileTreeContext.Provider value={{ ...fileTreeState, rootDirectoryHandle }}>
      <FileTreeIndexContext.Provider value={indexContextValue}>
        {children}
      </FileTreeIndexContext.Provider>
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
