import type {
  IndexerEmbeddingProfile,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { createContext, type ReactNode, useContext } from 'react';

export interface NativeWorkspaceSearchDependencies {
  capability: IndexSearchCapability | null;
  /** Executes through the renderer-owned embedding host with this exact profile. */
  embedQuery: (profile: IndexerEmbeddingProfile, text: string) => Promise<readonly number[]>;
  profile: IndexerEmbeddingProfile | null;
  /** Exact refusal from the selected renderer request-plan resolver. */
  profileUnavailableReason?: string;
}
const NativeWorkspaceSearchContext = createContext<NativeWorkspaceSearchDependencies | null>(null);

/** Installed native ownership stays explicit even while its capability is unavailable. */
export function NativeWorkspaceSearchProvider({
  dependencies,
  children,
}: {
  dependencies: NativeWorkspaceSearchDependencies;
  children: ReactNode;
}): ReactNode {
  return (
    <NativeWorkspaceSearchContext value={dependencies}>{children}</NativeWorkspaceSearchContext>
  );
}
export function useNativeWorkspaceSearchDependencies(): NativeWorkspaceSearchDependencies | null {
  return useContext(NativeWorkspaceSearchContext);
}
