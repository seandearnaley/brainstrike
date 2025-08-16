import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo } from 'react';
import { useFileContentLoading } from './use-file-content-loading';
import { useFileSystem } from './use-file-system';
import { useFileTree } from './use-file-tree';

export interface UseFileExplorerParams {
  onDisplayedFilePathsChange?: (paths: Set<string>) => void;
}

export function useFileExplorer({ onDisplayedFilePathsChange }: UseFileExplorerParams = {}) {
  'use no memo';
  const callback = onDisplayedFilePathsChange ?? (() => {});
  const areEqual = (
    a: {
      includeFilters: string[];
      excludeFilters: string[];
      useRegex: boolean;
      setCurrentFolderId: (id: string | null) => void;
    },
    b: {
      includeFilters: string[];
      excludeFilters: string[];
      useRegex: boolean;
      setCurrentFolderId: (id: string | null) => void;
    }
  ): boolean =>
    a.includeFilters === b.includeFilters &&
    a.excludeFilters === b.excludeFilters &&
    a.useRegex === b.useRegex &&
    a.setCurrentFolderId === b.setCurrentFolderId;

  const { includeFilters, excludeFilters, useRegex, setCurrentFolderId } = useFileExplorerStore(
    (s) => ({
      includeFilters: s.includeFilters,
      excludeFilters: s.excludeFilters,
      useRegex: s.useRegex,
      setCurrentFolderId: s.setCurrentFolderId,
    }),
    areEqual
  );

  const { rootDirectoryHandle, selectRootDirectory, isAccessLoading } = useFileSystem({
    setCurrentFolderId,
  });
  const {
    fileTree: unsafeFileTree,
    isLoading: isTreeLoading,
    error: treeError,
    refreshTree,
  } = useFileTree(rootDirectoryHandle);
  const fileTree = unsafeFileTree ?? [];
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

  const displayedFilePaths = useMemo(() => {
    const tree = Array.isArray(fileTree) ? fileTree : [];
    const nodes = tree.length
      ? (applyFileFilters(tree, includeFilters, excludeFilters, useRegex) ?? [])
      : [];
    const paths = new Set<string>();
    for (const node of nodes) {
      if (node && typeof node.path === 'string') paths.add(node.path);
    }
    return paths;
  }, [fileTree, includeFilters, excludeFilters, useRegex, applyFileFilters]);

  // Effect to apply filters and update displayed paths
  useEffect(() => {
    const tree = Array.isArray(fileTree) ? fileTree : [];
    if (tree.length > 0) {
      const newDisplayedFileNodes =
        applyFileFilters(tree, includeFilters, excludeFilters, useRegex) ?? [];
      const newDisplayedPaths = new Set<string>(
        newDisplayedFileNodes
          .filter((node: IFileNode | undefined | null): node is IFileNode => !!node && !!node.path)
          .map((node: IFileNode) => node.path)
      );
      callback(newDisplayedPaths);
    } else {
      callback(new Set<string>());
    }
  }, [fileTree, includeFilters, excludeFilters, useRegex, applyFileFilters, callback]);

  const handleRootDirectorySelect = useCallback(async () => {
    const handle = await selectRootDirectory();
    return handle;
  }, [selectRootDirectory]);

  const refreshFileExplorer = useCallback(async () => {
    if (!rootDirectoryHandle) {
      throw new Error('Cannot refresh: No root directory selected.');
    }
    await refreshTree();
  }, [rootDirectoryHandle, refreshTree]);

  const loadFileContentCb = useCallback(
    async (path: string) => {
      const folderId = rootDirectoryHandle?.name;
      if (!folderId) return;
      const key = encodeFileSelection(folderId, path);
      return handleFileContentLoading([key]);
    },
    [rootDirectoryHandle, handleFileContentLoading]
  );

  // Return the comprehensive API for the file explorer
  return {
    rootDirectoryHandle,
    isAccessLoading,
    fileTree,
    isTreeLoading,
    treeError,
    displayedFilePaths,
    filterError,
    fileContents,
    isContentLoading,
    contentError,
    isLoading,
    error,
    actions: {
      handleRootDirectorySelect,
      loadFileContent: loadFileContentCb,
      clearFileContents,
      refreshFileExplorer,
    },
  };
}
