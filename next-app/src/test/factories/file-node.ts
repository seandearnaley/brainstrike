import type { IFileNode, SelectionState } from '@/lib/file/types';

interface BaseNodeOptions {
  name: string;
  path: string;
  depth?: number;
  selectionState?: SelectionState;
  rootFolderId?: string;
}

interface FileNodeOptions extends BaseNodeOptions {
  handle?: FileSystemFileHandle;
}

interface DirectoryNodeOptions extends BaseNodeOptions {
  children?: IFileNode[];
  handle?: FileSystemDirectoryHandle;
}

/**
 * Creates a mock file node for testing
 */
export function createFileNode({
  name,
  path,
  depth = 0,
  selectionState = 'unchecked',
  handle,
  rootFolderId = 'test-folder',
}: FileNodeOptions): IFileNode {
  const mockHandle: FileSystemFileHandle = handle ?? {
    kind: 'file' as const,
    name,
    getFile: jest.fn().mockResolvedValue(new File([], name)),
    createWritable: jest.fn(),
    isSameEntry: jest.fn(),
  };

  return {
    name,
    path,
    type: 'file',
    depth,
    selectionState,
    handle: mockHandle,
    rootFolderId,
  };
}

/**
 * Creates a mock directory node for testing
 */
export function createDirectoryNode({
  name,
  path,
  depth = 0,
  selectionState = 'unchecked',
  children = [],
  handle,
  rootFolderId = 'test-folder',
}: DirectoryNodeOptions): IFileNode {
  const mockHandle: FileSystemDirectoryHandle =
    handle ??
    ({
      kind: 'directory' as const,
      name,
      entries: jest.fn(),
      getDirectoryHandle: jest.fn(),
      getFileHandle: jest.fn(),
      removeEntry: jest.fn(),
      resolve: jest.fn(),
      isSameEntry: jest.fn(),
    } as unknown as FileSystemDirectoryHandle);

  return {
    name,
    path,
    type: 'directory',
    depth,
    selectionState,
    children,
    handle: mockHandle,
    rootFolderId,
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
