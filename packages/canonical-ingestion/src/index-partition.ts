/**
 * The index's partition follows the saved choice (BST-1988), for desktop's
 * native index and the browser's file index alike (BST-1940). A saved
 * collection owns the workspace's sources in either mode. With none, TEXT is
 * the TEXT partition: workspace roots only, and sources with no embedding
 * set. Text search needs no model, so no collection is invented for it.
 */
import type {
  IndexFileBinding,
  IndexScope,
  ScopedIndexerPort,
  VectorProfile,
} from '@brainstrike/indexer';
import type {
  CollectionPort,
  SourceCatalogPort,
  WorkspaceRootRecord,
} from '@brainstrike/state-store';
import {
  decodeNativeCanonicalCatalogRecords,
  type NativeCanonicalCatalogRecord,
} from './canonical-catalog.js';
import type { NativeIndexSettings } from './index-settings.js';
import type { CanonicalFileIdentity } from './ports.js';

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

/**
 * A root the saved settings index: a live one, and a managed worktree only
 * once it is opted in. Worktrees default to off, so parallel checkouts of
 * one repository are not each indexed unasked.
 */
export function isPartitionRoot(
  root: Pick<WorkspaceRootRecord, 'id' | 'kind' | 'status'>,
  { worktreeOptIns }: Pick<NativeIndexSettings, 'worktreeOptIns'>
): boolean {
  return root.status === 'live' && (root.kind !== 'worktree' || worktreeOptIns.has(root.id));
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

/**
 * The saved partition's catalog records: the collection's, or with none the
 * TEXT partition's, of the authorized roots only.
 */
export async function loadPartitionRecords(
  catalog: SourceCatalogPort,
  { managedCollectionId }: SavedPartition,
  hasRoot: (rootId: string) => boolean,
  assertCurrent: () => void
): Promise<readonly NativeCanonicalCatalogRecord[]> {
  assertCurrent();
  const result = await catalog.sourceCatalog({
    embeddingSetId: managedCollectionId,
    operation: 'inventory',
  });
  assertCurrent();
  const records = decodeNativeCanonicalCatalogRecords(result.files);
  if (
    records.some((record) => record.embeddingSetId !== managedCollectionId) ||
    new Set(records.map((record) => record.fileId)).size !== records.length
  ) {
    throw new Error('Canonical catalog returned duplicated or unauthorized file identities.');
  }
  // Retained rows of disconnected or ungranted folders remain outside this
  // leased authority until that same canonical root is connected again (BST-1990).
  return records.filter((record) =>
    record.rootId === null ? managedCollectionId !== null : hasRoot(record.rootId)
  );
}

export interface PartitionAuthority {
  readonly fileBindings: readonly IndexFileBinding[];
  readonly rootIds: readonly string[];
  readonly scopes: readonly IndexScope[];
}

/**
 * The index's authority over the saved partition: the authorized roots' scopes
 * and the collection's, and each record bound with the partition's profile.
 */
export function partitionAuthority(input: {
  readonly identity: (record: NativeCanonicalCatalogRecord) => CanonicalFileIdentity;
  readonly profile: VectorProfile | null;
  readonly records: readonly NativeCanonicalCatalogRecord[];
  readonly rootIds: readonly string[];
  readonly settings: SavedPartition;
}): PartitionAuthority {
  const rootIds = [...input.rootIds].sort();
  return {
    fileBindings: input.records.map((record) => {
      const { fileName: _fileName, ...binding } = input.identity(record);
      return { ...binding, profile: input.profile };
    }),
    rootIds,
    scopes: partitionScopes(rootIds, input.settings),
  };
}

export function workspaceRemoval(file: IndexFileBinding): {
  readonly fileId: string;
  readonly scope: Extract<IndexScope, { kind: 'workspace' }>;
} {
  if (file.rootId === null) {
    throw new Error('Outgoing file has no original workspace scope.');
  }
  return { fileId: file.fileId, scope: { kind: 'workspace', rootId: file.rootId } };
}

/** An unowned stored row, bound only so the writer will remove it. */
function unownedBinding(
  row: {
    readonly fileId: string;
    readonly relativePath: string | null;
    readonly rootId: string | null;
    readonly sourcePath: string | null;
  },
  scope: IndexScope,
  collectionProfile: IndexFileBinding['profile']
): IndexFileBinding {
  return scope.kind === 'workspace'
    ? {
        embeddingSetId: null,
        fileId: row.fileId,
        profile: null,
        relativePath: row.relativePath,
        rootId: row.rootId,
        sourcePath: row.sourcePath,
      }
    : {
        embeddingSetId: scope.embeddingSetId,
        fileId: row.fileId,
        profile: collectionProfile,
        relativePath: null,
        rootId: null,
        sourcePath: row.sourcePath,
      };
}

function unownedRemoval(file: IndexFileBinding): {
  readonly fileId: string;
  readonly scope: IndexScope;
} {
  if (file.rootId !== null) {
    return workspaceRemoval(file);
  }
  if (file.embeddingSetId === null) {
    throw new Error('An unowned row has no removal scope.');
  }
  return {
    fileId: file.fileId,
    scope: { embeddingSetId: file.embeddingSetId, kind: 'collection' },
  };
}

/**
 * An opened writer's scopes hold exactly the rows its bindings own (BST-1988,
 * BST-2011). A workspace scope's store rows are every file under that root, and a
 * collection's every file of that collection, whatever the folder; the writer
 * only acts on bound files. Rows from another partition, from a folder
 * disconnected with its data kept, or retired while no writer was open would
 * otherwise stay unbound and keep a manifest incomplete. Each is bound from its
 * own stored row and removed: a leased folder's row under its folder, any other
 * as a rootless row of its collection. They are derived rows; Postgres sources,
 * and a kept folder's one id, stay. A manifest must declare every file bound in
 * its scope, so stored rows are listed with no binding held; no reader is
 * installed until this returns.
 */
export async function retireUnownedRows(
  port: Pick<
    ScopedIndexerPort,
    'removeScopedFile' | 'replaceFileBindings' | 'verifyScopedManifest'
  >,
  requested: PartitionAuthority,
  selected?: ReadonlySet<string>
): Promise<void> {
  if (requested.scopes.length === 0) {
    return;
  }
  const roots = new Set(
    requested.scopes.flatMap((scope) => (scope.kind === 'workspace' ? [scope.rootId] : []))
  );
  const collections = new Set(
    requested.scopes.flatMap((scope) => (scope.kind === 'collection' ? [scope.embeddingSetId] : []))
  );
  const held = requested.fileBindings.some(
    (file) =>
      (file.rootId !== null && roots.has(file.rootId)) ||
      (file.embeddingSetId !== null && collections.has(file.embeddingSetId))
  );
  if (held) {
    await port.replaceFileBindings([]);
  }
  const owned = new Set(requested.fileBindings.map((file) => file.fileId));
  const unowned = new Map<string, IndexFileBinding>();
  // Folders first, so a leased folder's row is removed under its folder.
  const folderFirst = [...requested.scopes].sort(
    (left, right) => Number(left.kind !== 'workspace') - Number(right.kind !== 'workspace')
  );
  for (const scope of folderFirst) {
    const profile =
      scope.kind === 'collection'
        ? (requested.fileBindings.find((file) => file.embeddingSetId === scope.embeddingSetId)
            ?.profile ?? null)
        : null;
    const stored = await port.verifyScopedManifest({ files: [], scope });
    for (const row of stored.unexpected) {
      if (
        (!selected || selected.has(row.fileId)) &&
        !(owned.has(row.fileId) || unowned.has(row.fileId))
      ) {
        unowned.set(row.fileId, unownedBinding(row, scope, profile));
      }
    }
  }
  if (unowned.size > 0) {
    await port.replaceFileBindings([...requested.fileBindings, ...unowned.values()]);
    for (const file of unowned.values()) {
      await port.removeScopedFile(unownedRemoval(file));
    }
  }
  if (held || unowned.size > 0) {
    await port.replaceFileBindings(requested.fileBindings);
  }
}
