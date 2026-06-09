import type { DirectoryLoadState, IFileNode } from '@brainstrike/types';
import { isDescendantPath } from '@brainstrike/utils';

export interface NormalizedFileTreeNode extends Omit<IFileNode, 'children'> {}

export interface NormalizedFileTreeState {
  childPathsByPath: Map<string, string[]>;
  descendantFileCountByPath: Map<string, number>;
  nodeByPath: Map<string, NormalizedFileTreeNode>;
  parentPathByPath: Map<string, string | null>;
  rootPaths: string[];
}

export interface NormalizedDirectoryChildrenUpdate {
  children: IFileNode[];
  loadState?: Extract<DirectoryLoadState, 'loaded'>;
  path: string;
}

interface TraversalFrame {
  node: IFileNode;
  parentPath: string | null;
  visited: boolean;
}

interface MaterializeFrame {
  path: string;
  visited: boolean;
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

function addFileNodeToState(
  state: NormalizedFileTreeState,
  node: IFileNode,
  parentPath: string | null
): void {
  state.nodeByPath.set(node.path, cloneNode(node));
  state.parentPathByPath.set(node.path, parentPath);
  state.childPathsByPath.delete(node.path);
  state.descendantFileCountByPath.set(node.path, 0);
}

function finalizeDirectoryNode(
  state: NormalizedFileTreeState,
  node: IFileNode & { type: 'directory' }
): void {
  const childPaths = (node.children ?? []).map((child) => child.path);
  let descendantFileCount = 0;
  for (const childPath of childPaths) {
    const childNode = state.nodeByPath.get(childPath);
    if (!childNode) {
      continue;
    }
    descendantFileCount +=
      childNode.type === 'file' ? 1 : (state.descendantFileCountByPath.get(childPath) ?? 0);
  }

  state.childPathsByPath.set(node.path, childPaths);
  state.descendantFileCountByPath.set(node.path, descendantFileCount);
}

function isDirectoryNode(node: IFileNode): node is IFileNode & { type: 'directory' } {
  return node.type === 'directory';
}

function addSubtree(
  state: NormalizedFileTreeState,
  node: IFileNode,
  parentPath: string | null
): number {
  const traversalStack: TraversalFrame[] = [{ node, parentPath, visited: false }];

  while (traversalStack.length > 0) {
    const frame = traversalStack.pop();
    if (!frame) {
      continue;
    }

    const currentNode = frame.node;
    if (!frame.visited) {
      if (currentNode.type !== 'directory') {
        addFileNodeToState(state, currentNode, frame.parentPath);
        continue;
      }

      state.nodeByPath.set(currentNode.path, cloneNode(currentNode));
      state.parentPathByPath.set(currentNode.path, frame.parentPath);

      traversalStack.push({ ...frame, visited: true });
      const children = currentNode.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (!child) {
          continue;
        }
        traversalStack.push({
          node: child,
          parentPath: currentNode.path,
          visited: false,
        });
      }
      continue;
    }

    if (isDirectoryNode(currentNode)) {
      finalizeDirectoryNode(state, currentNode);
    }
  }

  return node.type === 'file' ? 1 : (state.descendantFileCountByPath.get(node.path) ?? 0);
}

export function createNormalizedFileTreeState(nodes: IFileNode[]): NormalizedFileTreeState {
  const state = createBaseState();
  state.rootPaths = nodes.map((node) => node.path);

  for (const node of nodes) {
    addSubtree(state, node, null);
  }

  return state;
}

function materializeFileNode(state: NormalizedFileTreeState, path: string): IFileNode | undefined {
  const node = state.nodeByPath.get(path);
  return node?.type === 'file' ? { ...node } : undefined;
}

function materializeDirectoryNode(
  state: NormalizedFileTreeState,
  path: string,
  materializedNodes: Map<string, IFileNode>
): IFileNode | undefined {
  const node = state.nodeByPath.get(path);
  if (!(node && node.type === 'directory')) {
    return;
  }

  const childPaths = state.childPathsByPath.get(path) ?? [];
  const children = childPaths
    .map((childPath) => materializedNodes.get(childPath))
    .filter((child): child is IFileNode => child !== undefined);

  return children.length > 0 ? { ...node, children } : { ...node };
}

function queueDirectoryChildrenForMaterialization(
  state: NormalizedFileTreeState,
  path: string,
  traversalStack: MaterializeFrame[]
): void {
  traversalStack.push({ path, visited: true });
  const childPaths = state.childPathsByPath.get(path) ?? [];
  for (let index = childPaths.length - 1; index >= 0; index -= 1) {
    const childPath = childPaths[index];
    if (!childPath) {
      continue;
    }
    traversalStack.push({ path: childPath, visited: false });
  }
}

function handleUnvisitedMaterializeFrame(
  state: NormalizedFileTreeState,
  frame: MaterializeFrame,
  node: NormalizedFileTreeNode,
  materializedNodes: Map<string, IFileNode>,
  traversalStack: MaterializeFrame[]
): void {
  if (node.type !== 'directory') {
    const materializedFileNode = materializeFileNode(state, frame.path);
    if (materializedFileNode) {
      materializedNodes.set(frame.path, materializedFileNode);
    }
    return;
  }

  queueDirectoryChildrenForMaterialization(state, frame.path, traversalStack);
}

function materializeNode(state: NormalizedFileTreeState, path: string): IFileNode | undefined {
  const materializedNodes = new Map<string, IFileNode>();
  const traversalStack: MaterializeFrame[] = [{ path, visited: false }];

  while (traversalStack.length > 0) {
    const frame = traversalStack.pop();
    if (!frame) {
      continue;
    }

    const node = state.nodeByPath.get(frame.path);
    if (!node) {
      continue;
    }

    if (!frame.visited) {
      handleUnvisitedMaterializeFrame(state, frame, node, materializedNodes, traversalStack);
      continue;
    }

    const materializedDirectoryNode = materializeDirectoryNode(
      state,
      frame.path,
      materializedNodes
    );
    if (materializedDirectoryNode) {
      materializedNodes.set(frame.path, materializedDirectoryNode);
    }
  }

  return materializedNodes.get(path);
}

export function materializeNormalizedNode(
  state: NormalizedFileTreeState,
  path: string
): IFileNode | undefined {
  const node = state.nodeByPath.get(path);
  if (!node) {
    return;
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
    return;
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

function isPathWithinSubtree(rootPath: string, path: string): boolean {
  return path === rootPath || isDescendantPath(path, rootPath);
}

function collectSubtreePaths(state: NormalizedFileTreeState, path: string, out: string[]): void {
  const stack = [path];
  const visitedPaths = new Set<string>();
  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath || visitedPaths.has(currentPath)) {
      continue;
    }
    visitedPaths.add(currentPath);
    out.push(currentPath);
    const childPaths = state.childPathsByPath.get(currentPath) ?? [];
    for (let index = childPaths.length - 1; index >= 0; index -= 1) {
      const childPath = childPaths[index];
      if (!(childPath && isPathWithinSubtree(path, childPath))) {
        continue;
      }
      stack.push(childPath);
    }
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

function replaceDirectoryChildrenInPlace(
  state: NormalizedFileTreeState,
  path: string,
  children: IFileNode[],
  loadState: DirectoryLoadState = 'loaded'
): boolean {
  const currentNode = state.nodeByPath.get(path);
  if (!(currentNode && currentNode.type === 'directory')) {
    return false;
  }

  const { loadError: _loadError, ...directoryNode } = currentNode;

  for (const childPath of state.childPathsByPath.get(path) ?? []) {
    if (!isPathWithinSubtree(path, childPath)) {
      continue;
    }
    removeSubtree(state, childPath);
  }

  state.childPathsByPath.set(
    path,
    children.map((child) => child.path)
  );
  state.nodeByPath.set(path, {
    ...directoryNode,
    loadState,
  });

  for (const child of children) {
    addSubtree(state, child, path);
  }

  recomputeDescendantFileCountsFrom(state, path);
  return true;
}

export function replaceNormalizedDirectoryChildren(
  state: NormalizedFileTreeState,
  path: string,
  children: IFileNode[],
  loadState: DirectoryLoadState = 'loaded'
): NormalizedFileTreeState {
  const nextState = cloneState(state);
  return replaceDirectoryChildrenInPlace(nextState, path, children, loadState) ? nextState : state;
}

export function applyNormalizedDirectoryChildrenUpdates(
  state: NormalizedFileTreeState,
  updates: readonly NormalizedDirectoryChildrenUpdate[]
): NormalizedFileTreeState {
  if (updates.length === 0) {
    return state;
  }

  const nextState = cloneState(state);
  let changed = false;
  const parentFirstUpdates = [...updates].sort(
    (left, right) => left.path.length - right.path.length
  );
  for (const update of parentFirstUpdates) {
    const updateApplied = replaceDirectoryChildrenInPlace(
      nextState,
      update.path,
      update.children,
      update.loadState ?? 'loaded'
    );
    changed ||= updateApplied;
  }

  return changed ? nextState : state;
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

  const nextNodeByPath = new Map(state.nodeByPath);
  if (loadError === undefined) {
    const { loadError: _existingLoadError, ...directoryNode } = currentNode;
    nextNodeByPath.set(path, {
      ...directoryNode,
      loadState,
    });
  } else {
    nextNodeByPath.set(path, {
      ...currentNode,
      loadError,
      loadState,
    });
  }
  return {
    rootPaths: state.rootPaths,
    nodeByPath: nextNodeByPath,
    childPathsByPath: state.childPathsByPath,
    parentPathByPath: state.parentPathByPath,
    descendantFileCountByPath: state.descendantFileCountByPath,
  };
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

    for (const childPath of state.childPathsByPath.get(currentPath) ?? []) {
      queue.push(childPath);
    }
  }

  return filePaths;
}

export function getNormalizedParentPath(
  state: NormalizedFileTreeState,
  path: string
): string | null | undefined {
  return state.parentPathByPath.get(path);
}
