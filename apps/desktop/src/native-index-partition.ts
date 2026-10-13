/**
 * The native index's partition follows the saved choice (BST-1988). A saved
 * collection owns the workspace's sources in either mode. With none, TEXT is
 * the TEXT partition: workspace roots only, and PG sources with no embedding
 * set. Text search needs no model, so no collection is invented for it.
 */
import type { IndexScope } from '@brainstrike/indexer';
import type { CollectionPort } from '@brainstrike/state-store';
import type { NativeIndexSettings } from './native-index-settings';

type SavedPartition = Pick<NativeIndexSettings, 'managedCollectionId'>;

/** A saved collection exists exactly once in the application catalog; the TEXT partition has none. */
export async function assertSavedCollection(
  { managedCollectionId }: SavedPartition,
  catalog: CollectionPort,
  assertCurrent: () => void
): Promise<void> {
  if (managedCollectionId === null) {
    return;
  }
  const { collections } = await catalog.collections({ id: managedCollectionId, operation: 'get' });
  assertCurrent();
  if (collections.length !== 1 || collections[0]?.id !== managedCollectionId) {
    throw new Error(
      'The saved native collection is missing or ambiguous in the application catalog.'
    );
  }
}

/** The saved partition's PG catalog rows, as a `file_records` predicate and its parameters. */
export function catalogPartition({ managedCollectionId }: SavedPartition): {
  readonly params: readonly string[];
  readonly predicate: string;
} {
  return managedCollectionId === null
    ? { params: [], predicate: 'embedding_set_id IS NULL AND root_id IS NOT NULL' }
    : { params: [managedCollectionId], predicate: 'embedding_set_id::text=$1' };
}

/** Each authorized workspace root's scope, and the collection's when one is saved. */
export function partitionScopes(
  rootIds: readonly string[],
  { managedCollectionId }: SavedPartition
): readonly IndexScope[] {
  return [
    ...rootIds.map((rootId) => ({ kind: 'workspace' as const, rootId })),
    ...(managedCollectionId === null
      ? []
      : [{ embeddingSetId: managedCollectionId, kind: 'collection' as const }]),
  ];
}

/** VECTOR's saved collection. Settings refuse VECTOR without one; TEXT never resolves a profile. */
export function vectorCollectionId({ managedCollectionId }: SavedPartition): string {
  if (managedCollectionId === null) {
    throw new Error('Native vector indexing has no saved collection.');
  }
  return managedCollectionId;
}
