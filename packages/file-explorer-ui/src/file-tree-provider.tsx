/**
 * File Tree Provider
 *
 * Provides a single source of truth for the file tree state across all components.
 * This ensures that when expand-all completes, all consumers see the updated tree.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import { createContext, type ReactNode, useContext } from 'react';
import { type CancellableFileTreeHook, useFileTree } from './use-file-tree-context';

type FileTreeContextType = CancellableFileTreeHook & {
  rootDirectoryHandle: DirectoryHandle | null;
};

const FileTreeContext = createContext<FileTreeContextType | null>(null);

export interface FileTreeProviderProps {
  children: ReactNode;
  rootDirectoryHandle: DirectoryHandle | null;
}

/**
 * Provider component that creates a single file tree state.
 * All child components can access the shared tree via useFileTreeContext.
 */
export function FileTreeProvider({
  children,
  rootDirectoryHandle,
}: FileTreeProviderProps): React.ReactElement {
  const fileTreeState = useFileTree(rootDirectoryHandle);

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
