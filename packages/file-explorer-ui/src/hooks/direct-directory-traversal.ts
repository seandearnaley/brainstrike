import type { IFileNode } from '@brainstrike/types';

export interface DirectDirectoryTraversalOptions {
  getDirectoryByPath: (path: string) => IFileNode | undefined;
  isActive: () => boolean;
  loadDirectoryPath: (path: string) => Promise<void>;
  maxDirectories?: number;
  onProgress?: ((loaded: number, total: number) => void) | undefined;
}

export interface DirectDirectoryTraversalResult {
  cancelled: boolean;
  discoveredPaths: Set<string>;
  loaded: number;
  total: number;
  visitedPaths: string[];
}

const DEFAULT_MAX_DIRECTORIES = 100_000;

function assertDirectoryTraversalWithinLimit(
  discoveredCount: number,
  maxDirectories: number
): void {
  if (discoveredCount > maxDirectories) {
    throw new Error(`Directory traversal limit exceeded (${maxDirectories})`);
  }
}

function enqueueChildDirectories(
  node: IFileNode,
  queue: string[],
  discoveredPaths: Set<string>,
  maxDirectories: number
): number {
  let added = 0;
  for (const child of node.children ?? []) {
    if (child.type !== 'directory' || discoveredPaths.has(child.path)) {
      continue;
    }
    discoveredPaths.add(child.path);
    assertDirectoryTraversalWithinLimit(discoveredPaths.size, maxDirectories);
    queue.push(child.path);
    added += 1;
  }
  return added;
}

function isReadyDirectoryNode(node: IFileNode | undefined): node is IFileNode {
  return Boolean(node && node.type === 'directory' && node.loadState === 'loaded');
}

export async function traverseDirectoriesDirect(
  initialPaths: string[],
  options: DirectDirectoryTraversalOptions
): Promise<DirectDirectoryTraversalResult> {
  const {
    getDirectoryByPath,
    isActive,
    loadDirectoryPath,
    maxDirectories = DEFAULT_MAX_DIRECTORIES,
    onProgress,
  } = options;
  const queue = [...initialPaths];
  let queueIndex = 0;
  const discoveredPaths = new Set(queue);
  assertDirectoryTraversalWithinLimit(discoveredPaths.size, maxDirectories);
  const visitedPaths: string[] = [];
  let loaded = 0;
  let total = queue.length;

  onProgress?.(loaded, total);

  while (queueIndex < queue.length) {
    if (!isActive()) {
      return { cancelled: true, discoveredPaths, loaded, total, visitedPaths };
    }

    const currentPath = queue[queueIndex++];
    if (!currentPath) {
      continue;
    }

    visitedPaths.push(currentPath);
    let currentNode = getDirectoryByPath(currentPath);
    if (!(currentNode && currentNode.type === 'directory')) {
      loaded += 1;
      onProgress?.(loaded, total);
      continue;
    }

    if (currentNode.loadState !== 'loaded') {
      await loadDirectoryPath(currentPath);
      if (!isActive()) {
        return { cancelled: true, discoveredPaths, loaded, total, visitedPaths };
      }
      currentNode = getDirectoryByPath(currentPath);
    }

    if (!isReadyDirectoryNode(currentNode)) {
      loaded += 1;
      onProgress?.(loaded, total);
      continue;
    }

    total += enqueueChildDirectories(currentNode, queue, discoveredPaths, maxDirectories);
    loaded += 1;
    onProgress?.(loaded, total);
  }

  return {
    cancelled: false,
    discoveredPaths,
    loaded,
    total,
    visitedPaths,
  };
}
