/**
 * The native index's partition follows the saved choice (BST-1988); the rule
 * itself is canonical ingestion's, shared with the browser's file index. Only
 * the PG catalog's predicate is desktop's own.
 */
import type { NativeIndexSettings } from './native-index-settings';

export {
  assertSavedCollection,
  partitionScopes,
  vectorCollectionId,
} from '@brainstrike/canonical-ingestion';

type SavedPartition = Pick<NativeIndexSettings, 'managedCollectionId'>;

/** The saved partition's PG catalog rows, as a `file_records` predicate and its parameters. */
export function catalogPartition({ managedCollectionId }: SavedPartition): {
  readonly params: readonly string[];
  readonly predicate: string;
} {
  return managedCollectionId === null
    ? { params: [], predicate: 'embedding_set_id IS NULL AND root_id IS NOT NULL' }
    : { params: [managedCollectionId], predicate: 'embedding_set_id::text=$1' };
}
