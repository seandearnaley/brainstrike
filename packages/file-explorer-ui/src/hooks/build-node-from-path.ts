import type { IFileNode } from '@brainstrike/types';

/** Character code for '/' used in low-level path parsing */
const SLASH = 47;

/**
 * Build minimal node info from a path and root info.
 */
export function buildNodeFromPath(
  path: string,
  rootPath: string,
  rootFolderId: string,
  handle: FileSystemDirectoryHandle
): IFileNode {
  let relativePath = path;
  if (path.startsWith(rootPath)) {
    relativePath = path.slice(rootPath.length);
  }

  let searchEnd = relativePath.length;
  if (searchEnd > 0 && relativePath.charCodeAt(searchEnd - 1) === SLASH) {
    searchEnd -= 1;
  }

  const lastSlashIndex = relativePath.lastIndexOf('/', searchEnd - 1);
  const name =
    lastSlashIndex !== -1
      ? relativePath.slice(lastSlashIndex + 1, searchEnd)
      : relativePath.slice(0, searchEnd);

  let depth = 0;
  const start = relativePath.length > 0 && relativePath.charCodeAt(0) === SLASH ? 1 : 0;
  const end =
    relativePath.length > 1 && relativePath.charCodeAt(relativePath.length - 1) === SLASH
      ? relativePath.length - 1
      : relativePath.length;
  for (let i = start; i < end; i += 1) {
    if (relativePath.charCodeAt(i) === SLASH) {
      depth += 1;
    }
  }

  return {
    name,
    path,
    type: 'directory',
    depth,
    rootFolderId,
    handle,
    selectionState: 'unchecked',
  };
}
