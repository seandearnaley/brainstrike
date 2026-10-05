import type {
  IndexerEmbeddingProfile,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { createContext, useContext } from 'react';

export interface NativeWorkspaceSearchDependencies {
  capability: IndexSearchCapability | null;
  /** Executes through the renderer-owned embedding host with this exact profile. */
  embedQuery: (
    profile: IndexerEmbeddingProfile,
    text: string,
    options: { readonly signal: AbortSignal }
  ) => Promise<readonly number[]>;
  profile: IndexerEmbeddingProfile | null;
  /** Exact refusal from the selected renderer request-plan resolver. */
  profileUnavailableReason?: string;
}
export const NativeWorkspaceSearchContext = createContext<NativeWorkspaceSearchDependencies | null>(
  null
);

export function useNativeWorkspaceSearchDependencies(): NativeWorkspaceSearchDependencies | null {
  return useContext(NativeWorkspaceSearchContext);
}
