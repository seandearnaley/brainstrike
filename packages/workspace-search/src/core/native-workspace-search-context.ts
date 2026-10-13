import type {
  IndexerEmbeddingProfile,
  IndexerStatus,
  IndexSearchCapability,
  NativeIndexLifecycleObservation,
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
  /** Observed Main lifecycle; absence means this host has no lifecycle subscription. */
  lifecycle?: NativeIndexLifecycleObservation | null;
  profile: IndexerEmbeddingProfile | null;
  /** Exact refusal from the selected renderer request-plan resolver. */
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
