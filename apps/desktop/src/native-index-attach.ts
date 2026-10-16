import path from 'node:path';
import type {
  CanonicalWorkspaceLease,
  NativeCanonicalCatalogRecord,
} from '@brainstrike/canonical-ingestion';

/**
 * A catalog record's canonical identity under the generation's root leases: a
 * rootless collection file keeps its source path; a rooted file resolves its
 * relative path inside its root's actual mount.
 */
export function nativeFileIdentity(
  leases: ReadonlyMap<string, CanonicalWorkspaceLease>,
  record: NativeCanonicalCatalogRecord
) {
  if (record.rootId === null) {
    return {
      embeddingSetId: record.embeddingSetId,
      fileId: record.fileId,
      fileName: record.fileName,
      relativePath: null,
      rootId: null,
      sourcePath: record.path,
    };
  }
  const lease = leases.get(record.rootId);
  if (
    !lease ||
    record.path === null ||
    path.posix.isAbsolute(record.path) ||
    record.path.includes('\\') ||
    record.path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Canonical catalog file has no current mounted relative-path authority.');
  }
  lease.signal.throwIfAborted();
  return {
    embeddingSetId: record.embeddingSetId,
    fileId: record.fileId,
    fileName: record.fileName,
    relativePath: record.path,
    rootId: record.rootId,
    sourcePath: path.join(lease.canonicalPath, ...record.path.split('/')),
  };
}
