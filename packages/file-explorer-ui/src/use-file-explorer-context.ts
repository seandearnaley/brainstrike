/**
 * File Explorer Hook (Context-aware)
 *
 * This hook provides file explorer functionality using the context-based store.
 */

import { useFileExplorer as useCoreFileExplorer } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { useCallback, useEffect, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useFileSystem } from './use-file-system-context';
import { type LoadingProgressState, useFileTree } from './use-file-tree-context';
import { useSharedFileContentLoading } from './use-shared-file-content-loading';

type UseFileExplorerProps = Record<string, never>;

interface UseFileExplorerReturn {
  fileTree: IFileNode[];
  handleRootDirectorySelect: () => Promise<DirectoryHandle | null>;
  isLoading: boolean;
  error: Error | null;
  fileContents: { [path: string]: string };
  loadingFiles: Set<string>;
  applyFileFilters: (
    includeFilters: string[],
    excludeFilters: string[],
    useRegex: boolean
  ) => IFileNode[];
  filterError: string | null;
  rootDirectoryHandle: DirectoryHandle | null;
  isFileSystemAccessSupported: () => { supported: boolean; reason: string };
  loadFileContent: (path: string) => Promise<void>;
  refreshFileExplorer: () => Promise<void>;
  isInitialLoad: boolean;
  clearFileContents: (compositeKeys: string[]) => void;
  loadingProgress: LoadingProgressState | null;
  /** Whether the current operation can be cancelled */
  cancellable: boolean;
  /** Cancel the current loading operation */
  cancelOperation: () => void;
  /** Whether the operation is currently being cancelled */
  isCancelling: boolean;
}

export function useFileExplorer(_: UseFileExplorerProps = {}): UseFileExplorerReturn {
  const store = useFileExplorerStoreContext();
  const {
    includeFilters,
    excludeFilters,
    useRegex,
    /* setCurrentFolderId */
  } = store(
    (s) => ({
      includeFilters: s.includeFilters,
      excludeFilters: s.excludeFilters,
      useRegex: s.useRegex,
      // setCurrentFolderId: s.setCurrentFolderId, // commented intentionally
    }),
    shallow
  );

  // Call the core hook
  const coreExplorer = useCoreFileExplorer();

  const { rootDirectoryHandle, selectRootDirectory, isFileSystemAccessSupported } = useFileSystem();

  const {
    fileTree,
    isLoading: isTreeLoading,
    error: treeError,
    refreshTree,
    loadingProgress,
    cancellable,
    cancelOperation,
    isCancelling,
  } = useFileTree(rootDirectoryHandle);

  // Use shared file contents from store
  const { clearFileContents: storeClearFileContents } = store((s) => ({
    clearFileContents: s.clearFileContents,
  }));

  // Use the shared file content loading hook
  const {
    fileContents,
    error: contentError,
    loadingFiles: contentLoadingFiles,
    handleFileContentLoading,
  } = useSharedFileContentLoading(fileTree);

  const { applyFileFilters: applyFiltersUtil, filterError: localFilterError } = useFileFilters();
  const [filteredTree, setFilteredTree] = useState<IFileNode[]>(fileTree);

  useEffect(() => {
    if (fileTree.length > 0) {
      const filtered = applyFiltersUtil(fileTree, includeFilters, excludeFilters, useRegex);
      setFilteredTree(filtered);
    } else {
      setFilteredTree([]);
    }
  }, [fileTree, includeFilters, excludeFilters, useRegex, applyFiltersUtil]);

  const loadFileContent = useCallback(
    async (compositeKey: string) => {
      await handleFileContentLoading([compositeKey]);
    },
    [handleFileContentLoading]
  );

  const handleRootDirectorySelect = useCallback(async () => {
    return selectRootDirectory();
  }, [selectRootDirectory]);

  const refreshFileExplorer = useCallback(async () => {
    if (!rootDirectoryHandle) {
      throw new Error('No root directory selected');
    }
    await refreshTree();
  }, [rootDirectoryHandle, refreshTree]);

  const wrappedApplyFileFilters = useCallback(
    (
      currentIncludeFilters: string[],
      currentExcludeFilters: string[],
      currentUseRegex: boolean
    ) => {
      const filtered = applyFiltersUtil(
        fileTree,
        currentIncludeFilters,
        currentExcludeFilters,
        currentUseRegex
      );
      setFilteredTree(filtered);
      return filtered;
    },
    [applyFiltersUtil, fileTree]
  );

  // Construct the return object, carefully combining local state/logic with coreExplorer where needed.
  // This needs to satisfy UseFileExplorerReturn type.
  const deriveDisplayError = (): Error | null => {
    if (treeError) return treeError;
    if (contentError) return contentError;
    // If localFilterError is present, it's a string message from useFileFilters
    if (localFilterError) return new Error(localFilterError);
    // coreExplorer.error could be an Error, string, or null
    if (coreExplorer.error) {
      // Check if it's an Error instance
      const error = coreExplorer.error as unknown;
      if (error instanceof Error) {
        return error; // It's an Error object
      }
      // If it's not an Error object, and it's truthy, it must be a string from coreExplorer.filterError
      return new Error(String(coreExplorer.error));
    }
    return null;
  };
  const displayError = deriveDisplayError();

  const approximatedIsInitialLoad = !coreExplorer.rootDirectoryHandle && coreExplorer.isLoading;

  return {
    fileTree: filteredTree,
    handleRootDirectorySelect,
    isLoading: isTreeLoading || coreExplorer.isLoading,
    error: displayError,
    fileContents,
    loadingFiles: contentLoadingFiles,
    applyFileFilters: wrappedApplyFileFilters,
    filterError:
      localFilterError ||
      (typeof coreExplorer.filterError === 'string' ? coreExplorer.filterError : null),
    rootDirectoryHandle,
    isFileSystemAccessSupported,
    loadFileContent,
    refreshFileExplorer,
    isInitialLoad: approximatedIsInitialLoad,
    clearFileContents: storeClearFileContents,
    loadingProgress,
    cancellable,
    cancelOperation,
    isCancelling,
  };
}
