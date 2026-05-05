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
  const normalizedRootPath =
    rootPath.length > 1 && rootPath.charCodeAt(rootPath.length - 1) === SLASH
      ? rootPath.slice(0, -1)
      : rootPath;

  let relativePath = path;
  if (
    path === normalizedRootPath ||
    // Check the next byte before startsWith so "/rootExtra" does not match "/root".
    (path.length > normalizedRootPath.length &&
      path.charCodeAt(normalizedRootPath.length) === SLASH &&
      path.startsWith(normalizedRootPath))
  ) {
    relativePath = path.slice(normalizedRootPath.length);
  }

  let end = relativePath.length;
  if (end > 0 && relativePath.charCodeAt(end - 1) === SLASH) {
    end -= 1;
  }

  const lastSlashIndex = end === 0 ? -1 : relativePath.lastIndexOf('/', end - 1);
  const name =
    lastSlashIndex === -1
      ? relativePath.slice(0, end)
      : relativePath.slice(lastSlashIndex + 1, end);

  let depth = 0;
  const start = relativePath.length > 0 && relativePath.charCodeAt(0) === SLASH ? 1 : 0;
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
