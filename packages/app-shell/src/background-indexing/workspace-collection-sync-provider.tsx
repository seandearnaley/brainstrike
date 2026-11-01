import type { IndexConfigCapability } from '@brainstrike/assistant-contract/index-config';
import type {
  IndexLifecycleCapability,
  IndexRootRegistrationCapability,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type { ReactNode } from 'react';
import { NativeWorkspaceIndexProvider } from './native-workspace-index-provider';

export interface WorkspaceCollectionSyncProviderProps {
  children: ReactNode;
  readonly nativeIndexSearch:
    | (Omit<IndexSearchCapability, 'grep'> &
        IndexConfigCapability &
        IndexLifecycleCapability &
        IndexRootRegistrationCapability)
    | null;
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
