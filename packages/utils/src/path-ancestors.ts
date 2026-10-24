interface AncestorPathOptions {
  cache?: Map<string, readonly string[]>;
  includeRoot?: boolean;
}

interface AncestorCountOptions {
  cache?: Map<string, readonly string[]>;
  counts?: Map<string, number>;
  delta?: number;
  includeRoot?: boolean;
}

/** A Windows drive or UNC path, whose backslashes are separators too. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/u;
const SLASH = 47;
const BACKSLASH = 92;

/**
 * Whether `path` follows Windows grammar. A path's own grammar decides what
 * separates its segments, never the platform reading it: desktop tree paths are
 * the host's native paths, so a Windows tree is separated by `\`, while a
 * backslash inside a POSIX name is just a character.
 */
export function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(path);
}

/** The last segment separator of `path` at or before `fromIndex`, by its grammar; -1 if none. */
export function lastPathSeparatorIndex(path: string, fromIndex = path.length - 1): number {
  const slash = path.lastIndexOf('/', fromIndex);
  return isWindowsPath(path) ? Math.max(slash, path.lastIndexOf('\\', fromIndex)) : slash;
}

/** Whether the code unit at `index` separates two segments of `path`. */
export function isPathSeparatorAt(path: string, index: number): boolean {
  const code = path.charCodeAt(index);
  return code === SLASH || (code === BACKSLASH && isWindowsPath(path));
}

/** Length of the root a path cannot be walked above: `/`, `C:\` or a UNC path's `\\`. */
function rootLength(path: string): number {
  if (WINDOWS_DRIVE_ROOT.test(path)) {
    return 3;
  }
  if (path.startsWith('\\\\')) {
    return 2;
  }
  return path.startsWith('/') ? 1 : 0;
}

function normalizePath(path: string): string {
  if (path.length > Math.max(1, rootLength(path)) && isPathSeparatorAt(path, path.length - 1)) {
    return path.slice(0, -1);
  }
  return path;
}

function isRootPath(path: string): boolean {
  return path.length > 0 && path.length === rootLength(path);
}

function getParentDirectoryPath(path: string): string | null {
  const normalizedPath = normalizePath(path);
  if (isRootPath(normalizedPath)) {
    return null;
  }
  const separatorIndex = lastPathSeparatorIndex(normalizedPath);

  if (separatorIndex < 0) {
    return null;
  }
  const root = rootLength(normalizedPath);
  if (separatorIndex < root) {
    return normalizedPath.slice(0, root);
  }
  return normalizedPath.slice(0, separatorIndex);
}

function buildAncestorDirectoryChain(
  directoryPath: string,
  options: AncestorPathOptions
): readonly string[] {
  const normalizedDirectoryPath = normalizePath(directoryPath);
  const cache = options.cache;
  const cachedChain = cache?.get(normalizedDirectoryPath);
  if (cachedChain) {
    return cachedChain;
  }

  const missingPaths: string[] = [];
  let currentPath: string | null = normalizedDirectoryPath;
  let cachedParentChain: readonly string[] | undefined;

  while (currentPath) {
    const normalizedCurrentPath = normalizePath(currentPath);
    cachedParentChain = cache?.get(normalizedCurrentPath);
    if (cachedParentChain) {
      break;
    }
    missingPaths.push(normalizedCurrentPath);
    currentPath = getParentDirectoryPath(normalizedCurrentPath);
  }

  // Avoid recursive spread copies for deep trees; recursive selection can ask for
  // ancestor chains across thousands of nested paths.
  const chain = cachedParentChain ? [...cachedParentChain] : [];

  for (let index = missingPaths.length - 1; index >= 0; index -= 1) {
    const path = missingPaths[index] as string;
    if (!isRootPath(path) || options.includeRoot) {
      chain.push(path);
    }

    cache?.set(path, [...chain]);
  }

  return cache?.get(normalizedDirectoryPath) ?? chain;
}

export function getAncestorDirectoryPaths(
  path: string,
  options: AncestorPathOptions = {}
): readonly string[] {
  const parentDirectoryPath = getParentDirectoryPath(path);
  if (!parentDirectoryPath) {
    return [];
  }
  return buildAncestorDirectoryChain(parentDirectoryPath, options);
}

export function accumulateAncestorDirectoryCounts(
  filePaths: Iterable<string>,
  options: AncestorCountOptions = {}
): Map<string, number> {
  const counts = options.counts ?? new Map<string, number>();
  const delta = options.delta ?? 1;
  const ancestorPathOptions: AncestorPathOptions = {
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.includeRoot === undefined ? {} : { includeRoot: options.includeRoot }),
  };

  for (const filePath of filePaths) {
    for (const directoryPath of getAncestorDirectoryPaths(filePath, ancestorPathOptions)) {
      const nextCount = (counts.get(directoryPath) ?? 0) + delta;
      if (nextCount <= 0) {
        counts.delete(directoryPath);
      } else {
        counts.set(directoryPath, nextCount);
      }
    }
  }

  return counts;
}
