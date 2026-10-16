import type { CanonicalFileIdentity } from '@brainstrike/canonical-ingestion/browser';
import type { IndexFileBinding } from '@brainstrike/indexer';
import type { SourceCatalogRecord, WorkspaceRootRecord } from '@brainstrike/state-store';
import { webRootPath } from '@brainstrike/web-state-store';
import type { FileIndexAuthority } from './file-index-protocol';

/**
 * A catalog file's identity in the file index, as desktop's
 * `nativeFileIdentity` gives it: a rooted file by its root-relative path,
 * with its source named under the root's handle key; an import by its path.
 */
export function fileIdentity(file: {
  readonly embeddingSetId: string | null;
  readonly fileId: string;
  readonly fileName: string;
  readonly path: string | null;
  readonly rootId: string | null;
}): CanonicalFileIdentity {
  if (file.rootId === null) {
    return {
      embeddingSetId: file.embeddingSetId,
      fileId: file.fileId,
      fileName: file.fileName,
      relativePath: null,
      rootId: null,
      sourcePath: file.path,
    };
  }
  if (!file.path) {
    throw new Error('A rooted catalog file has no root-relative path.');
  }
  return {
    embeddingSetId: file.embeddingSetId,
    fileId: file.fileId,
    fileName: file.fileName,
    relativePath: file.path,
    rootId: file.rootId,
    sourcePath: `${webRootPath(file.rootId)}/${file.path}`,
  };
}

/**
 * The file index's authority over the writer's catalogs: the live roots,
 * every collection, and the files of either. An import in no collection has
 * no scope the index could authorize it under, so it is left out. The writer
 * opens the index with this; the index worker rebinds to it after the
 * catalog changes, as desktop re-acquires its native index.
 */
export function fileIndexAuthority(
  roots: readonly WorkspaceRootRecord[],
  collectionIds: readonly string[],
  files: readonly SourceCatalogRecord[]
): FileIndexAuthority {
  const live = new Set(roots.filter((root) => root.status === 'live').map((root) => root.id));
  const fileBindings: IndexFileBinding[] = files
    .filter((file) => (file.rootId === null ? file.embeddingSetId !== null : live.has(file.rootId)))
    .map((file) => {
      const { fileName: _fileName, ...binding } = fileIdentity(file);
      return { ...binding, profile: null };
    });
  return {
    fileBindings,
    rootIds: [...live].sort(),
    scopes: collectionIds.map((embeddingSetId) => ({
      embeddingSetId,
      kind: 'collection' as const,
    })),
  };
}
