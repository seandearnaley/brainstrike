/**
 * File Explorer Hook (Context-aware)
 *
 * This hook provides file explorer functionality using the context-based store.
 */

import { useFileContentLoading } from '@brainstrike/file-explorer-hooks';
import { useFileExplorer as useCoreFileExplorer } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { useCallback, useEffect, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useFileSystem } from './use-file-system-context';
import { type LoadingProgressState, useFileTree } from './use-file-tree-context';

interface UseFileExplorerProps {
  onDisplayedFilePathsChange: (displayedFilePaths: Set<string>) => void;
}

interface UseFileExplorerReturn {
  fileTree: IFileNode[];
  handleRootDirectorySelect: () => Promise<DirectoryHandle | null>;
  isLoading: boolean;
  error: Error | null;
  fileContents: { [path: string]: string };
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
  cancelLoading: () => void;
  isCancelling: boolean;
}

export function useFileExplorer({
  onDisplayedFilePathsChange,
}: UseFileExplorerProps): UseFileExplorerReturn {
  const store = useFileExplorerStoreContext();
  const { includeFilters, excludeFilters, useRegex /*, setCurrentFolderId */ } = store();

  // Call the core hook with only the props it now accepts
  const coreExplorer = useCoreFileExplorer({
    onDisplayedFilePathsChange,
  });

  const { rootDirectoryHandle, selectRootDirectory, isFileSystemAccessSupported } = useFileSystem();

  const {
    fileTree: rawFileTree,
    isLoading: isTreeLoading,
    error: treeError,
    refreshTree,
    loadingProgress,
    cancelLoading,
    isCancelling,
  } = useFileTree(rootDirectoryHandle);

  const {
    fileContents,
    error: contentError,
    handleFileContentLoading,
    clearFileContents,
  } = useFileContentLoading(rawFileTree);

  const { applyFileFilters: applyFiltersUtil, filterError: localFilterError } = useFileFilters();
  const [filteredTree, setFilteredTree] = useState<IFileNode[]>(rawFileTree);

  useEffect(() => {
    if (rawFileTree.length > 0) {
      const filtered = applyFiltersUtil(rawFileTree, includeFilters, excludeFilters, useRegex);
      setFilteredTree(filtered);
    } else {
      setFilteredTree([]);
    }
  }, [rawFileTree, includeFilters, excludeFilters, useRegex, applyFiltersUtil]);

  const loadFileContent = useCallback(
    async (path: string) => {
      await handleFileContentLoading([path]);
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
        rawFileTree,
        currentIncludeFilters,
        currentExcludeFilters,
        currentUseRegex
      );
      setFilteredTree(filtered);
      return filtered;
    },
    [applyFiltersUtil, rawFileTree]
  );

  useEffect(() => {
    const collectVisiblePaths = (nodes: IFileNode[]): Set<string> => {
      const paths = new Set<string>();
      const collect = (innerNodes: IFileNode[]) => {
        for (const node of innerNodes) {
          if (node.type === 'file') {
            paths.add(node.path);
          } else if (node.type === 'directory' && node.children) {
            collect(node.children);
          }
        }
      };
      collect(nodes);
      return paths;
    };
    onDisplayedFilePathsChange(collectVisiblePaths(filteredTree));
  }, [filteredTree, onDisplayedFilePathsChange]);

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
    applyFileFilters: wrappedApplyFileFilters,
    filterError:
      localFilterError ||
      (typeof coreExplorer.filterError === 'string' ? coreExplorer.filterError : null),
    rootDirectoryHandle,
    isFileSystemAccessSupported,
    loadFileContent,
    refreshFileExplorer,
    isInitialLoad: approximatedIsInitialLoad,
    clearFileContents,
    loadingProgress,
    cancelLoading,
    isCancelling,
  };
}
