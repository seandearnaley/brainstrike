import type { CachedCollection } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { EmbeddingSet } from '@brainstrike/db';
import { toCanonicalTimestamp } from '@brainstrike/vector-management';

/**
 * Projects a freshly created embedding set into the cached-collection shape the
 * vector status store holds, so a new collection is pickable immediately —
 * before the live collections query catches up. Counts start at zero because
 * nothing has been imported into it yet.
 *
 * `createdAt` is canonicalized HERE, at the single point where an `EmbeddingSet`
 * becomes a cache entry, rather than at each call site. `EmbeddingSet.createdAt`
 * is typed `string` but produced by `String(row.created_at)`, so a Date arrives
 * as 'Sun Aug 09 2026 …'. `compareCollectionsDesc` compares `createdAt`
 * relationally and `'S' > '2'`, so a raw entry sorts above every ISO one.
 *
 * Both callers of this helper (the Explorer import popover and the Database
 * tab) upsert AFTER the `embedding-set-updated` listener — `useCollectionCacheSync`
 * and `useCollections` respectively — has already written the canonicalized
 * entry, so an un-canonicalized value here would deterministically clobber it.
 */
export function collectionCacheSnapshotFromEmbeddingSet(set: EmbeddingSet): CachedCollection {
  return {
    category: set.category ?? null,
    chunkCount: 0,
    createdAt: toCanonicalTimestamp(set.createdAt),
    description: set.description ?? null,
    dimensions: set.dimensions,
    distance: set.distance,
    embeddingCount: 0,
    fileCount: 0,
    id: set.id,
    modelId: set.modelId,
    modelKey: set.modelKey,
    name: set.name ?? null,
    tags: set.tags ?? null,
  };
}
