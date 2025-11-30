/**
 * Mock data for file system testing.
 * Used by both main process (IPC handlers) and E2E tests.
 */

export const TEST_DIRECTORY_PATH = '/mock/test/directory';
export const TEST_DIRECTORY_HANDLE_ID = 'mock-directory-handle';

// Using a looser type here to avoid strict dependency on IFileNode which might need FileSystemHandle
export type SerializableFileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  depth: number;
  selectionState: 'unchecked';
  rootFolderId: string;
  handle: {
    id: string;
    kind: 'file' | 'directory';
    name: string;
    path: string;
    platform: 'electron';
  };
  children?: SerializableFileNode[];
};

/**
 * Returns a mock directory structure for testing purposes.
 * This structure is used to simulate file system responses in tests
 * without accessing the actual file system.
 */
export function getTestDirectoryStructure(
  rootPath: string = TEST_DIRECTORY_PATH
): SerializableFileNode[] {
  return [
    {
      name: 'mock-file1.txt',
      path: `${rootPath}/mock-file1.txt`,
      type: 'file',
      size: 100,
      depth: 1,
      selectionState: 'unchecked',
      rootFolderId: TEST_DIRECTORY_HANDLE_ID,
      handle: {
        id: 'mock-file-1',
        kind: 'file',
        name: 'mock-file1.txt',
        path: `${rootPath}/mock-file1.txt`,
        platform: 'electron',
      },
    },
    {
      name: 'mock-file2.ts',
      path: `${rootPath}/mock-file2.ts`,
      type: 'file',
      size: 250,
      depth: 1,
      selectionState: 'unchecked',
      rootFolderId: TEST_DIRECTORY_HANDLE_ID,
      handle: {
        id: 'mock-file-2',
        kind: 'file',
        name: 'mock-file2.ts',
        path: `${rootPath}/mock-file2.ts`,
        platform: 'electron',
      },
    },
    {
      name: 'mock-subfolder',
      path: `${rootPath}/mock-subfolder`,
      type: 'directory',
      depth: 1,
      selectionState: 'unchecked',
      rootFolderId: TEST_DIRECTORY_HANDLE_ID,
      handle: {
        id: 'mock-subfolder',
        kind: 'directory',
        name: 'mock-subfolder',
        path: `${rootPath}/mock-subfolder`,
        platform: 'electron',
      },
      children: [],
    },
  ];
}
