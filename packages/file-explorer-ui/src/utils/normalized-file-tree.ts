import type { DirectoryLoadState, IFileNode } from '@brainstrike/types';

export interface NormalizedFileTreeNode extends Omit<IFileNode, 'children'> {}

export interface NormalizedFileTreeState {
  childPathsByPath: Map<string, string[]>;
  descendantFileCountByPath: Map<string, number>;
  nodeByPath: Map<string, NormalizedFileTreeNode>;
  parentPathByPath: Map<string, string | null>;
  rootPaths: string[];
}

function createBaseState(): NormalizedFileTreeState {
  return {
    nodeByPath: new Map(),
    childPathsByPath: new Map(),
    parentPathByPath: new Map(),
    descendantFileCountByPath: new Map(),
    rootPaths: [],
  };
}

export function createEmptyNormalizedFileTreeState(): NormalizedFileTreeState {
  return createBaseState();
}

function cloneNode(node: IFileNode): NormalizedFileTreeNode {
  const { children: _children, ...shallowNode } = node;
  return shallowNode;
}

function addSubtree(
  state: NormalizedFileTreeState,
  node: IFileNode,
  parentPath: string | null
): number {
  state.nodeByPath.set(node.path, cloneNode(node));
  state.parentPathByPath.set(node.path, parentPath);

  if (node.type !== 'directory') {
    state.childPathsByPath.delete(node.path);
    state.descendantFileCountByPath.set(node.path, 0);
    return 1;
  }

  const childPaths: string[] = [];
  let descendantFileCount = 0;

  for (const child of node.children ?? []) {
    childPaths.push(child.path);
    descendantFileCount += addSubtree(state, child, node.path);
  }

  state.childPathsByPath.set(node.path, childPaths);
  state.descendantFileCountByPath.set(node.path, descendantFileCount);
  return descendantFileCount;
}

export function createNormalizedFileTreeState(nodes: IFileNode[]): NormalizedFileTreeState {
  const state = createBaseState();
  state.rootPaths = nodes.map((node) => node.path);

  for (const node of nodes) {
    addSubtree(state, node, null);
  }

  return state;
}

function materializeNode(state: NormalizedFileTreeState, path: string): IFileNode | undefined {
  const node = state.nodeByPath.get(path);
  if (!node) {
    return undefined;
  }

  if (node.type !== 'directory') {
    return { ...node };
  }

  const childPaths = state.childPathsByPath.get(path) ?? [];
  const children = childPaths
    .map((childPath) => materializeNode(state, childPath))
    .filter((child): child is IFileNode => child !== undefined);

  return children.length > 0 ? { ...node, children } : { ...node };
}

export function materializeNormalizedNode(
  state: NormalizedFileTreeState,
  path: string
): IFileNode | undefined {
  const node = state.nodeByPath.get(path);
  if (!node) {
    return undefined;
  }
  return { ...node };
}

export function materializeNormalizedFileTree(state: NormalizedFileTreeState): IFileNode[] {
  return state.rootPaths
    .map((rootPath) => materializeNode(state, rootPath))
    .filter((node): node is IFileNode => node !== undefined);
}

export function materializeNormalizedSubtree(
  state: NormalizedFileTreeState,
  path: string
): IFileNode | undefined {
  return materializeNode(state, path);
}

/**
 * Materialize a node with only its immediate children (no recursive descent).
 * Useful for traversals that only need child paths and types (e.g., expand-all).
 */
export function materializeNormalizedShallowNode(
  state: NormalizedFileTreeState,
  path: string
): IFileNode | undefined {
  const node = state.nodeByPath.get(path);
  if (!node) {
    return undefined;
  }
  if (node.type !== 'directory') {
    return { ...node };
  }
  const childPaths = state.childPathsByPath.get(path) ?? [];
  const children = childPaths
    .map((childPath) => {
      const childNode = state.nodeByPath.get(childPath);
      return childNode ? ({ ...childNode } as IFileNode) : undefined;
    })
    .filter((child): child is IFileNode => child !== undefined);

  return children.length > 0 ? { ...node, children } : { ...node };
}

/**
 * Get root directory paths without materializing the full tree.
 * Useful for expand-all which only needs root directory paths to seed traversal.
 */
export function getNormalizedRootDirectoryPaths(state: NormalizedFileTreeState): string[] {
  return state.rootPaths.filter((rootPath) => {
    const node = state.nodeByPath.get(rootPath);
    return node?.type === 'directory';
  });
}

function collectSubtreePaths(state: NormalizedFileTreeState, path: string, out: string[]): void {
  out.push(path);
  for (const childPath of state.childPathsByPath.get(path) ?? []) {
    collectSubtreePaths(state, childPath, out);
  }
}

function removeSubtree(state: NormalizedFileTreeState, path: string): void {
  const subtreePaths: string[] = [];
  collectSubtreePaths(state, path, subtreePaths);

  for (const subtreePath of subtreePaths) {
    state.nodeByPath.delete(subtreePath);
    state.childPathsByPath.delete(subtreePath);
    state.parentPathByPath.delete(subtreePath);
    state.descendantFileCountByPath.delete(subtreePath);
  }
}

function recomputeDescendantFileCountsFrom(
  state: NormalizedFileTreeState,
  startPath: string | null
): void {
  const visitedPaths = new Set<string>();
  let currentPath = startPath;
  while (currentPath && !visitedPaths.has(currentPath)) {
    visitedPaths.add(currentPath);
    const node = state.nodeByPath.get(currentPath);
    if (!node || node.type !== 'directory') {
      currentPath = state.parentPathByPath.get(currentPath) ?? null;
      continue;
    }

    let descendantFileCount = 0;
    for (const childPath of state.childPathsByPath.get(currentPath) ?? []) {
      const childNode = state.nodeByPath.get(childPath);
      if (!childNode) {
        continue;
      }
      descendantFileCount +=
        childNode.type === 'file' ? 1 : (state.descendantFileCountByPath.get(childPath) ?? 0);
    }
    state.descendantFileCountByPath.set(currentPath, descendantFileCount);
    currentPath = state.parentPathByPath.get(currentPath) ?? null;
  }
}

function cloneState(state: NormalizedFileTreeState): NormalizedFileTreeState {
  return {
    rootPaths: [...state.rootPaths],
    nodeByPath: new Map(state.nodeByPath),
    childPathsByPath: new Map(
      Array.from(state.childPathsByPath.entries(), ([path, childPaths]) => [path, [...childPaths]])
    ),
    parentPathByPath: new Map(state.parentPathByPath),
    descendantFileCountByPath: new Map(state.descendantFileCountByPath),
  };
}

function cloneStateWithNodeMap(state: NormalizedFileTreeState): NormalizedFileTreeState {
  return {
    rootPaths: state.rootPaths,
    nodeByPath: new Map(state.nodeByPath),
    childPathsByPath: state.childPathsByPath,
    parentPathByPath: state.parentPathByPath,
    descendantFileCountByPath: state.descendantFileCountByPath,
  };
}

export function replaceNormalizedDirectoryChildren(
  state: NormalizedFileTreeState,
  path: string,
  children: IFileNode[],
  loadState: DirectoryLoadState = 'loaded'
): NormalizedFileTreeState {
  const currentNode = state.nodeByPath.get(path);
  if (!(currentNode && currentNode.type === 'directory')) {
    return state;
  }

  const nextState = cloneState(state);
  const { loadError: _loadError, ...directoryNode } = currentNode;

  for (const childPath of nextState.childPathsByPath.get(path) ?? []) {
    removeSubtree(nextState, childPath);
  }

  nextState.childPathsByPath.set(
    path,
    children.map((child) => child.path)
  );
  nextState.nodeByPath.set(path, {
    ...directoryNode,
    loadState,
  });

  for (const child of children) {
    addSubtree(nextState, child, path);
  }

  recomputeDescendantFileCountsFrom(nextState, path);
  return nextState;
}

export function setNormalizedNodeLoadState(
  state: NormalizedFileTreeState,
  path: string,
  loadState: DirectoryLoadState,
  loadError?: string
): NormalizedFileTreeState {
  const currentNode = state.nodeByPath.get(path);
  if (!(currentNode && currentNode.type === 'directory')) {
    return state;
  }

  const nextState = cloneStateWithNodeMap(state);
  if (loadError !== undefined) {
    nextState.nodeByPath.set(path, {
      ...currentNode,
      loadError,
      loadState,
    });
  } else {
    const { loadError: _existingLoadError, ...directoryNode } = currentNode;
    nextState.nodeByPath.set(path, {
      ...directoryNode,
      loadState,
    });
  }
  return nextState;
}

export function getNormalizedNode(
  state: NormalizedFileTreeState,
  path: string
): NormalizedFileTreeNode | undefined {
  return state.nodeByPath.get(path);
}

export function getNormalizedChildPaths(
  state: NormalizedFileTreeState,
  path: string | null
): string[] {
  if (path === null) {
    return state.rootPaths;
  }
  return state.childPathsByPath.get(path) ?? [];
}

export function getNormalizedDescendantFileCount(
  state: NormalizedFileTreeState,
  path: string
): number {
  const node = state.nodeByPath.get(path);
  if (!node) {
    return 0;
  }
  if (node.type === 'file') {
    return 1;
  }
  return state.descendantFileCountByPath.get(path) ?? 0;
}

export function listNormalizedDescendantFilePaths(
  state: NormalizedFileTreeState,
  path: string,
  maxCount?: number
): string[] {
  const rootNode = state.nodeByPath.get(path);
  if (!rootNode) {
    return [];
  }
  if (rootNode.type === 'file') {
    return [path];
  }

  const filePaths: string[] = [];
  const queue = [...(state.childPathsByPath.get(path) ?? [])];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    if (maxCount !== undefined && filePaths.length >= maxCount) {
      break;
    }

    const currentPath = queue[queueIndex++];
    if (!currentPath) {
      continue;
    }
    const node = state.nodeByPath.get(currentPath);
    if (!node) {
      continue;
    }

    if (node.type === 'file') {
      filePaths.push(node.path);
      continue;
    }

    queue.push(...(state.childPathsByPath.get(currentPath) ?? []));
  }

  return filePaths;
}

export function getNormalizedParentPath(
  state: NormalizedFileTreeState,
  path: string
): string | null | undefined {
  return state.parentPathByPath.get(path);
}
