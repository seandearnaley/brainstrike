import type LightningFS from '@isomorphic-git/lightning-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyDirectoryToLightningFS } from '../git-utils';

// Define missing types
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

// Define simplified types for the fs stats
interface StatResult {
  size: number;
  mode: number;
  mtime: Date;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

// Mock FileSystemDirectoryHandle and related interfaces
class MockDirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory';
  readonly name: string;
  private entriesMap: Map<string, FileSystemHandle>;

  constructor(name: string, entries: Map<string, FileSystemHandle> = new Map()) {
    this.name = name;
    this.entriesMap = entries;
  }

  async getDirectoryHandle(
    name: string,
    _options?: { create?: boolean }
  ): Promise<FileSystemDirectoryHandle> {
    const entry = this.entriesMap.get(name);
    if (entry && entry.kind === 'directory') {
      return entry as FileSystemDirectoryHandle;
    }
    throw new Error(`Directory ${name} not found`);
  }

  async getFileHandle(
    name: string,
    _options?: { create?: boolean }
  ): Promise<FileSystemFileHandle> {
    const entry = this.entriesMap.get(name);
    if (entry && entry.kind === 'file') {
      return entry as FileSystemFileHandle;
    }
    throw new Error(`File ${name} not found`);
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }): Promise<void> {
    if (!this.entriesMap.has(name)) {
      throw new Error(`Entry ${name} not found`);
    }
    this.entriesMap.delete(name);
  }

  async resolve(_possibleDescendant: FileSystemHandle): Promise<string[]> {
    return [];
  }

  // Implements entries() method required for for-await-of
  entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    const iterator = this.entriesMap.entries();
    return {
      next: async () => iterator.next(),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  // OPFS interface implementation (not used in tests)
  isSameEntry(_other: FileSystemHandle): Promise<boolean> {
    return Promise.resolve(false);
  }

  queryPermission(_descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState> {
    return Promise.resolve('granted');
  }

  requestPermission(_descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState> {
    return Promise.resolve('granted');
  }
}

// Mock FileSystemFileHandle
class MockFileHandle implements FileSystemFileHandle {
  readonly kind = 'file';
  readonly name: string;
  private content: Uint8Array;

  constructor(name: string, content: Uint8Array = new Uint8Array()) {
    this.name = name;
    this.content = content;
  }

  async getFile(): Promise<File> {
    return {
      arrayBuffer: async () => this.content.buffer,
      size: this.content.length,
      slice: () => new Blob(),
      stream: () => new ReadableStream(),
      text: async () => new TextDecoder().decode(this.content),
      type: '',
      name: this.name,
      lastModified: Date.now(),
    } as File;
  }

  async createWritable(
    _options?: FileSystemCreateWritableOptions
  ): Promise<FileSystemWritableFileStream> {
    return {} as FileSystemWritableFileStream;
  }

  async isSameEntry(_other: FileSystemHandle): Promise<boolean> {
    return false;
  }

  async queryPermission(
    _descriptor?: FileSystemHandlePermissionDescriptor
  ): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(
    _descriptor?: FileSystemHandlePermissionDescriptor
  ): Promise<PermissionState> {
    return 'granted';
  }
}

// Define a simplified PromisifiedFS for the mocks
interface PromisifiedFS {
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  // Include minimal required properties to satisfy the type
  rmdir?: (path: string) => Promise<void>;
  readFile?: (path: string) => Promise<Uint8Array>;
  unlink?: (path: string) => Promise<void>;
  stat?: (path: string) => Promise<StatResult>;
  lstat?: (path: string) => Promise<StatResult>;
  readlink?: (path: string) => Promise<string>;
  symlink?: (target: string, path: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
}

type MockFS = {
  promises: PromisifiedFS;
};

type SpyInstance = ReturnType<typeof vi.spyOn>;

describe('git-utils', () => {
  let mockFs: MockFS;
  let consoleSpy: SpyInstance;

  beforeEach(() => {
    // Create mock LightningFS
    mockFs = {
      promises: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        readdir: vi.fn().mockResolvedValue([]),
      },
    };

    // Spy on console.error
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockRestore();
  });

  it('creates directories and copies files correctly', async () => {
    // Create a mock file in the .git directory
    const configFile = new MockFileHandle(
      'config',
      new TextEncoder().encode('sample config content')
    );

    // Create a mock directory in the .git directory
    const objectsDir = new MockDirectoryHandle('objects');

    // Create .git directory with the file and subdirectory
    const gitDirEntries = new Map<string, FileSystemHandle>([
      ['config', configFile],
      ['objects', objectsDir],
    ]);
    const gitDir = new MockDirectoryHandle('.git', gitDirEntries);

    // Create root directory with .git directory
    const rootDirEntries = new Map<string, FileSystemHandle>([['.git', gitDir]]);
    const rootDir = new MockDirectoryHandle('root', rootDirEntries);

    // Call the function
    await copyDirectoryToLightningFS(rootDir, mockFs as unknown as LightningFS, '/project');

    // Verify mkdir was called for project and .git directories
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/project');
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/project/.git');

    // Verify writeFile was called for the config file
    expect(mockFs.promises.writeFile).toHaveBeenCalledWith(
      '/project/.git/config',
      expect.any(Uint8Array)
    );
  });

  it('handles errors when .git directory is not found', async () => {
    // Create a root directory without .git directory
    const rootDir = new MockDirectoryHandle('root');

    // Call the function and expect it to throw
    await expect(
      copyDirectoryToLightningFS(rootDir, mockFs as unknown as LightningFS, '/project')
    ).rejects.toThrow();

    // Verify mkdir was still called for project directory
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/project');

    // Verify console.error was called
    expect(consoleSpy).toHaveBeenCalled();
  });
});
