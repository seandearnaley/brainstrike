/**
 * File Tree Hook (Context-aware) with Lazy Loading
 *
 * This hook provides file tree functionality using lazy loading - directories
 * load their children on-demand when expanded, providing instant initial load
 * regardless of tree size.
 *
 * Features:
 * - Instant initial load (only root-level contents)
 * - On-demand directory loading on expand
 * - Per-directory loading spinners
 * - Full cancellation support
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileTreeWorkerPort } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import type React from 'react';
import type { AddMultipleSelectedFilesChunked } from './hooks/recursive-selection-utils';
import { useLazyFileTree } from './use-lazy-file-tree';
import type { NormalizedFileTreeState } from './utils/normalized-file-tree';

/**
 * Simplified loading progress state for lazy loading.
 * Since we no longer do full tree scans, progress is much simpler.
 */
export interface LoadingProgressState {
  /** Whether initial root load is in progress */
  isInitialLoading: boolean;
  /** Number of directories currently loading */
  loadingCount: number;
}

export interface CancellableFileTreeHook {
  /** @internal get cached descendant file count without nested traversal */
  __internalGetDescendantFileCount?: (path: string) => number;
  /** @internal get descendant file paths without nested traversal */
  __internalGetDescendantFilePaths?: (path: string, maxCount?: number) => string[];
  /** @internal materialize a full subtree on demand */
  __internalMaterializeSubtree?: (path: string) => IFileNode | undefined;
  /** @internal normalized tree state for provider-backed render paths */
  __internalNormalizedTreeRef?: React.RefObject<NormalizedFileTreeState>;
  /** @internal version that changes whenever the normalized tree changes */
  __internalNormalizedTreeVersion?: number;
  /** Cancel loading for a specific directory (e.g., on collapse) */
  cancelChildLoading: (path: string) => void;
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Whether the current operation can be cancelled */
  cancellable: boolean;
  /** Cancel the current loading operation */
  cancelOperation: () => void;
  /** Cancel the current recursive selection operation */
  cancelRecursiveSelect: () => void;
  /** Cancel the current select all operation */
  cancelSelectAll: () => void;
  error: Error | null;
  /** Progress of expand-all operation */
  expandAllProgress: { loaded: number; total: number } | null;
  /** Progressively expand all directories (loads everything) */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
    currentExpandedPaths?: ReadonlySet<string>
  ) => Promise<void>;
  fileTree: IFileNode[];
  /** Whether the operation is currently being cancelled */
  isCancelling: boolean;
  /** Whether expand-all is in progress */
  isExpandingAll: boolean;
  isLoading: boolean;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll: boolean;
  /** Whether a subtree is being loaded for selection */
  isLoadingForSelection: boolean;
  /** Load children of a directory on expand */
  loadChildren: (path: string) => Promise<void>;
  /** Path of the folder being loaded for selection (if any) */
  loadingPathForSelection: string | null;
  /** Set of paths currently loading their children (for UI feedback) */
  loadingPaths: Set<string>;
  loadingProgress: LoadingProgressState;
  /** Load specific paths using worker (for restoration) */
  loadSpecificPaths: (
    paths: string[],
    onProgress?: (loaded: number, total: number, currentPath: string) => void
  ) => Promise<void>;
  /** Refresh a specific directory */
  refreshDirectory: (path: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  /**
   * Select all files in the provided tree, loading if needed.
   * IMPORTANT: Pass the FILTERED tree (quickFilteredTree) to respect workspace filters.
   */
  selectAllRecursively: (
    filteredTree: IFileNode[],
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<{
    success: boolean;
    filePaths: string[];
    totalAvailable?: number;
    limitReached?: boolean;
    cancelled?: boolean;
    error?: string;
  }>;
  /** Select all files in a folder recursively, loading if needed */
  selectFolderRecursively: (
    node: IFileNode,
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    currentSelectionSize: number,
    currentDirectorySelectionSize?: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<{ success: boolean; filePaths: string[]; cancelled?: boolean; error?: string }>;
  /** Worker port ref for worker-based tree flattening (BST-375) */
  workerPortRef: React.RefObject<FileTreeWorkerPort | null>;
}

export interface UseFileTreeOptions {
  /**
   * Filter function to apply workspace include/exclude filters to a tree.
   * Called in the slow path when directories are loaded from the worker,
   * ensuring workspace filters are respected before file selection.
   */
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];

  /**
   * Callback invoked when nodes are added to the tree.
   * Used by FileTreeIndex for incremental indexing.
   * @param nodes - The nodes that were added
   * @param parentPath - The parent path, or null for root-level nodes
   */
  onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void;
}

/**
 * File tree hook with lazy loading.
 *
 * Only loads root-level contents on mount. Subdirectories load their children
 * on-demand when expanded, providing instant initial display regardless of
 * tree size.
 *
 * @param rootDirectoryHandle - The root directory to load
 * @param options - Optional configuration including filterTreeFn for workspace filters
 */
export function useFileTree(
  rootDirectoryHandle: DirectoryHandle | null,
  options: UseFileTreeOptions = {}
): CancellableFileTreeHook {
  const {
    fileTree,
    isLoading,
    error,
    loadingPaths,
    loadChildren,
    cancelLoading,
    cancelChildLoading,
    refreshDirectory,
    refreshTree,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
    loadSpecificPaths,
    selectFolderRecursively,
    cancelRecursiveSelect,
    isLoadingForSelection,
    loadingPathForSelection,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll,
    workerPortRef,
    __internalNormalizedTreeRef,
    __internalNormalizedTreeVersion,
    __internalGetDescendantFileCount,
    __internalGetDescendantFilePaths,
    __internalMaterializeSubtree,
  } = useLazyFileTree(rootDirectoryHandle, options);

  return {
    fileTree,
    isLoading,
    error,
    refreshTree,
    loadingProgress: {
      loadingCount: loadingPaths.size,
      isInitialLoading: isLoading && loadingPaths.size === 0,
    },
    cancellable: isLoading || isExpandingAll,
    cancelOperation: cancelLoading,
    isCancelling: false, // Lazy loading doesn't have a separate cancelling state
    loadingPaths,
    loadChildren,
    cancelChildLoading,
    refreshDirectory,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
    loadSpecificPaths,
    selectFolderRecursively,
    cancelRecursiveSelect,
    isLoadingForSelection,
    loadingPathForSelection,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll,
    workerPortRef,
    __internalNormalizedTreeRef,
    __internalNormalizedTreeVersion,
    __internalGetDescendantFileCount,
    __internalGetDescendantFilePaths,
    __internalMaterializeSubtree,
  };
}
