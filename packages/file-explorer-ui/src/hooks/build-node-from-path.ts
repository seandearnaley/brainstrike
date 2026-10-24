import type { IFileNode } from '@brainstrike/types';
import { isSeparatorCode, isWindowsPath } from '@brainstrike/utils/path-ancestors';

/**
 * Build minimal node info from a path and root info. Names and depth follow the
 * path's own grammar, so a Windows path splits at `\` as well as `/`.
 */
export function buildNodeFromPath(
  path: string,
  rootPath: string,
  rootFolderId: string,
  handle: IFileNode['handle']
): IFileNode {
  const windows = isWindowsPath(path);
  const isSeparator = (value: string, index: number) =>
    isSeparatorCode(value.charCodeAt(index), windows);
  const normalizedRootPath =
    rootPath.length > 1 && isSeparator(rootPath, rootPath.length - 1)
      ? rootPath.slice(0, -1)
      : rootPath;

  let relativePath = path;
  if (
    path === normalizedRootPath ||
    // Check the next byte before startsWith so "/rootExtra" does not match "/root".
    (path.length > normalizedRootPath.length &&
      isSeparator(path, normalizedRootPath.length) &&
      path.startsWith(normalizedRootPath))
  ) {
    relativePath = path.slice(normalizedRootPath.length);
  }

  let end = relativePath.length;
  if (end > 0 && isSeparator(relativePath, end - 1)) {
    end -= 1;
  }

  let lastSeparatorIndex = -1;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (isSeparator(relativePath, i)) {
      lastSeparatorIndex = i;
      break;
    }
  }
  const name = relativePath.slice(lastSeparatorIndex + 1, end);

  // An unstripped absolute path counts its segments below its own root.
  let start = windows && /^[A-Za-z]:/u.test(relativePath) ? 3 : 0;
  if (start === 0 && relativePath.length > 0 && isSeparator(relativePath, 0)) {
    start = 1;
  }
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    if (isSeparator(relativePath, i)) {
      depth += 1;
    }
  }

  return {
    depth,
    handle,
    name,
    path,
    rootFolderId,
    selectionState: 'unchecked',
    type: 'directory',
  };
}
