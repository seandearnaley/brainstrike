import type { FileExplorerState } from '@brainstrike/types';
import { createContext, useContext } from 'react';
import type { StoreApi } from 'zustand';
import type { UseBoundStoreWithEqualityFn } from 'zustand/traditional';

const FileExplorerStoreContext = createContext<UseBoundStoreWithEqualityFn<
  StoreApi<FileExplorerState>
> | null>(null);

export interface FileExplorerProviderProps {
  store: UseBoundStoreWithEqualityFn<StoreApi<FileExplorerState>>;
  children: React.ReactNode;
}

export function FileExplorerProvider({ store, children }: FileExplorerProviderProps) {
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
