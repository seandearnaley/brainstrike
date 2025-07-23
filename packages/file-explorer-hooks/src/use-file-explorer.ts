import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { useCallback, useEffect, useMemo } from 'react';
import { useFileContentLoading } from './use-file-content-loading';
import { useFileSystem } from './use-file-system';
import { useFileTree } from './use-file-tree';

export interface UseFileExplorerParams {
  onDisplayedFilePathsChange?: (paths: Set<string>) => void;
}

export function useFileExplorer({ onDisplayedFilePathsChange }: UseFileExplorerParams = {}) {
  const callback = useMemo(
    () => onDisplayedFilePathsChange ?? (() => {}),
    [onDisplayedFilePathsChange]
  );
  const store = useFileExplorerStore();
  const {
    // currentFolderId, // Commented out if not immediately used
    includeFilters,
    excludeFilters,
    useRegex,
    setCurrentFolderId,
    // setFilters,       // Commented out if not immediately used
    // setUseRegex,      // Commented out if not immediately used
  } = store;

  const { rootDirectoryHandle, selectRootDirectory, isAccessLoading } = useFileSystem({
    setCurrentFolderId,
  });
  const {
    fileTree,
    isLoading: isTreeLoading,
    error: treeError,
    refreshTree,
  } = useFileTree(rootDirectoryHandle);
  const { applyFileFilters, filterError } = useFileFilters();
  const {
    fileContents,
    isLoading: isContentLoading,
    error: contentError,
    handleFileContentLoading,
    clearFileContents,
  } = useFileContentLoading(fileTree); // Corrected: pass fileTree

  const isLoading = isAccessLoading || isTreeLoading || isContentLoading;
  const error = treeError || contentError || filterError;

  // Effect to apply filters and update displayed paths
  useEffect(() => {
    if (fileTree.length > 0) {
      const newDisplayedFileNodes = applyFileFilters(
        fileTree,
        includeFilters,
        excludeFilters,
        useRegex
      );
      const newDisplayedPaths = new Set<string>(
        newDisplayedFileNodes.map((node: IFileNode) => node.path)
      );
      callback(newDisplayedPaths);
    } else {
      callback(new Set<string>());
    }
  }, [fileTree, includeFilters, excludeFilters, useRegex, applyFileFilters, callback]);

  const handleRootDirectorySelect = async () => {
    const handle = await selectRootDirectory();
    return handle;
  };

  const refreshFileExplorer = useCallback(async () => {
    if (!rootDirectoryHandle) {
      throw new Error('Cannot refresh: No root directory selected.');
    }
    await refreshTree();
  }, [rootDirectoryHandle, refreshTree]);

  // Return the comprehensive API for the file explorer
  return {
    rootDirectoryHandle,
    isAccessLoading,
    fileTree,
    isTreeLoading,
    treeError,
    displayedFilePaths:
      fileTree.length > 0
        ? new Set<string>(
            applyFileFilters(fileTree, includeFilters, excludeFilters, useRegex).map(
              (node: IFileNode) => node.path
            )
          )
        : new Set<string>(),
    filterError,
    fileContents,
    isContentLoading,
    contentError,
    isLoading,
    error,
    actions: {
      handleRootDirectorySelect,
      loadFileContent: async (path: string) => {
        return handleFileContentLoading([path]);
      },
      clearFileContents,
      refreshFileExplorer,
    },
  };
}
