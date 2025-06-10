import type { createFileExplorerStore } from '@brainstrike/file-explorer';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import React, { type ReactNode, createContext, useContext } from 'react';

export interface AdaptersContextValue {
  fileSystemAdapter: FileSystemAdapter;
  storageAdapter: StorageAdapter;
  fileExplorerStore: ReturnType<typeof createFileExplorerStore>;
}

export const AdaptersContext = createContext<AdaptersContextValue | null>(null);

export interface AdaptersProviderProps {
  fileSystemAdapter: FileSystemAdapter;
  storageAdapter: StorageAdapter;
  fileExplorerStore: ReturnType<typeof createFileExplorerStore>;
  children: ReactNode;
}

export function AdaptersProvider({
  fileSystemAdapter,
  storageAdapter,
  fileExplorerStore,
  children,
}: AdaptersProviderProps) {
  const value: AdaptersContextValue = {
    fileSystemAdapter,
    storageAdapter,
    fileExplorerStore,
  };

  return React.createElement(AdaptersContext.Provider, { value }, children);
}

export function useAdapters(): AdaptersContextValue {
  const context = useContext(AdaptersContext);
  if (!context) {
    throw new Error('useAdapters must be used within an AdaptersProvider');
  }
  return context;
}
