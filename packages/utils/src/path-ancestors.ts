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

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path;
}

function getParentDirectoryPath(path: string): string | null {
  const normalizedPath = normalizePath(path);
  if (normalizedPath === '/') {
    return null;
  }
  const separatorIndex = normalizedPath.lastIndexOf('/');

  if (separatorIndex < 0) {
    return null;
  }
  if (separatorIndex === 0) {
    return '/';
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

  const parentPath = getParentDirectoryPath(normalizedDirectoryPath);
  const chain = parentPath ? [...buildAncestorDirectoryChain(parentPath, options)] : [];

  if (normalizedDirectoryPath !== '/' || options.includeRoot) {
    chain.push(normalizedDirectoryPath);
  }

  cache?.set(normalizedDirectoryPath, chain);
  return chain;
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
