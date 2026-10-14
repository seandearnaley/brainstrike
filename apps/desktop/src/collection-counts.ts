import type { CollectionCatalogEntry } from '@brainstrike/assistant-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { CollectionPort } from '@brainstrike/state-store';

/** Canonical counts and native observations retain their different owners and availability. */
export async function readCollectionSnapshot(
  store: CollectionPort,
  native: Pick<IndexSearchCapability, 'status' | 'coverageBatch'>
): Promise<readonly CollectionCatalogEntry[]> {
  const snapshot = await store.collections({ operation: 'snapshot' });
  if (!snapshot.counts) {
    throw new Error('Collection owner omitted canonical counts');
  }
  const counts = new Map(snapshot.counts.map((count) => [count.id, count]));
  const status = await native.status();
  const admitted =
    status.kind === 'ready'
      ? snapshot.collections.filter((collection) =>
          status.authorizedCollectionIds?.includes(collection.id)
        )
      : [];
  const observation = admitted.length
    ? await native.coverageBatch(
        admitted.map((collection) => ({ collectionId: collection.id, rootIds: [] }))
      )
    : undefined;
  if (observation?.kind === 'current' && observation.coverage.length !== admitted.length) {
    throw new Error('Native coverage omitted a requested collection');
  }
  return snapshot.collections.map((collection) => {
    const count = counts.get(collection.id);
    if (!count) {
      throw new Error('Collection owner omitted a canonical count row');
    }
    const position = admitted.findIndex((item) => item.id === collection.id);
    const coverage =
      observation?.kind === 'current' && position >= 0 ? observation.coverage[position] : undefined;
    const reason =
      status.kind === 'unavailable'
        ? status.reason
        : position < 0
          ? 'Collection is outside the active native index scope.'
          : observation?.kind === 'blocked'
            ? observation.reason
            : 'Native coverage changed while reading this collection.';
    return {
      ...collection,
      counts: {
        chunks: count.chunks,
        files: count.files,
        unprocessedFiles: count.unprocessedFiles,
      },
      vectors: coverage
        ? { count: coverage.totals.vectors, kind: 'available' as const }
        : { kind: 'unavailable' as const, reason },
    };
  });
}
