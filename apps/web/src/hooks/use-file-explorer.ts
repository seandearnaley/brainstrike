import type { IFileNode } from '@brainstrike/types';
import { useCallback, useEffect, useState } from 'react';
import { useFileExplorerStore } from '../stores/use-file-explorer-store';
import { useFileContentLoading } from './use-file-content-loading';
import { useFileFilters } from './use-file-filters';
import { useFileSystem } from './use-file-system';
import type { LoadingProgressState } from './use-file-tree';
import { useFileTree } from './use-file-tree';

interface UseFileExplorerProps {
  onDisplayedFilePathsChange: (displayedFilePaths: Set<string>) => void;
}

interface UseFileExplorerReturn {
  fileTree: IFileNode[];
  handleRootDirectorySelect: () => Promise<FileSystemDirectoryHandle | null>;
  isLoading: boolean;
  error: Error | null;
  fileContents: { [path: string]: string };
  applyFileFilters: (
    includeFilters: string[],
    excludeFilters: string[],
    useRegex: boolean
  ) => IFileNode[];
  filterError: string | null;
  rootDirectoryHandle: FileSystemDirectoryHandle | null;
  isFileSystemAccessSupported: () => { supported: boolean; reason: string };
  loadFileContent: (path: string) => Promise<void>;
  refreshFileExplorer: () => Promise<void>;
  isInitialLoad: boolean;
  clearFileContents: (compositeKeys: string[]) => void;
  loadingProgress: LoadingProgressState | null;
}

export function useFileExplorer({
  onDisplayedFilePathsChange,
}: UseFileExplorerProps): UseFileExplorerReturn {
  const { includeFilters, excludeFilters, useRegex } = useFileExplorerStore();
  const { rootDirectoryHandle, selectRootDirectory, isFileSystemAccessSupported } = useFileSystem();

  const {
    fileTree,
    isLoading: isTreeLoading,
    error: treeError,
    refreshTree,
    loadingProgress,
  } = useFileTree(rootDirectoryHandle);

  const {
    fileContents,
    error: contentError,
    handleFileContentLoading,
    clearFileContents,
  } = useFileContentLoading(fileTree);

  const { applyFileFilters, filterError } = useFileFilters();
  const [filteredTree, setFilteredTree] = useState<IFileNode[]>([]);

  // Only consider tree loading as the main loading state
  const isLoading = isTreeLoading;

  // Apply filters whenever the tree or filters change
  useEffect(() => {
    if (fileTree.length > 0) {
      const filtered = applyFileFilters(fileTree, includeFilters, excludeFilters, useRegex);
      setFilteredTree(filtered);
    }
  }, [fileTree, includeFilters, excludeFilters, useRegex, applyFileFilters]);

  // Create a wrapper for loadFileContent that accepts a single path
  const loadFileContent = useCallback(
    async (path: string) => {
      await handleFileContentLoading([path]);
    },
    [handleFileContentLoading]
  );

  const handleRootDirectorySelect = useCallback(async () => {
    const handle = await selectRootDirectory();
    return handle;
  }, [selectRootDirectory]);

  const refreshFileExplorer = useCallback(async () => {
    if (!rootDirectoryHandle) {
      throw new Error('No root directory selected');
    }
    await refreshTree();
  }, [rootDirectoryHandle, refreshTree]);

  // Create a wrapper for applyFileFilters that matches the expected return type
  const wrappedApplyFileFilters = useCallback(
    (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => {
      const filtered = applyFileFilters(fileTree, includeFilters, excludeFilters, useRegex);
      setFilteredTree(filtered);
      return filtered;
    },
    [applyFileFilters, fileTree]
  );

  // Update displayed files when the filtered tree changes
  useEffect(() => {
    const collectVisiblePaths = (nodes: IFileNode[]): Set<string> => {
      const paths = new Set<string>();
      const collect = (nodes: IFileNode[]) => {
        for (const node of nodes) {
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

  return {
    fileTree: filteredTree, // Return the filtered tree instead of the raw tree
    handleRootDirectorySelect,
    isLoading,
    error: treeError || contentError,
    fileContents,
    applyFileFilters: wrappedApplyFileFilters,
    filterError,
    rootDirectoryHandle,
    isFileSystemAccessSupported,
    loadFileContent,
    refreshFileExplorer,
    isInitialLoad: false,
    clearFileContents,
    loadingProgress,
  };
}
