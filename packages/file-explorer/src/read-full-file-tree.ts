import { fileNodeToDirectoryHandle } from '@brainstrike/file-system/file-node-handles';
import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { IGNORED_PATHS } from '@brainstrike/types';

const CONTEXT_IGNORED_PATH_SEGMENTS = [
  ...IGNORED_PATHS,
  '.turbo',
  'coverage',
  '.nyc_output',
] as const;

export interface ReadFullFileTreeOptions {
  maxDepth?: number;
  rootFolderId?: string;
}

interface TraversalState {
  depth: number;
  maxDepth: number;
  rootFolderId: string;
  visitedPaths: Set<string>;
}

function pathHasSegment(path: string, segment: string): boolean {
  let segmentStart = 0;

  while (segmentStart <= path.length) {
    const segmentEnd = path.indexOf('/', segmentStart);
    const end = segmentEnd === -1 ? path.length : segmentEnd;

    if (end - segmentStart === segment.length && path.startsWith(segment, segmentStart)) {
      return true;
    }
    if (segmentEnd === -1) {
      return false;
    }
    segmentStart = segmentEnd + 1;
  }

  return false;
}

function shouldIgnorePath(path: string): boolean {
  const normalizedPath = path.replace(/\/+/g, '/').replace(/^\/+/, '');
  return CONTEXT_IGNORED_PATH_SEGMENTS.some((segment) => pathHasSegment(normalizedPath, segment));
}

function createFileNodeBase(node: IFileNode, state: TraversalState): IFileNode {
  return {
    ...node,
    depth: state.depth,
    isDepthTruncated: false,
    isSymbolicLink: false,
    rootFolderId: state.rootFolderId,
    selectionState: 'unchecked',
  };
}

function createChildDirectoryHandle(node: IFileNode, parent: DirectoryHandle): DirectoryHandle {
  return fileNodeToDirectoryHandle(node, parent.rootId);
}

async function processDirectoryNode(
  adapter: FileSystemAdapter,
  parentHandle: DirectoryHandle,
  node: IFileNode,
  state: TraversalState
): Promise<IFileNode> {
  const baseNode = createFileNodeBase(node, state);

  if (state.depth >= state.maxDepth - 1) {
    return { ...baseNode, children: [], isDepthTruncated: true };
  }

  if (state.visitedPaths.has(node.path)) {
    return { ...baseNode, children: [], isSymbolicLink: true };
  }

  const children = await readDirectoryTree(
    adapter,
    createChildDirectoryHandle(node, parentHandle),
    {
      ...state,
      depth: state.depth + 1,
    }
  );

  return { ...baseNode, children };
}

async function readDirectoryTree(
  adapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle,
  state: TraversalState
): Promise<IFileNode[]> {
  const currentPath = directoryHandle.path;
  if (state.visitedPaths.has(currentPath)) {
    return [];
  }

  let directoryContents: IFileNode[];
  try {
    directoryContents = await adapter.readDirectory(directoryHandle);
  } catch (error) {
    throw new Error(
      `Failed to read directory contents while generating context: ${directoryHandle.path}`,
      { cause: error }
    );
  }

  const nextState = {
    ...state,
    visitedPaths: new Set(state.visitedPaths).add(currentPath),
  };
  const entries: IFileNode[] = [];

  for (const node of directoryContents) {
    if (shouldIgnorePath(node.path)) {
      continue;
    }

    if (node.type === 'file') {
      entries.push(createFileNodeBase(node, nextState));
      continue;
    }

    if (node.type === 'directory') {
      entries.push(await processDirectoryNode(adapter, directoryHandle, node, nextState));
    }
  }

  return entries;
}

/** Read an adapter-backed directory tree for context generation. */
export async function readFullFileTree(
  adapter: FileSystemAdapter,
  rootDirectoryHandle: DirectoryHandle,
  options: ReadFullFileTreeOptions = {}
): Promise<IFileNode[]> {
  return readDirectoryTree(adapter, rootDirectoryHandle, {
    depth: 0,
    maxDepth: options.maxDepth ?? 30,
    rootFolderId: options.rootFolderId ?? rootDirectoryHandle.name,
    visitedPaths: new Set(),
  });
}
