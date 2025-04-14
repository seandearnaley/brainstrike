import type LightningFS from '@isomorphic-git/lightning-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyDirectoryToLightningFS, copyGitDirectory } from '../git-utils';

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

  it('handles existing directory without throwing error', async () => {
    // Setup mkdir to throw EEXIST error
    const existsError = new Error('Directory exists');
    // @ts-expect-error - Adding code property for test
    existsError.code = 'EEXIST';
    mockFs.promises.mkdir = vi.fn().mockRejectedValueOnce(existsError).mockResolvedValueOnce(undefined);

    // Create a mock .git directory
    const gitDir = new MockDirectoryHandle('.git');
    const rootDirEntries = new Map<string, FileSystemHandle>([['.git', gitDir]]);
    const rootDir = new MockDirectoryHandle('root', rootDirEntries);

    // Call the function
    await copyDirectoryToLightningFS(rootDir, mockFs as unknown as LightningFS, '/project');

    // Verify mkdir was called for both directories
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/project');
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/project/.git');
  });

  it('propagates critical errors during root directory creation', async () => {
    // Setup mkdir to throw a critical error
    const criticalError = new Error('Permission denied');
    // @ts-expect-error - Adding code property for test
    criticalError.code = 'EACCES';
    mockFs.promises.mkdir = vi.fn().mockRejectedValueOnce(criticalError);

    // Create a mock directory
    const rootDir = new MockDirectoryHandle('root');

    // Call the function and expect it to throw
    await expect(
      copyDirectoryToLightningFS(rootDir, mockFs as unknown as LightningFS, '/project')
    ).rejects.toThrow('Permission denied');

    // Verify console.error was called
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('copyGitDirectory should handle errors during directory creation', async () => {
    // Setup mkdir to throw an error other than EEXIST
    const dirError = new Error('Permission denied');
    // @ts-expect-error - Adding code property for test
    dirError.code = 'EACCES';
    mockFs.promises.mkdir = vi.fn().mockRejectedValueOnce(dirError);

    // Create a source directory
    const sourceDir = new MockDirectoryHandle('source');

    // Call the function and expect it to throw
    await expect(
      copyGitDirectory(mockFs as unknown as LightningFS, sourceDir, '/target')
    ).rejects.toThrow('Permission denied');
  });

  it('copyGitDirectory should handle errors during file writing', async () => {
    // Setup writeFile to throw an error
    const writeError = new Error('Disk full');
    mockFs.promises.writeFile = vi.fn().mockRejectedValueOnce(writeError);

    // Create a mock file in the source directory
    const testFile = new MockFileHandle(
      'test.txt',
      new TextEncoder().encode('test content')
    );

    // Create source directory with the file
    const sourceDirEntries = new Map<string, FileSystemHandle>([['test.txt', testFile]]);
    const sourceDir = new MockDirectoryHandle('source', sourceDirEntries);

    // Call the function and expect it to throw
    await expect(
      copyGitDirectory(mockFs as unknown as LightningFS, sourceDir, '/target')
    ).rejects.toThrow('Disk full');

    // Verify mkdir was called
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/target');
    
    // Verify console.error was called with error about writing file
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error writing file'),
      expect.any(Error)
    );
  });

  it('recursively copies nested directories correctly', async () => {
    // Create a nested structure:
    // source/
    //   subdir/
    //     file.txt

    // Create the file in the nested directory
    const nestedFile = new MockFileHandle(
      'file.txt',
      new TextEncoder().encode('nested file content')
    );

    // Create the nested directory with the file
    const subdirEntries = new Map<string, FileSystemHandle>([['file.txt', nestedFile]]);
    const subdir = new MockDirectoryHandle('subdir', subdirEntries);

    // Create source directory with the nested directory
    const sourceDirEntries = new Map<string, FileSystemHandle>([['subdir', subdir]]);
    const sourceDir = new MockDirectoryHandle('source', sourceDirEntries);

    // Call the function
    await copyGitDirectory(mockFs as unknown as LightningFS, sourceDir, '/target');

    // Verify mkdir was called for both directories
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/target');
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/target/subdir');

    // Verify writeFile was called for the nested file
    expect(mockFs.promises.writeFile).toHaveBeenCalledWith(
      '/target/subdir/file.txt',
      expect.any(Uint8Array)
    );
  });

  it('handles large directory structures with multiple files and directories', async () => {
    // Create multiple files for testing
    const file1 = new MockFileHandle('file1.txt', new TextEncoder().encode('content 1'));
    const file2 = new MockFileHandle('file2.txt', new TextEncoder().encode('content 2'));
    const file3 = new MockFileHandle('file3.txt', new TextEncoder().encode('content 3'));
    
    // Create multiple directories with files
    const subdir1Entries = new Map<string, FileSystemHandle>([['file3.txt', file3]]);
    const subdir1 = new MockDirectoryHandle('subdir1', subdir1Entries);
    
    // Create source directory with multiple entries
    const sourceDirEntries = new Map<string, FileSystemHandle>([
      ['file1.txt', file1],
      ['file2.txt', file2],
      ['subdir1', subdir1],
    ]);
    const sourceDir = new MockDirectoryHandle('source', sourceDirEntries);

    // Call the function
    await copyGitDirectory(mockFs as unknown as LightningFS, sourceDir, '/target');

    // Verify mkdir was called for all directories
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/target');
    expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/target/subdir1');

    // Verify writeFile was called for all files
    expect(mockFs.promises.writeFile).toHaveBeenCalledWith(
      '/target/file1.txt',
      expect.any(Uint8Array)
    );
    expect(mockFs.promises.writeFile).toHaveBeenCalledWith(
      '/target/file2.txt',
      expect.any(Uint8Array)
    );
    expect(mockFs.promises.writeFile).toHaveBeenCalledWith(
      '/target/subdir1/file3.txt',
      expect.any(Uint8Array)
    );

    // Verify the correct number of calls to writeFile
    expect(mockFs.promises.writeFile).toHaveBeenCalledTimes(3);
  });
});
