import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';

/**
 * Whether the active collection is off-limits to manual imports.
 *
 * Background indexing owns the cache lifecycle of the workspace index's vector
 * space, so a manual import into it would fight the indexer. Two surfaces need
 * the same answer — the Database panel renders the explanatory notice, the
 * explorer's import action turns it into a block reason — so it lives in one
 * place rather than being derived twice.
 */
export function useIsManagedCollection(): boolean {
  const activeCollectionId = useVectorStatusUIStore((state) => state.activeEmbeddingSetId);
  const activeCollectionSystemRole = useVectorStatusUIStore(
    (state) =>
      state.cachedCollections.find((candidate) => candidate.id === state.activeEmbeddingSetId)
        ?.systemRole ?? null
  );

  return Boolean(activeCollectionId && activeCollectionSystemRole === 'workspace-index');
}
