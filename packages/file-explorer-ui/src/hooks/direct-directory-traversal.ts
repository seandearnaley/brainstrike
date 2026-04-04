import type { IFileNode } from '@brainstrike/types';

export interface DirectDirectoryTraversalOptions {
  getDirectoryByPath: (path: string) => IFileNode | undefined;
  isActive: () => boolean;
  loadDirectoryPath: (path: string) => Promise<void>;
  onProgress?: ((loaded: number, total: number) => void) | undefined;
}

export interface DirectDirectoryTraversalResult {
  cancelled: boolean;
  discoveredPaths: Set<string>;
  loaded: number;
  total: number;
  visitedPaths: string[];
}

function enqueueChildDirectories(
  node: IFileNode,
  queue: string[],
  discoveredPaths: Set<string>
): number {
  let added = 0;
  for (const child of node.children ?? []) {
    if (child.type !== 'directory' || discoveredPaths.has(child.path)) {
      continue;
    }
    discoveredPaths.add(child.path);
    queue.push(child.path);
    added += 1;
  }
  return added;
}

export async function traverseDirectoriesDirect(
  initialPaths: string[],
  options: DirectDirectoryTraversalOptions
): Promise<DirectDirectoryTraversalResult> {
  const { getDirectoryByPath, isActive, loadDirectoryPath, onProgress } = options;
  const queue = [...initialPaths];
  const discoveredPaths = new Set(queue);
  const visitedPaths: string[] = [];
  let loaded = 0;
  let total = queue.length;

  onProgress?.(loaded, total);

  while (queue.length > 0) {
    if (!isActive()) {
      return { cancelled: true, discoveredPaths, loaded, total, visitedPaths };
    }

    const currentPath = queue.shift();
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

    if (currentNode?.type === 'directory') {
      total += enqueueChildDirectories(currentNode, queue, discoveredPaths);
    }

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
