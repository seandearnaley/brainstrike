/**
 * File Tree Provider
 *
 * Provides a single source of truth for the file tree state across all components.
 * This ensures that when expand-all completes, all consumers see the updated tree.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { createContext, type ReactNode, useContext } from 'react';
import { type CancellableFileTreeHook, useFileTree } from './use-file-tree-context';

type FileTreeContextType = CancellableFileTreeHook & {
  rootDirectoryHandle: DirectoryHandle | null;
};

const FileTreeContext = createContext<FileTreeContextType | null>(null);

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
 * @param props.filterTreeFn - Optional filter function for workspace filters.
 *   When provided, this is used in the slow path of selectAllRecursively
 *   to ensure workspace include/exclude filters are applied to loaded directories.
 */
export function FileTreeProvider({
  children,
  rootDirectoryHandle,
  filterTreeFn,
}: FileTreeProviderProps): React.ReactElement {
  // Build options object conditionally to satisfy exactOptionalPropertyTypes
  const options = filterTreeFn ? { filterTreeFn } : {};
  const fileTreeState = useFileTree(rootDirectoryHandle, options);

  return (
    <FileTreeContext.Provider value={{ ...fileTreeState, rootDirectoryHandle }}>
      {children}
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
