import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { onEmbeddingSetUpdated } from '@brainstrike/utils/browser-events';
import { canonicalizeCollectionTimestamps } from '@brainstrike/vector-management';
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
          // Same canonicalization `useCollections` applies to this event. This
          // hook is the ONLY writer when the Database tab has never mounted —
          // the flow this surface exists for — and `EmbeddingSet.createdAt` is
          // `String(row.created_at)`, so a Date arrives as 'Sun Aug 09 2026 …'.
          // compareCollectionsDesc compares createdAt relationally, and
          // 'S' > '2', so a raw entry would sort above every ISO one.
          upsertCachedCollection(canonicalizeCollectionTimestamps(detail.collection));
        }
      }),
    [removeCachedCollection, upsertCachedCollection]
  );
}
