import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileSystem } from '../file-system';
import { stableHash } from '../hash-utils';

// Mock the hash utility
vi.mock('../hash-utils', () => ({
  stableHash: vi.fn().mockImplementation(async (input: string) => `hash-${input}`),
}));

// Mock the logger
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('fileSystem', () => {
  // Mock directory handles
  let mockDirectoryHandle1: FileSystemDirectoryHandle;
  let mockDirectoryHandle2: FileSystemDirectoryHandle;
  let mockFileHandle: FileSystemFileHandle;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock directory handles
    mockDirectoryHandle1 = {
      kind: 'directory',
      name: 'testDir',
      entries: vi.fn().mockImplementation(function* () {}),
      getDirectoryHandle: vi.fn(),
      getFileHandle: vi.fn(),
      removeEntry: vi.fn(),
      resolve: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;

    mockDirectoryHandle2 = {
      kind: 'directory',
      name: 'testDir',
      entries: vi.fn().mockImplementation(function* () {}),
      getDirectoryHandle: vi.fn(),
      getFileHandle: vi.fn(),
      removeEntry: vi.fn(),
      resolve: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;

    mockFileHandle = {
      kind: 'file',
      name: 'testFile.txt',
      getFile: vi.fn().mockResolvedValue({
        text: vi.fn().mockResolvedValue('test content'),
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
        size: 100,
        lastModified: 1_234_567_890,
      }),
    } as unknown as FileSystemFileHandle;
  });

  describe('isSameDirectory', () => {
    it('should use isSameEntry API when available', async () => {
      // Add isSameEntry method to mock
      const isSameEntry = vi.fn().mockResolvedValue(true);
      Object.defineProperty(mockDirectoryHandle1, 'isSameEntry', {
        value: isSameEntry,
        writable: true,
      });

      const result = await fileSystem.isSameDirectory(mockDirectoryHandle1, mockDirectoryHandle2);

      expect(isSameEntry).toHaveBeenCalledWith(mockDirectoryHandle2);
      expect(result).toBe(true);
    });

    it('should fall back to path comparison when isSameEntry is not available', async () => {
      // Mock getFullPath method
      const getFullPathSpy = vi
        .spyOn(fileSystem, 'getFullPath')
        .mockResolvedValueOnce('/path/to/dir1')
        .mockResolvedValueOnce('/path/to/dir1');

      // Add getParent method to both handles
      Object.defineProperty(mockDirectoryHandle1, 'getParent', {
        value: vi.fn(),
      });
      Object.defineProperty(mockDirectoryHandle2, 'getParent', {
        value: vi.fn(),
      });

      const result = await fileSystem.isSameDirectory(mockDirectoryHandle1, mockDirectoryHandle2);

      expect(getFullPathSpy).toHaveBeenCalledTimes(2);
      expect(result).toBe(true);
    });

    it('should compare names as a last resort', async () => {
      // Test with same name
      const result = await fileSystem.isSameDirectory(mockDirectoryHandle1, mockDirectoryHandle2);
      expect(result).toBe(true);

      // Create a new handle with a different name for testing
      const differentNameHandle = {
        ...mockDirectoryHandle2,
        name: 'differentName',
      } as unknown as FileSystemDirectoryHandle;

      const resultDifferent = await fileSystem.isSameDirectory(
        mockDirectoryHandle1,
        differentNameHandle
      );
      expect(resultDifferent).toBe(false);
    });

    it('should warn and compare names when isSameEntry throws and no path info', async () => {
      Object.defineProperty(mockDirectoryHandle1, 'isSameEntry', {
        value: vi.fn().mockRejectedValue(new Error('boom')),
      });

      // Do not provide getParent so path comparison is skipped

      const result = await fileSystem.isSameDirectory(mockDirectoryHandle1, mockDirectoryHandle2);

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  describe('getFullPath', () => {
    it('should get the full path of a directory handle', async () => {
      const parent = {
        kind: 'directory',
        name: 'parent',
        getParent: vi.fn().mockResolvedValue(null),
      };

      // Setup nested directories structure
      const getParentMock = vi.fn().mockResolvedValue(parent);
      Object.defineProperty(mockDirectoryHandle1, 'getParent', {
        value: getParentMock,
      });

      const path = await fileSystem.getFullPath(mockDirectoryHandle1);

      expect(path).toBe('parent/testDir');
      expect(getParentMock).toHaveBeenCalledTimes(1);
    });

    it('should handle errors during path traversal', async () => {
      const getParentMock = vi.fn().mockRejectedValue(new Error('Parent error'));
      Object.defineProperty(mockDirectoryHandle1, 'getParent', {
        value: getParentMock,
      });

      await expect(fileSystem.getFullPath(mockDirectoryHandle1)).rejects.toThrow(
        'Failed to get full path'
      );
    });
  });

  describe('generateUniqueFolderId', () => {
    it('should generate a unique folder ID using full path when possible', async () => {
      // Setup mock for getParent that returns null (to reach the root)
      const getParentMock = vi.fn().mockResolvedValue(null);
      Object.defineProperty(mockDirectoryHandle1, 'getParent', {
        value: getParentMock,
      });

      // Mock the stableHash function to return a specific value for this test
      vi.mocked(stableHash).mockResolvedValueOnce('test-id');

      const folderId = await fileSystem.generateUniqueFolderId(mockDirectoryHandle1);

      expect(stableHash).toHaveBeenCalledWith('testDir');
      expect(folderId).toBe('htest-id');
    });

    it('should handle circular references in directory structure', async () => {
      // Setup circular reference (dir1 -> dir2 -> dir1)
      const mockDirHandle1 = { ...mockDirectoryHandle1, name: 'dir1' };
      const mockDirHandle2 = { ...mockDirectoryHandle2, name: 'dir2' };

      // dir1 parent is dir2
      const getParentMock1 = vi.fn().mockResolvedValue(mockDirHandle2);
      Object.defineProperty(mockDirHandle1, 'getParent', {
        value: getParentMock1,
      });

      // dir2 parent is dir1 (circular)
      const getParentMock2 = vi.fn().mockResolvedValue(mockDirHandle1);
      Object.defineProperty(mockDirHandle2, 'getParent', {
        value: getParentMock2,
      });

      const folderId = await fileSystem.generateUniqueFolderId(mockDirHandle1);

      // Should still generate a valid ID despite the circular reference
      expect(folderId).toContain('h');
      expect(stableHash).toHaveBeenCalled();
    });

    it('should use fallback strategy if getParent fails', async () => {
      // Setup getParent to throw an error
      const getParentMock = vi.fn().mockRejectedValue(new Error('Parent lookup failed'));
      Object.defineProperty(mockDirectoryHandle1, 'getParent', {
        value: getParentMock,
      });

      const folderId = await fileSystem.generateUniqueFolderId(mockDirectoryHandle1);

      expect(folderId).toContain('h');
      expect(stableHash).toHaveBeenCalledWith(expect.stringContaining('root/testDir'));
    });

    it('should use fallback strategy when getParent throws synchronously', async () => {
      Object.defineProperty(mockDirectoryHandle1, 'getParent', {
        value: vi.fn().mockImplementation(() => {
          throw new Error('sync fail');
        }),
      });

      const folderId = await fileSystem.generateUniqueFolderId(mockDirectoryHandle1);

      expect(stableHash).toHaveBeenCalledWith('root/testDir');
      expect(folderId).toBe('hhash-root/testDir');
    });
  });

  describe('readFileContent', () => {
    it('should read file content using text() method when available', async () => {
      const content = await fileSystem.readFileContent(mockFileHandle);

      expect(content).toBe('test content');
      expect(mockFileHandle.getFile).toHaveBeenCalledTimes(1);
    });

    it('should fall back to arrayBuffer if text() fails', async () => {
      // Setup TextDecoder mock - Vitest 4 requires class/function for constructor mocks
      const mockDecodedText = 'fallback content';
      const mockDecode = vi.fn().mockReturnValue(mockDecodedText);

      // Create a mock class that can be used as a constructor
      // Use Object.defineProperties to handle read-only properties
      const MockTextDecoder = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        Object.defineProperties(this, {
          encoding: { value: 'utf-8', writable: false },
          fatal: { value: false, writable: false },
          ignoreBOM: { value: false, writable: false },
          decode: { value: mockDecode, writable: false },
        });
      });

      vi.stubGlobal('TextDecoder', MockTextDecoder);

      // Mock text() to fail and force arrayBuffer() path
      mockFileHandle.getFile = vi.fn().mockResolvedValue({
        text: vi.fn().mockRejectedValue(new Error('text() not supported')),
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
      });

      const content = await fileSystem.readFileContent(mockFileHandle);

      expect(mockDecode).toHaveBeenCalled();
      expect(content).toBe(mockDecodedText);

      // Restore
      vi.unstubAllGlobals();
    });

    it('should throw FileSystemOperationError when both methods fail', async () => {
      // Mock both text() and arrayBuffer() to fail
      mockFileHandle.getFile = vi.fn().mockResolvedValue({
        text: vi.fn().mockRejectedValue(new Error('text() failed')),
        arrayBuffer: vi.fn().mockRejectedValue(new Error('arrayBuffer() failed')),
      });

      await expect(fileSystem.readFileContent(mockFileHandle)).rejects.toThrow(
        'Failed to read file content'
      );
    });
  });

  describe('createFileNode', () => {
    async function withParentPathSplitForbidden(action: () => Promise<void>): Promise<void> {
      const originalSplit = String.prototype.split;
      String.prototype.split = function split(
        this: string,
        ...args: Parameters<typeof String.prototype.split>
      ): string[] {
        const separator: unknown = args[0];
        if (String(this) === 'parent/nested' && separator === '/') {
          throw new Error('parent path split should not be used for depth');
        }

        return Reflect.apply(originalSplit, this, args) as string[];
      } as typeof String.prototype.split;

      try {
        await action();
      } finally {
        String.prototype.split = originalSplit;
      }
    }

    it('should create a file node from a file handle', async () => {
      const fileNode = await fileSystem.createFileNode(mockFileHandle, 'parent');

      expect(fileNode).toEqual({
        name: 'testFile.txt',
        path: 'parent/testFile.txt',
        type: 'file',
        handle: mockFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        size: 100,
        lastModified: 1_234_567_890,
      });
    });

    it('computes file depth without splitting the parent path', async () => {
      await withParentPathSplitForbidden(async () => {
        const fileNode = await fileSystem.createFileNode(mockFileHandle, 'parent/nested');

        expect(fileNode.depth).toBe(2);
      });
    });

    it('computes directory depth without splitting the parent path', async () => {
      await withParentPathSplitForbidden(async () => {
        const directoryNode = await fileSystem.createFileNode(
          mockDirectoryHandle1,
          'parent/nested'
        );

        expect(directoryNode.depth).toBe(2);
      });
    });

    it('should create a directory node with children', async () => {
      // Mock entries to return a child file
      const entriesGenerator = function* () {
        yield ['childFile.txt', mockFileHandle];
      };
      mockDirectoryHandle1.entries = vi.fn().mockImplementation(() => entriesGenerator());

      const directoryNode = await fileSystem.createFileNode(mockDirectoryHandle1, '');

      expect(directoryNode.type).toBe('directory');
      expect(directoryNode.name).toBe('testDir');
      expect(directoryNode.path).toBe('testDir');
      expect((directoryNode.children || []).length).toBe(1);
      expect(directoryNode.children?.[0]?.name).toBe('testFile.txt');
    });

    it('should use the provided root handle to generate rootFolderId', async () => {
      // Spy on generateUniqueFolderId
      const generateIdSpy = vi
        .spyOn(fileSystem, 'generateUniqueFolderId')
        .mockResolvedValue('test-root-id');

      const fileNode = await fileSystem.createFileNode(mockFileHandle, '', mockDirectoryHandle1);

      expect(generateIdSpy).toHaveBeenCalledWith(mockDirectoryHandle1);
      expect(fileNode.rootFolderId).toBe('test-root-id');
    });

    it('should handle errors when creating directory node children', async () => {
      // Mock entries to throw an error
      mockDirectoryHandle1.entries = vi.fn().mockImplementation(() => {
        throw new Error('Failed to read directory');
      });

      await expect(fileSystem.createFileNode(mockDirectoryHandle1, '')).rejects.toThrow(
        'Failed to create file node'
      );
    });
  });
});
