import type { IFileNode } from '@brainstrike/types';
import { defaultCollator } from '@brainstrike/utils';
import type {
  DirectoryHandle,
  DirectoryStreamCallback,
  FileHandle,
  FileSystemAdapter,
  StreamingDirectoryReadOptions,
} from '../types';

export interface MockFileEntry {
  children?: Record<string, MockFileEntry>;
  content?: string;
  name: string;
  size?: number;
  type: 'file' | 'directory';
}

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
    if (entry?.type !== 'directory' || !entry.children) {
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
        children: {},
        name: part,
        type: 'directory',
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
    depth: 0,
    handle: {
      _internal: entry,
      kind: entry.type,
      name,
      path: fullPath,
      platform: 'web',
    } as unknown as FileSystemFileHandle | FileSystemDirectoryHandle,
    isVisible: true,
    name,
    path: fullPath,
    rootFolderId: selectedDirectory,
    selectionState: 'unchecked',
    type: entry.type,
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
    return defaultCollator.compare(a.name, b.name);
  });
}

/**
 * Mock implementation of FileSystemAdapter for testing purposes
 */
export class MockFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'web' as const;
  private mockFileSystem: Record<string, MockFileEntry> = {};
  private selectedDirectory: string | null = null;
  /** Delay between streaming batches (ms). Set to 0 for instant delivery in tests. */
  private streamingDelay = 0;

  constructor(mockFileSystem?: Record<string, MockFileEntry>) {
    if (mockFileSystem) {
      this.mockFileSystem = mockFileSystem;
    }
  }

  /**
   * Set the delay between streaming batches (for testing progressive loading).
   * @param delayMs - Delay in milliseconds (0 = instant)
   */
  setStreamingDelay(delayMs: number): void {
    this.streamingDelay = delayMs;
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
      _internal: { mockRoot: true },
      kind: 'directory',
      name: rootName,
      path: rootName,
      platform: 'web',
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
    if (mockData?.type !== 'file') {
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

  /**
   * Streaming version of readDirectory that delivers results in batches.
   * Simulates progressive loading for testing purposes.
   *
   * @param handle - The directory handle to read
   * @param onBatch - Callback for each batch of results
   * @param options - Streaming options (batchSize defaults to 50)
   */
  async readDirectoryStreaming(
    handle: DirectoryHandle,
    onBatch: DirectoryStreamCallback,
    options?: StreamingDirectoryReadOptions
  ): Promise<void> {
    const signal = options?.signal;
    signal?.throwIfAborted();

    if (!this.selectedDirectory) {
      throw new Error('No directory selected');
    }

    const batchSize = options?.batchSize ?? 50;
    const basePath = this.getRelativePath(handle.path);
    const currentLevel = navigateToPath(this.mockFileSystem, basePath);

    if (!currentLevel) {
      onBatch([], { done: true, total: 0 });
      return;
    }

    const allEntries: IFileNode[] = [];
    for (const [name, entry] of Object.entries(currentLevel)) {
      const fullPath = basePath ? `${handle.path}/${name}` : `${handle.path}/${name}`;
      const fileNode = createFileNode(name, entry, fullPath, this.selectedDirectory);
      allEntries.push(fileNode);
    }

    const sortedEntries = sortFileNodes(allEntries);
    const total = sortedEntries.length;

    // Deliver in batches
    for (let i = 0; i < total; i += batchSize) {
      signal?.throwIfAborted();

      const batch = sortedEntries.slice(i, i + batchSize);
      const isDone = i + batchSize >= total;
      onBatch(batch, { done: isDone, total });

      // Small delay to simulate async I/O (can be disabled in tests)
      if (!isDone && this.streamingDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.streamingDelay));
      }
      if (!isDone) {
        signal?.throwIfAborted();
      }
    }

    // Handle empty directory
    if (total === 0) {
      signal?.throwIfAborted();
      onBatch([], { done: true, total: 0 });
    }
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
      'package.json': {
        content: '{"name": "test-package", "version": "1.0.0"}',
        name: 'package.json',
        type: 'file',
      },
      'README.md': {
        content: '# Test Project\n\nThis is a test project.',
        name: 'README.md',
        type: 'file',
      },
      src: {
        children: {
          components: {
            children: {
              'Button.tsx': {
                content: 'export const Button = () => <button>Click me</button>;',
                name: 'Button.tsx',
                type: 'file',
              },
              'Input.tsx': {
                content: 'export const Input = () => <input />;',
                name: 'Input.tsx',
                type: 'file',
              },
            },
            name: 'components',
            type: 'directory',
          },
          'index.ts': {
            content: 'export * from "./components";',
            name: 'index.ts',
            type: 'file',
          },
        },
        name: 'src',
        type: 'directory',
      },
    };
  }
}
