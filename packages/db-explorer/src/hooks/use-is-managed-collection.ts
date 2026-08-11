import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';

/**
 * Whether the active collection is off-limits to manual imports.
 *
 * Background indexing owns the cache lifecycle of the collection it manages, so
 * a manual import into it would fight the indexer. Two surfaces need the same
 * answer — the Database panel renders the explanatory notice, the explorer's
 * import action turns it into a block reason — and this rule gains cases (it
 * already covers both the system role and the user-chosen preference), so it
 * lives in one place rather than being derived twice.
 */
export function useIsManagedCollection(): boolean {
  const activeCollectionId = useVectorStatusUIStore((state) => state.activeEmbeddingSetId);
  const activeCollectionSystemRole = useVectorStatusUIStore(
    (state) =>
      state.cachedCollections.find((candidate) => candidate.id === state.activeEmbeddingSetId)
        ?.systemRole ?? null
  );
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );

  return Boolean(
    activeCollectionId &&
      (activeCollectionSystemRole === 'workspace-index' ||
        activeCollectionId === managedCollectionId)
  );
}
