import type { IndexConfigCapability } from '@brainstrike/assistant-contract/index-config';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { ReactNode } from 'react';
import { NativeWorkspaceIndexProvider } from './native-workspace-index-provider';

export interface WorkspaceCollectionSyncProviderProps {
  children: ReactNode;
  readonly nativeIndexSearch: (IndexSearchCapability & IndexConfigCapability) | null;
}

export function WorkspaceCollectionSyncProvider({
  children,
  nativeIndexSearch,
}: WorkspaceCollectionSyncProviderProps) {
  if (nativeIndexSearch) {
    return (
      <NativeWorkspaceIndexProvider capability={nativeIndexSearch}>
        {children}
      </NativeWorkspaceIndexProvider>
    );
  }
  return <>{children}</>;
}
