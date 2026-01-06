import type { FileNodeType, IFileNode, SelectionState } from '@brainstrike/types';
import { vi } from 'vitest';

type BaseNodeOptions = {
  name: string;
  path: string;
  depth?: number;
  selectionState?: SelectionState;
  rootFolderId?: string;
  isVisible?: boolean;
  children?: IFileNode[];
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
};

export function createFileNode({
  name = 'test.txt',
  path = `/${name}`,
  depth = 0,
  selectionState = 'unchecked',
  rootFolderId = 'test-folder',
  isVisible = true,
  handle,
}: Partial<BaseNodeOptions> = {}): IFileNode {
  const mockHandle =
    handle ||
    ({
      kind: 'file' as const,
      name,
      getFile: vi.fn().mockResolvedValue(new File([], name)),
      createWritable: vi.fn(),
      isSameEntry: vi.fn(),
    } as unknown as FileSystemFileHandle);

  return {
    name,
    path,
    type: 'file' as FileNodeType,
    handle: mockHandle,
    depth,
    selectionState,
    rootFolderId,
    isVisible,
  };
}

export function createDirectoryNode({
  name = 'test-directory',
  path = `/${name}`,
  depth = 0,
  selectionState = 'unchecked',
  rootFolderId = 'test-folder',
  isVisible = true,
  children = [],
}: Partial<BaseNodeOptions> = {}): IFileNode {
  const mockHandle = {
    kind: 'directory' as const,
    name,
    entries: vi.fn().mockResolvedValue([]),
    getDirectoryHandle: vi.fn(),
    getFileHandle: vi.fn(),
    removeEntry: vi.fn(),
    resolve: vi.fn(),
    isSameEntry: vi.fn(),
  } as unknown as FileSystemDirectoryHandle;

  return {
    name,
    path,
    type: 'directory' as FileNodeType,
    handle: mockHandle,
    depth,
    selectionState,
    children,
    rootFolderId,
    isVisible,
  };
}

/**
 * Creates a nested directory structure for testing
 */
export function createNestedDirectoryStructure(
  basePath = '/',
  depth = 3,
  filesPerLevel = 2
): IFileNode {
  const createLevel = (currentPath: string, currentDepth: number): IFileNode => {
    if (currentDepth === 0) {
      return createDirectoryNode({
        name: currentPath.split('/').pop() || 'root',
        path: currentPath,
        children: Array.from({ length: filesPerLevel }, (_, i) =>
          createFileNode({
            name: `file${i}.txt`,
            path: `${currentPath}/file${i}.txt`,
            depth: depth - currentDepth,
          })
        ),
        depth: depth - currentDepth,
      });
    }

    const children: IFileNode[] = [
      // Add files at this level
      ...Array.from({ length: filesPerLevel }, (_, i) =>
        createFileNode({
          name: `file${i}.txt`,
          path: `${currentPath}/file${i}.txt`,
          depth: depth - currentDepth,
        })
      ),
      // Add subdirectories
      createLevel(`${currentPath}/subdir${currentDepth}`, currentDepth - 1),
    ];

    return createDirectoryNode({
      name: currentPath.split('/').pop() || 'root',
      path: currentPath,
      children,
      depth: depth - currentDepth,
    });
  };

  return createLevel(basePath, depth);
}

/**
 * Creates a file tree structure from a simple object representation
 */
export function createFileTreeFromStructure(
  structure: Record<string, unknown>,
  parentPath = '',
  depth = 0
): IFileNode[] {
  return Object.entries(structure).map(([name, value]) => {
    const path = parentPath ? `${parentPath}/${name}` : name;

    if (value === null) {
      return createFileNode({
        name,
        path,
        depth,
      });
    }

    return createDirectoryNode({
      name,
      path,
      depth,
      children: createFileTreeFromStructure(value as Record<string, unknown>, path, depth + 1),
    });
  });
}

/**
 * Configuration for large tree generation (BST-145 perf testing)
 */
export type LargeTreeConfig = {
  /** Target total node count (approximate) */
  targetNodeCount: number;
  /** Maximum directory depth */
  maxDepth: number;
  /** Average files per directory */
  filesPerDir: number;
  /** Average subdirectories per directory */
  subdirsPerDir: number;
};

/**
 * Default configurations for perf testing
 *
 * Node count formula: For depth d with f files and s subdirs per dir:
 * Total ≈ sum_{i=0}^{d} s^i * (1 + f) = (1 + f) * (s^(d+1) - 1) / (s - 1)
 */
export const largeTreePresets = {
  /** ~90 nodes - quick smoke test */
  small: { targetNodeCount: 100, maxDepth: 4, filesPerDir: 5, subdirsPerDir: 2 },
  /** ~726 nodes - typical project */
  medium: { targetNodeCount: 700, maxDepth: 5, filesPerDir: 5, subdirsPerDir: 3 },
  /** ~7029 nodes - large project */
  large: { targetNodeCount: 7000, maxDepth: 5, filesPerDir: 8, subdirsPerDir: 5 },
  /** ~27342 nodes - repo-scale stress test */
  repoScale: { targetNodeCount: 27_000, maxDepth: 6, filesPerDir: 6, subdirsPerDir: 5 },
  /** ~84000 nodes - BST-149 mega stress test */
  mega: { targetNodeCount: 84_000, maxDepth: 6, filesPerDir: 8, subdirsPerDir: 6 },
} as const;

/**
 * Generates a large file tree for performance testing (BST-145).
 *
 * Creates a tree with configurable node count and structure.
 * Uses breadth-first generation to achieve target node count more accurately.
 *
 * @example
 * ```ts
 * // Use preset
 * const tree = generateLargeTree(largeTreePresets.medium);
 *
 * // Custom config
 * const tree = generateLargeTree({ targetNodeCount: 500, maxDepth: 4, filesPerDir: 4, subdirsPerDir: 2 });
 * ```
 */
export function generateLargeTree(config: LargeTreeConfig): {
  tree: IFileNode[];
  nodeCount: number;
} {
  const { targetNodeCount, maxDepth, filesPerDir, subdirsPerDir } = config;

  // Calculate depth needed to reach target node count
  // Formula: dirs = subdirsPerDir^d, files per dir = filesPerDir
  // Total nodes ≈ sum(dirs at each level) + sum(files at each level)
  let estimatedDepth = 1;
  let estimatedNodes = 1 + filesPerDir; // root dir + its files
  let dirsAtLevel = 1;

  while (estimatedNodes < targetNodeCount && estimatedDepth < maxDepth) {
    dirsAtLevel *= subdirsPerDir;
    estimatedNodes += dirsAtLevel * (1 + filesPerDir); // each subdir + its files
    estimatedDepth++;
  }

  const effectiveDepth = Math.min(estimatedDepth, maxDepth);

  // Generate with calculated depth
  const generateDirWithDepth = (path: string, depth: number, maxD: number): IFileNode => {
    const name = path.split('/').pop() || 'root';
    const children: IFileNode[] = [];

    for (let i = 0; i < filesPerDir; i++) {
      children.push(
        createFileNode({
          name: `file-${i}.ts`,
          path: `${path}/file-${i}.ts`,
          depth,
        })
      );
    }

    if (depth < maxD) {
      for (let i = 0; i < subdirsPerDir; i++) {
        const subdirPath = `${path}/dir-${i}`;
        children.push(generateDirWithDepth(subdirPath, depth + 1, maxD));
      }
    }

    return createDirectoryNode({
      name,
      path,
      depth: depth - 1,
      children,
    });
  };

  const tree = [generateDirWithDepth('root', 1, effectiveDepth)];

  // Count actual nodes
  const countNodes = (nodes: IFileNode[]): number => {
    let count = 0;
    for (const node of nodes) {
      count++;
      if (node.type === 'directory' && node.children) {
        count += countNodes(node.children);
      }
    }
    return count;
  };

  return { tree, nodeCount: countNodes(tree) };
}

/**
 * Generates a flat list of all nodes in a tree (for counting/verification)
 */
export function flattenTreeForCount(nodes: IFileNode[]): IFileNode[] {
  const result: IFileNode[] = [];
  const traverse = (node: IFileNode): void => {
    result.push(node);
    if (node.type === 'directory' && node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  };
  for (const node of nodes) {
    traverse(node);
  }
  return result;
}
