import type {
  IndexerEmbeddingProfile,
  IndexerStatus,
  IndexSearchCapability,
  NativeIndexLifecycleObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import { createContext, useContext } from 'react';

export interface NativeWorkspaceSearchDependencies {
  capability: IndexSearchCapability | null;
  /** Embeds the query with the host's hosted embedder for this exact profile. */
  embedQuery: (
    profile: IndexerEmbeddingProfile,
    text: string,
    options: { readonly signal: AbortSignal }
  ) => Promise<readonly number[]>;
  /** Observed Main lifecycle; absence means this host has no lifecycle subscription. */
  lifecycle?: NativeIndexLifecycleObservation | null;
  profile: IndexerEmbeddingProfile | null;
  /** Why the host offers no vector profile, shown instead of semantic results. */
  profileUnavailableReason?: string;
  /** Latest read observation; never part of executor identity. */
  status?: IndexerStatus;
}
export const NativeWorkspaceSearchContext = createContext<NativeWorkspaceSearchDependencies | null>(
  null
);

export function useNativeWorkspaceSearchDependencies(): NativeWorkspaceSearchDependencies | null {
  return useContext(NativeWorkspaceSearchContext);
}
