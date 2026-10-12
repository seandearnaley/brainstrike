/**
 * The Workspace Index summary the listing tools report (listEmbeddingSpaces,
 * listWorkspaceContext), from Main's native index status: the index a host
 * thread actually searches.
 */
import type { IndexerStatus } from '@brainstrike/indexing-contract/indexer-client';

export interface WorkspaceIndexSummary {
  embeddingSetId: string | null;
  enabled: boolean;
  mode: string | null;
  paused: boolean;
}

export function nativeWorkspaceIndexSummary(status: IndexerStatus): WorkspaceIndexSummary {
  if (status.kind !== 'ready') {
    return { embeddingSetId: null, enabled: false, mode: null, paused: false };
  }
  const ids = status.authorizedCollectionIds ?? [];
  return {
    embeddingSetId: ids.length === 1 ? (ids[0] ?? null) : null,
    enabled: true,
    mode: status.embedding.indexMode === 'vector-configured' ? 'VECTOR' : 'TEXT',
    // The native status carries no pause state; a paused index still serves reads.
    paused: false,
  };
}
