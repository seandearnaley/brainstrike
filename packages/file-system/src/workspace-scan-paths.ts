import type { FileSystemChange } from '@brainstrike/types';
import {
  isAbsoluteFileSystemPath,
  normalizeSelectionPathForFolder,
} from '@brainstrike/utils/relative-file-path';

/**
 * Path semantics for the Workspace Index scan.
 *
 * These are the pure, side-effect-free helpers that decide how watcher paths,
 * root paths and cached relative paths line up. They are split out from the
 * scan itself so the conversion rules can be read (and tested) without the
 * surrounding traversal, adapter and invalidation machinery.
 */

const SLASH_CHAR_CODE = 47;

export function toSlashPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '');
}

export function joinRootRelativePath(rootPath: string, relativePath: string): string {
  const normalizedRoot = toSlashPath(rootPath);
  return `${normalizedRoot}/${relativePath.replace(/^\/+/u, '')}`;
}

export function getPathName(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end -= 1;
  }
  if (end === 0) {
    return path;
  }
  const separatorIndex = path.lastIndexOf('/', end - 1);
  return path.slice(separatorIndex + 1, end);
}

export function countRelativePathSegments(path: string): number {
  let count = 0;
  let inSegment = false;
  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) === SLASH_CHAR_CODE) {
      inSegment = false;
      continue;
    }
    if (inSegment) {
      continue;
    }
    count += 1;
    inSegment = true;
  }
  return count;
}

export function* iterRelativePathSegments(path: string): IterableIterator<string> {
  let start = 0;
  while (start < path.length) {
    while (start < path.length && path.charCodeAt(start) === SLASH_CHAR_CODE) {
      start += 1;
    }
    if (start >= path.length) {
      return;
    }
    let end = path.indexOf('/', start);
    if (end === -1) {
      end = path.length;
    }
    // Directory change resolution may run for many watcher paths; scanning here
    // avoids split/filter arrays while preserving empty-segment skipping.
    yield path.slice(start, end);
    start = end + 1;
  }
}

export function getParentRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/\/+$/u, '');
  const separatorIndex = normalized.lastIndexOf('/');
  return separatorIndex === -1 ? null : normalized.slice(0, separatorIndex);
}

export function normalizeScopedChangePath(change: FileSystemChange, rootPath: string): string {
  const normalizedPath = change.path.replace(/\\/g, '/');
  const normalizedRoot = toSlashPath(rootPath);
  if (isAbsoluteFileSystemPath(normalizedPath)) {
    const pathLower = normalizedPath.toLowerCase();
    const rootLower = normalizedRoot.toLowerCase();
    if (!(pathLower === rootLower || pathLower.startsWith(`${rootLower}/`))) {
      throw new Error(`Workspace Index watcher path is outside the active root: ${change.path}`);
    }
  }
  return normalizeSelectionPathForFolder(normalizedPath, rootPath, {
    label: 'Workspace Index watcher path',
  });
}

export function isRootSelfPath(path: string, rootPath: string): boolean {
  return toSlashPath(path.replace(/\\/g, '/')) === toSlashPath(rootPath);
}

export function isUnderRelativePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Anchor a scoped change's path to the active root, WITHOUT double-prefixing.
 *
 * The managed-cache identity and the node path coincide on web and diverge on
 * desktop, because `normalizeSelectionPathForFolder` only strips a prefix it
 * recognizes as absolute. A desktop root path is absolute, so the identity is
 * genuinely root-relative ('nested/a.ts') and must be joined back on. A web
 * root path is the picked folder's bare NAME, so nothing is stripped and the
 * identity is already root-anchored ('workspace/nested/a.ts') — joining it
 * again yields 'workspace/workspace/nested/a.ts', a row no full scan can ever
 * match.
 *
 * Checking anchoring rather than platform keeps this unambiguous even when the
 * root contains a child directory sharing the root's name: on web that file's
 * identity is 'workspace/workspace/a.ts', which is already anchored and is
 * returned unchanged.
 */
export function toRootAnchoredPath(rootPath: string, cacheRelativePath: string): string {
  const normalizedRoot = toSlashPath(rootPath);
  const normalized = toSlashPath(cacheRelativePath.replace(/\\/g, '/'));
  if (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized;
  }
  return joinRootRelativePath(normalizedRoot, normalized);
}

/**
 * The path of a node relative to the ROOT HANDLE — what a handle-walking
 * adapter needs, and not the same string as the managed-cache identity on web
 * (see `toRootAnchoredPath`). Returns '' for the root itself.
 */
export function toRootRelativePath(rootPath: string, nodePath: string): string {
  const normalizedRoot = toSlashPath(rootPath);
  const normalized = toSlashPath(nodePath.replace(/\\/g, '/'));
  if (normalized === normalizedRoot) {
    return '';
  }
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

/**
 * Convert the walker's absolute truncated-directory paths into root-relative
 * prefixes ('' = the root itself) for absence-inference guards.
 */
export function toTruncatedRelativePrefixes(
  truncatedDirectoryPaths: ReadonlySet<string>,
  rootPath: string
): string[] {
  const prefixes = new Set<string>();
  for (const path of truncatedDirectoryPaths) {
    if (toSlashPath(path.replace(/\\/g, '/')) === toSlashPath(rootPath)) {
      prefixes.add('');
      continue;
    }
    prefixes.add(
      normalizeSelectionPathForFolder(path, rootPath, {
        label: 'Workspace Index truncated directory path',
      })
    );
  }
  return [...prefixes];
}

export function isUnderTruncatedDirectory(
  relativePath: string,
  truncatedDirectoryPrefixes: readonly string[]
): boolean {
  return truncatedDirectoryPrefixes.some(
    (prefix) => prefix === '' || relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  );
}
