import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import React, { createContext, type ReactNode, useContext, useMemo } from 'react';

export type AdaptersContextValue = {
  fileSystemAdapter: FileSystemAdapter;
  storageAdapter: StorageAdapter;
};

export const AdaptersContext = createContext<AdaptersContextValue | null>(null);

export type AdaptersProviderProps = {
  fileSystemAdapter: FileSystemAdapter;
  storageAdapter: StorageAdapter;
  children: ReactNode;
};

export function AdaptersProvider({
  fileSystemAdapter,
  storageAdapter,
  children,
}: AdaptersProviderProps) {
  const value = useMemo<AdaptersContextValue>(
    () => ({
      fileSystemAdapter,
      storageAdapter,
    }),
    [fileSystemAdapter, storageAdapter]
  );

  return React.createElement(AdaptersContext.Provider, { value }, children);
}

export function useAdapters(): AdaptersContextValue {
  const context = useContext(AdaptersContext);
  if (!context) {
    throw new Error('useAdapters must be used within an AdaptersProvider');
  }
  return context;
}
