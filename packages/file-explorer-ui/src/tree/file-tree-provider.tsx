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
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from '../shell/file-explorer-provider';
import {
  type RestorationProgress,
  useExpandedPathRestoration,
  useExpandSelectedFileParentDirectories,
} from '../use-expanded-path-restoration';
import type { NormalizedFileTreeState } from '../utils/normalized-file-tree';
import { createEmptyNormalizedFileTreeState } from '../utils/normalized-file-tree';
import { FileTreeIndex, type FileTreeIndexStats, type HandleInfo } from './file-tree-index';
import { type CancellableFileTreeHook, useFileTree } from './use-file-tree-context';

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

/**
 * Forest index sharing (Phase 6): one FileTreeIndex serves every nested
 * FileTreeProvider so the panel-level content loader can resolve nodes from
 * ALL roots during a cross-root import. Folder entries are refcounted —
 * a folder's entries clear only when its LAST registrant releases it:
 * - single-root workspace switch (one provider re-keys) → old folder clears;
 * - forest focus switch (outer provider re-keys while the root's own
 *   RootSection provider stays mounted) → nothing clears;
 * - disconnecting a root (its section provider unmounts) → its folder clears.
 */
interface FileTreeIndexRegistry {
  readonly index: FileTreeIndex;
  register: (folderId: string, ownerId: string) => void;
  unregister: (folderId: string, ownerId: string) => void;
}

function createFileTreeIndexRegistry(): FileTreeIndexRegistry {
  const index = new FileTreeIndex();
  const registrants = new Map<string, Set<string>>();
  return {
    index,
    register(folderId, ownerId) {
      const owners = registrants.get(folderId) ?? new Set<string>();
      owners.add(ownerId);
      registrants.set(folderId, owners);
    },
    unregister(folderId, ownerId) {
      const owners = registrants.get(folderId);
      if (!owners) {
        return;
      }
      owners.delete(ownerId);
      if (owners.size === 0) {
        registrants.delete(folderId);
        index.clearFolder(folderId);
      }
    },
  };
}

const FileTreeIndexRegistryContext = createContext<FileTreeIndexRegistry | null>(null);

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
  /**
   * Durable RootId UUID for this root (storage v5).
   * When provided, nodes are stamped with the UUID as their `rootFolderId` and
   * the FileTreeIndex is keyed by this id — satisfying the linchpin equality in
   * use-shared-file-content-loading. Falls back to `handle.path` when absent.
   */
  rootId?: string;
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
  rootId,
}: FileTreeProviderProps): React.ReactElement {
  const store = useFileExplorerStoreContext();
  const setExpandedPaths = useFileExplorerStoreSelector((state) => state.setExpandedPaths);
  const selectionVersion = useFileExplorerStoreSelector((state) => state.selectionVersion);
  // Forest sharing (Phase 6): inherit the registry (and its index) from an
  // ancestor FileTreeProvider when nested (RootSections under the app-shell
  // provider); otherwise own a fresh one. Lazy useState keeps the owned
  // instance stable across renders.
  const inheritedRegistry = useContext(FileTreeIndexRegistryContext);
  const [ownedRegistry] = useState<FileTreeIndexRegistry>(
    () => inheritedRegistry ?? createFileTreeIndexRegistry()
  );
  const registry = inheritedRegistry ?? ownedRegistry;
  const index = registry.index;
  const registrantId = useId();

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

  // Storage v5: key the index by rootId (UUID) when available; fall back to path.
  // This ensures the FileTreeIndex and composite keys always carry the same identity
  // as IFileNode.rootFolderId (both resolved via the same getRootFolderId lookup).
  const currentRootPath = rootDirectoryHandle?.path ?? null;
  const currentRootIndexKey = rootId ?? currentRootPath;

  // Refcounted folder registration replaces clear-on-identity-change: the
  // effect cleanup releases the OLD key (clearing its entries only when this
  // provider was the last registrant — see FileTreeIndexRegistry), so a
  // forest focus switch never wipes a sibling root's entries while a
  // single-root workspace switch still clears the departed folder.
  // biome-ignore lint/plugin: intentional — index mutation must run after commit, not during render
  useEffect(() => {
    if (!currentRootIndexKey) {
      return;
    }
    registry.register(currentRootIndexKey, registrantId);
    bumpIndexVersion();
    const releasedKey = currentRootIndexKey;
    return () => {
      registry.unregister(releasedKey, registrantId);
      bumpIndexVersion();
    };
  }, [currentRootIndexKey, registry, registrantId, bumpIndexVersion]);

  // Callback to add nodes to the index - passed to useFileTree
  const onNodesIndexed = useCallback(
    (nodes: IFileNode[], parentPath: string | null) => {
      index.addNodes(nodes, parentPath);
      bumpIndexVersion();
    },
    [index, bumpIndexVersion]
  );

  // Build options object conditionally to satisfy exactOptionalPropertyTypes.
  // The lazy tree hook (use-file-tree-context → useLazyFileTree) reads `rootId`
  // and stamps it onto every node as `rootFolderId`.
  const options = useMemo(() => {
    const base: {
      onNodesIndexed: typeof onNodesIndexed;
      filterTreeFn?: typeof filterTreeFn;
      rootId?: string;
    } = { onNodesIndexed };
    if (filterTreeFn) {
      base.filterTreeFn = filterTreeFn;
    }
    if (rootId !== undefined) {
      base.rootId = rootId;
    }
    return base;
  }, [onNodesIndexed, filterTreeFn, rootId]);

  const fileTreeState = useFileTree(rootDirectoryHandle, options);
  // Storage v5: restoration uses rootId (UUID) when available so
  // persisted expandedDirectoryPaths/folderStates look up by the correct key.
  const restorationFolderId = rootId ?? currentRootPath;
  const restorationKey = restorationFolderId ?? 'none';
  const restorationState = useExpandedPathRestoration({
    currentRootFolderId: restorationFolderId,
    currentRootPath,
    fileTree: fileTreeState.fileTree,
    isTreeLoading: fileTreeState.isLoading,
    loadSpecificPaths: fileTreeState.loadSpecificPaths,
    restorationKey,
    setExpandedPaths,
    store,
  });
  useExpandSelectedFileParentDirectories({
    currentRootFolderId: restorationFolderId,
    isRestorationSettled: restorationState.isRestorationSettled,
    loadSpecificPaths: fileTreeState.loadSpecificPaths,
    selectionVersion,
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
      getHandle,
      getNode,
      stats: index.stats,
      version: indexVersion,
    }),
    [getNode, getHandle, index, indexVersion]
  );

  // Same stability pattern as indexContextValue / normalizedContextValue:
  // avoid a fresh object identity every render so consumers don't thrash.
  // Depend on individual fields — useFileTree / useExpandedPathRestoration
  // return a new object literal each render, so object-identity deps would
  // defeat the memo.
  const fileTreeContextValue = useMemo<FileTreeContextType>(
    () => ({
      ...fileTreeState,
      ...restorationState,
      rootDirectoryHandle,
    }),
    [
      fileTreeState.__internalGetDescendantFileCount,
      fileTreeState.__internalGetDescendantFilePaths,
      fileTreeState.__internalMaterializeSubtree,
      fileTreeState.__internalNormalizedTreeRef,
      fileTreeState.__internalNormalizedTreeVersion,
      fileTreeState.cancelChildLoading,
      fileTreeState.cancelExpandAll,
      fileTreeState.cancellable,
      fileTreeState.cancelOperation,
      fileTreeState.cancelRecursiveSelect,
      fileTreeState.cancelSelectAll,
      fileTreeState.error,
      fileTreeState.expandAllProgress,
      fileTreeState.expandAllProgressively,
      fileTreeState.fileTree,
      fileTreeState.isCancelling,
      fileTreeState.isExpandingAll,
      fileTreeState.isLoading,
      fileTreeState.isLoadingForSelectAll,
      fileTreeState.isLoadingForSelection,
      fileTreeState.loadChildren,
      fileTreeState.loadingPathForSelection,
      fileTreeState.loadingPaths,
      fileTreeState.loadingProgress?.isInitialLoading,
      fileTreeState.loadingProgress?.loadingCount,
      fileTreeState.loadSpecificPaths,
      fileTreeState.refreshDirectory,
      fileTreeState.refreshTree,
      fileTreeState.selectAllRecursively,
      fileTreeState.selectFolderRecursively,
      fileTreeState.workerPortRef,
      restorationState.isRestorationSettled,
      restorationState.isRestoringExpandedPaths,
      restorationState.restorationProgress,
      rootDirectoryHandle,
    ]
  );

  return (
    <FileTreeContext.Provider value={fileTreeContextValue}>
      <FileTreeNormalizedContext.Provider value={normalizedContextValue}>
        <FileTreeIndexContext.Provider value={indexContextValue}>
          <FileTreeIndexRegistryContext.Provider value={registry}>
            {children}
          </FileTreeIndexRegistryContext.Provider>
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
