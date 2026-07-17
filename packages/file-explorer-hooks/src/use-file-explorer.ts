import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { useFileFilters } from '@brainstrike/hooks';

import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useEffect, useMemo } from 'react';
import { useFileContentLoading } from './use-file-content-loading';
import { useFileSystem } from './use-file-system';
import { useFileTree } from './use-file-tree';

export interface UseFileExplorerParams {
  onDisplayedFilePathsChange?: (paths: Set<string>) => void;
}

export function useFileExplorer({ onDisplayedFilePathsChange }: UseFileExplorerParams = {}) {
  // Stabilize callback to avoid dependency churn - memoize the function itself
  const callback = useCallback(
    (paths: Set<string>) => {
      if (onDisplayedFilePathsChange) {
        onDisplayedFilePathsChange(paths);
      }
    },
    [onDisplayedFilePathsChange]
  );

  // Split Zustand selectors to avoid dynamic object creation
  const includeFilters = useFileExplorerStore((s) => s.includeFilters);
  const excludeFilters = useFileExplorerStore((s) => s.excludeFilters);
  const disabledIncludeFilters = useFileExplorerStore((s) => s.disabledIncludeFilters);
  const disabledExcludeFilters = useFileExplorerStore((s) => s.disabledExcludeFilters);
  const useRegex = useFileExplorerStore((s) => s.useRegex);
  const setCurrentFolderId = useFileExplorerStore((s) => s.setCurrentFolderId);
  // Store-sync actions are required by useFileSystem (no silent no-ops). This
  // legacy single-root hook wires them from the store, same as setCurrentFolderId.
  const addActiveRoot = useFileExplorerStore((s) => s.addActiveRoot);
  const removeActiveRoot = useFileExplorerStore((s) => s.removeActiveRoot);
  const setActiveRoots = useFileExplorerStore((s) => s.setActiveRoots);

  // Compute active filters by excluding disabled ones
  const activeIncludeFilters = useMemo(
    () => includeFilters.filter((f) => !disabledIncludeFilters.has(f)),
    [includeFilters, disabledIncludeFilters]
  );
  const activeExcludeFilters = useMemo(
    () => excludeFilters.filter((f) => !disabledExcludeFilters.has(f)),
    [excludeFilters, disabledExcludeFilters]
  );

  const { rootDirectoryHandle, selectRootDirectory, isAccessLoading } = useFileSystem({
    addActiveRoot,
    removeActiveRoot,
    setActiveRoots,
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

  // Unified computation: single useMemo with constant deps and stable callback notify
  // Uses activeIncludeFilters/activeExcludeFilters which exclude disabled patterns
  const displayedFilePaths = useMemo(() => {
    const tree = Array.isArray(fileTree) ? fileTree : [];
    const nodes = tree.length
      ? (applyFileFilters(tree, activeIncludeFilters, activeExcludeFilters, useRegex) ?? [])
      : [];
    const paths = new Set<string>();
    for (const node of nodes) {
      if (node && typeof node.path === 'string') {
        paths.add(node.path);
      }
    }
    return paths;
  }, [fileTree, activeIncludeFilters, activeExcludeFilters, useRegex, applyFileFilters]);

  // biome-ignore lint/plugin: Effect to notify callback when displayedFilePaths changes - controlled parent notification
  useEffect(() => {
    callback(displayedFilePaths);
  }, [displayedFilePaths, callback]);

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
      const folderId = rootDirectoryHandle?.path;
      if (!folderId) {
        return;
      }
      const key = encodeFileSelection(folderId, path);
      return handleFileContentLoading([key]);
    },
    [rootDirectoryHandle, handleFileContentLoading]
  );

  // Return the comprehensive API for the file explorer
  return {
    actions: {
      clearFileContents,
      handleRootDirectorySelect,
      loadFileContent: loadFileContentCb,
      refreshFileExplorer,
    },
    contentError,
    displayedFilePaths,
    error,
    fileContents,
    fileTree,
    filterError,
    isAccessLoading,
    isContentLoading,
    isLoading,
    isTreeLoading,
    rootDirectoryHandle,
    treeError,
  };
}
