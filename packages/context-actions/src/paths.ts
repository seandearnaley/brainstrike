const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || WINDOWS_DRIVE_PATH.test(path);
}

/**
 * Strips `rootPath` from an absolute `path`. Relative paths (web file nodes)
 * pass through unchanged. An absolute path outside the root also passes
 * through unchanged rather than guessing.
 */
export function toRelativePath(path: string, rootPath: string): string {
  if (!isAbsolutePath(path)) {
    return path;
  }
  const separator = path.includes('\\') ? '\\' : '/';
  const prefix = rootPath.endsWith(separator) ? rootPath : `${rootPath}${separator}`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
