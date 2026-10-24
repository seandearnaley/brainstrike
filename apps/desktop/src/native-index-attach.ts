import path from 'node:path';
import type {
  CanonicalWorkspaceLease,
  NativeCanonicalCatalogRecord,
} from '@brainstrike/canonical-ingestion';

/**
 * A catalog record's canonical identity under the generation's root leases: its
 * relative path resolved inside its root's actual mount.
 */
export function nativeFileIdentity(
  leases: ReadonlyMap<string, CanonicalWorkspaceLease>,
  record: NativeCanonicalCatalogRecord
) {
  const lease = record.rootId === null ? undefined : leases.get(record.rootId);
  const relativePath = record.path;
  if (
    !lease ||
    relativePath === null ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Canonical catalog file has no current mounted relative-path authority.');
  }
  lease.signal.throwIfAborted();
  return {
    embeddingSetId: record.embeddingSetId,
    fileId: record.fileId,
    fileName: record.fileName,
    relativePath,
    rootId: lease.rootId,
    sourcePath: path.join(lease.canonicalPath, ...relativePath.split('/')),
  };
}
