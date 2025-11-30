import type { IFileNode } from '@brainstrike/types';
import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '../types';

export type MockFileEntry = {
  name: string;
  type: 'file' | 'directory';
  content?: string;
  size?: number;
  children?: Record<string, MockFileEntry>;
};

// Navigation helper functions
function navigateToPath(
  mockFileSystem: Record<string, MockFileEntry>,
  basePath: string
): Record<string, MockFileEntry> | null {
  if (!basePath) {
    return mockFileSystem;
  }

  let currentLevel = mockFileSystem;
  const pathParts = basePath.split('/');

  for (const part of pathParts) {
    const entry = currentLevel[part];
    if (!entry || entry.type !== 'directory' || !entry.children) {
      return null;
    }
    currentLevel = entry.children;
  }

  return currentLevel;
}

function addEntryToPath(
  mockFileSystem: Record<string, MockFileEntry>,
  path: string,
  entry: MockFileEntry
): void {
  const pathParts = path.split('/');
  let current = mockFileSystem;

  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    if (!part) {
      continue;
    }

    if (!current[part]) {
      current[part] = {
        name: part,
        type: 'directory',
        children: {},
      };
    }
    current = current[part].children ?? {};
  }

  const fileName = pathParts.at(-1);
  if (fileName) {
    current[fileName] = entry;
  }
}

function checkPathExists(
  mockFileSystem: Record<string, MockFileEntry>,
  relativePath: string
): boolean {
  const pathParts = relativePath.split('/');
  let current = mockFileSystem;

  for (const part of pathParts) {
    if (!current[part]) {
      return false;
    }
    if (current[part].type === 'directory' && current[part].children) {
      current = current[part].children;
    }
  }

  return true;
}

// File node creation helper functions
function createFileNode(
  name: string,
  entry: MockFileEntry,
  fullPath: string,
  selectedDirectory: string
): IFileNode {
  const baseNode: IFileNode = {
    name,
    path: fullPath,
    type: entry.type,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: selectedDirectory,
    isVisible: true,
    handle: {
      path: fullPath,
      name,
      kind: entry.type,
      platform: 'web',
      _internal: entry,
    } as unknown as FileSystemFileHandle | FileSystemDirectoryHandle,
  };

  if (entry.type === 'file') {
    baseNode.size = entry.size ?? (entry.content?.length || 0);
    baseNode.lastModified = Date.now();
  } else {
    baseNode.children = [];
  }

  return baseNode;
}

function sortFileNodes(entries: IFileNode[]): IFileNode[] {
  return entries.sort((a, b) => {
    // Directories first, then files
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Mock implementation of FileSystemAdapter for testing purposes
 */
export class MockFileSystemAdapter implements FileSystemAdapter {
  private mockFileSystem: Record<string, MockFileEntry> = {};
  private selectedDirectory: string | null = null;

  constructor(mockFileSystem?: Record<string, MockFileEntry>) {
    if (mockFileSystem) {
      this.mockFileSystem = mockFileSystem;
    }
  }

  /**
   * Set the mock file system structure
   */
  setMockFileSystem(fileSystem: Record<string, MockFileEntry>): void {
    this.mockFileSystem = fileSystem;
  }

  /**
   * Add a mock file or directory
   */
  addMockEntry(path: string, entry: MockFileEntry): void {
    addEntryToPath(this.mockFileSystem, path, entry);
  }

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    if (Object.keys(this.mockFileSystem).length === 0) {
      throw new Error('No mock file system configured');
    }

    // Select the first directory as root, or create a virtual root
    const rootName = 'mock-root';
    this.selectedDirectory = rootName;

    return {
      path: rootName,
      name: rootName,
      kind: 'directory',
      platform: 'web',
      _internal: { mockRoot: true },
    };
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    if (!this.selectedDirectory) {
      throw new Error('No directory selected');
    }

    const basePath = this.getRelativePath(handle.path);
    const currentLevel = navigateToPath(this.mockFileSystem, basePath);

    if (!currentLevel) {
      return [];
    }

    const entries: IFileNode[] = [];
    for (const [name, entry] of Object.entries(currentLevel)) {
      const fullPath = basePath ? `${handle.path}/${name}` : `${handle.path}/${name}`;
      const fileNode = createFileNode(name, entry, fullPath, this.selectedDirectory);
      entries.push(fileNode);
    }

    return sortFileNodes(entries);
  }

  async readFile(handle: FileHandle): Promise<string> {
    const mockData = handle._internal as MockFileEntry;
    if (!mockData || mockData.type !== 'file') {
      throw new Error(`File not found: ${handle.path}`);
    }
    return mockData.content ?? '';
  }

  async exists(path: string): Promise<boolean> {
    if (!this.selectedDirectory) {
      return false;
    }

    const relativePath = this.getRelativePath(path);
    return checkPathExists(this.mockFileSystem, relativePath);
  }

  private getRelativePath(path: string): string {
    if (!this.selectedDirectory) {
      return path;
    }

    return path === this.selectedDirectory ? '' : path.replace(`${this.selectedDirectory}/`, '');
  }

  /**
   * Create a simple mock file system for testing
   */
  static createSimpleFileSystem(): Record<string, MockFileEntry> {
    return {
      src: {
        name: 'src',
        type: 'directory',
        children: {
          'index.ts': {
            name: 'index.ts',
            type: 'file',
            content: 'export * from "./components";',
          },
          components: {
            name: 'components',
            type: 'directory',
            children: {
              'Button.tsx': {
                name: 'Button.tsx',
                type: 'file',
                content: 'export const Button = () => <button>Click me</button>;',
              },
              'Input.tsx': {
                name: 'Input.tsx',
                type: 'file',
                content: 'export const Input = () => <input />;',
              },
            },
          },
        },
      },
      'package.json': {
        name: 'package.json',
        type: 'file',
        content: '{"name": "test-package", "version": "1.0.0"}',
      },
      'README.md': {
        name: 'README.md',
        type: 'file',
        content: '# Test Project\n\nThis is a test project.',
      },
    };
  }
}
