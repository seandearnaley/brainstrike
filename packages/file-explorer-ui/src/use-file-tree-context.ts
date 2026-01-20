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
import type { IFileNode } from '@brainstrike/types';
import { useLazyFileTree } from './use-lazy-file-tree';

/**
 * Simplified loading progress state for lazy loading.
 * Since we no longer do full tree scans, progress is much simpler.
 */
export interface LoadingProgressState {
  /** Number of directories currently loading */
  loadingCount: number;
  /** Whether initial root load is in progress */
  isInitialLoading: boolean;
}

export interface CancellableFileTreeHook {
  fileTree: IFileNode[];
  isLoading: boolean;
  error: Error | null;
  refreshTree: () => Promise<void>;
  loadingProgress: LoadingProgressState;
  /** Whether the current operation can be cancelled */
  cancellable: boolean;
  /** Cancel the current loading operation */
  cancelOperation: () => void;
  /** Whether the operation is currently being cancelled */
  isCancelling: boolean;
  /** Set of paths currently loading their children (for UI feedback) */
  loadingPaths: Set<string>;
  /** Load children of a directory on expand */
  loadChildren: (path: string) => Promise<void>;
  /** Cancel loading for a specific directory (e.g., on collapse) */
  cancelChildLoading: (path: string) => void;
  /** Refresh a specific directory */
  refreshDirectory: (path: string) => Promise<void>;
  /** Progressively expand all directories (loads everything) */
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
  ) => Promise<void>;
  /** Cancel expand-all operation */
  cancelExpandAll: () => void;
  /** Whether expand-all is in progress */
  isExpandingAll: boolean;
  /** Progress of expand-all operation */
  expandAllProgress: { loaded: number; total: number } | null;
  /** Load specific paths using worker (for restoration) */
  loadSpecificPaths: (
    paths: string[],
    onProgress?: (loaded: number, total: number, currentPath: string) => void
  ) => Promise<void>;
  /** Select all files in a folder recursively, loading if needed */
  selectFolderRecursively: (
    node: IFileNode,
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    currentSelectionSize: number
  ) => Promise<{ success: boolean; filePaths: string[]; cancelled?: boolean; error?: string }>;
  /** Cancel the current recursive selection operation */
  cancelRecursiveSelect: () => void;
  /** Whether a subtree is being loaded for selection */
  isLoadingForSelection: boolean;
  /** Path of the folder being loaded for selection (if any) */
  loadingPathForSelection: string | null;
  /**
   * Select all files in the provided tree, loading if needed.
   * IMPORTANT: Pass the FILTERED tree (quickFilteredTree) to respect workspace filters.
   */
  selectAllRecursively: (
    filteredTree: IFileNode[],
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number
  ) => Promise<{
    success: boolean;
    filePaths: string[];
    totalAvailable?: number;
    limitReached?: boolean;
    cancelled?: boolean;
    error?: string;
  }>;
  /** Cancel the current select all operation */
  cancelSelectAll: () => void;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll: boolean;
}

export interface UseFileTreeOptions {
  /**
   * Filter function to apply workspace include/exclude filters to a tree.
   * Called in the slow path when directories are loaded from the worker,
   * ensuring workspace filters are respected before file selection.
   */
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
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
  };
}
