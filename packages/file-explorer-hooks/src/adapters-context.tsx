import type { FileSystemAdapter } from '@brainstrike/file-system';
import React, { createContext, type ReactNode, useContext, useMemo } from 'react';

export interface AdaptersContextValue {
  fileSystemAdapter: FileSystemAdapter;
}

export const AdaptersContext = createContext<AdaptersContextValue | null>(null);

export interface AdaptersProviderProps {
  children: ReactNode;
  fileSystemAdapter: FileSystemAdapter;
}

export function AdaptersProvider({ fileSystemAdapter, children }: AdaptersProviderProps) {
  const value = useMemo<AdaptersContextValue>(() => ({ fileSystemAdapter }), [fileSystemAdapter]);

  return React.createElement(AdaptersContext.Provider, { value }, children);
}

export function useAdapters(): AdaptersContextValue {
  const context = useContext(AdaptersContext);
  if (!context) {
    throw new Error('useAdapters must be used within an AdaptersProvider');
  }
  return context;
}
