import type { CanonicalFileIdentity } from '@brainstrike/canonical-ingestion/browser';
import { webRootPath } from '@brainstrike/web-state-store';

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
