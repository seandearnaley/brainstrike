import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { onEmbeddingSetUpdated } from '@brainstrike/utils/browser-events';
import { useEffect } from 'react';

/**
 * Keeps the shared `cachedCollections` cache honest for create / rename /
 * delete on surfaces that do NOT own the collections live query.
 *
 * `useCollections` applies exactly these mutations from the same event; both
 * are idempotent, so running this alongside it is safe (and mounting a second
 * `useCollections` instead is NOT — see docs/agents/database.md, "COLLECTIONS
 * LIVE QUERY: ONE OWNER").
 *
 * Mount this on the surface that HOSTS the collection dialogs, not on the
 * picker itself: opening a dialog dismisses the popover the picker lives in,
 * so a listener down there is already unmounted when the outcome is announced.
 */
export function useCollectionCacheSync(): void {
  const removeCachedCollection = useVectorStatusUIStore((state) => state.removeCachedCollection);
  const upsertCachedCollection = useVectorStatusUIStore((state) => state.upsertCachedCollection);

  useEffect(
    () =>
      onEmbeddingSetUpdated((detail) => {
        if (detail?.reason === 'deleted' && detail.id) {
          removeCachedCollection(detail.id);
          return;
        }
        if (detail?.collection) {
          upsertCachedCollection(detail.collection);
        }
      }),
    [removeCachedCollection, upsertCachedCollection]
  );
}
