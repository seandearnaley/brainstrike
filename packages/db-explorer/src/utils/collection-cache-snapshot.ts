import type { CachedCollection } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { EmbeddingSet } from '@brainstrike/db';

/**
 * Projects a freshly created embedding set into the cached-collection shape the
 * vector status store holds, so a new collection is pickable immediately —
 * before the live collections query catches up. Counts start at zero because
 * nothing has been imported into it yet.
 */
export function collectionCacheSnapshotFromEmbeddingSet(set: EmbeddingSet): CachedCollection {
  return {
    category: set.category ?? null,
    chunkCount: 0,
    createdAt: set.createdAt,
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
