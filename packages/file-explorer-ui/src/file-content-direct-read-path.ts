/** Whether an adapter can read an absolute path without a materialized tree. */
export function supportsDirectPathRead(fileSystemAdapter: unknown): boolean {
  const adapter = fileSystemAdapter as { readFileByPath?: unknown };
  return typeof adapter.readFileByPath === 'function';
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function isAbsolutePathLike(value: string): boolean {
  const normalized = normalizePathSeparators(value);
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isPathWithinFolder(absolutePath: string, folderId: string): boolean {
  const normalizedPath = trimTrailingSlashes(normalizePathSeparators(absolutePath));
  const normalizedFolder = trimTrailingSlashes(normalizePathSeparators(folderId));
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

export function resolveDirectReadPath(folderId: string, selectionPath: string): string | null {
  const normalizedFolder = trimTrailingSlashes(normalizePathSeparators(folderId));
  if (!isAbsolutePathLike(normalizedFolder)) {
    return null;
  }

  const normalizedPath = normalizePathSeparators(selectionPath);
  if (isAbsolutePathLike(normalizedPath) && isPathWithinFolder(normalizedPath, normalizedFolder)) {
    return normalizedPath;
  }

  const relativePath = normalizedPath.replace(/^\/+/, '');
  return relativePath.length > 0 ? `${normalizedFolder}/${relativePath}` : normalizedFolder;
}
