import { createFileExplorerStore } from '@brainstrike/file-explorer';
import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState } from '@brainstrike/types';
import { createContext, useContext, useMemo } from 'react';
import type { StoreApi } from 'zustand';
import type { UseBoundStoreWithEqualityFn } from 'zustand/traditional';

// Create a context for the file explorer store
const FileExplorerStoreContext = createContext<UseBoundStoreWithEqualityFn<
  StoreApi<FileExplorerState>
> | null>(null);

export interface FileExplorerProviderProps {
  storageAdapter: StorageAdapter;
  children: React.ReactNode;
}

export function FileExplorerProvider({ storageAdapter, children }: FileExplorerProviderProps) {
  // Create store instance with the provided storage adapter
  const store = useMemo(() => createFileExplorerStore(storageAdapter), [storageAdapter]);

  return (
    <FileExplorerStoreContext.Provider value={store}>{children}</FileExplorerStoreContext.Provider>
  );
}

export function useFileExplorerStoreContext(): UseBoundStoreWithEqualityFn<
  StoreApi<FileExplorerState>
> {
  const context = useContext(FileExplorerStoreContext);
  if (!context) {
    throw new Error('useFileExplorerStoreContext must be used within a FileExplorerProvider');
  }
  return context;
}
