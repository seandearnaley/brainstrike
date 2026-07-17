import { TextDecoder, TextEncoder } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { fileSystem } from '../file-system';
import {
  createCircularHandles,
  createSelfReferencingHandle,
  MockFileSystemHandle,
} from './utils/mock-file-system';

// Add TextEncoder and TextDecoder to global scope if not already defined
if (typeof global.TextEncoder === 'undefined') {
  (global as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  (global as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}

describe('fileSystem', () => {
  describe('isSameDirectory', () => {
    it('should handle missing experimental APIs', async () => {
      const handle1 = new MockFileSystemHandle('test1');
      const handle2 = new MockFileSystemHandle('test2');

      const result = await fileSystem.isSameDirectory(
        handle1 as unknown as FileSystemDirectoryHandle,
        handle2 as unknown as FileSystemDirectoryHandle
      );

      expect(result).toBe(false);
    });

    it('should handle matching names', async () => {
      const handle1 = new MockFileSystemHandle('test');
      const handle2 = new MockFileSystemHandle('test');

      const result = await fileSystem.isSameDirectory(
        handle1 as unknown as FileSystemDirectoryHandle,
        handle2 as unknown as FileSystemDirectoryHandle
      );

      expect(result).toBe(true);
    });

    it('uses isSameEntry when available', async () => {
      const handle1: MockFileSystemHandle = new MockFileSystemHandle(
        'test',
        'directory',
        async (other: FileSystemHandle): Promise<boolean> => other === handle1
      );
      const handle2 = handle1;

      const result = await fileSystem.isSameDirectory(
        handle1 as unknown as FileSystemDirectoryHandle,
        handle2 as unknown as FileSystemDirectoryHandle
      );

      expect(result).toBe(true);
    });

    it('falls back to path comparison when isSameEntry fails', async () => {
      const handle1 = new MockFileSystemHandle('test', 'directory');
      const handle2 = handle1;

      const result = await fileSystem.isSameDirectory(
        handle1 as unknown as FileSystemDirectoryHandle,
        handle2 as unknown as FileSystemDirectoryHandle
      );

      expect(result).toBe(true);
    });

    it('falls back to name comparison as last resort', async () => {
      const handle1 = new MockFileSystemHandle('test');
      const handle2 = new MockFileSystemHandle('test');

      const result = await fileSystem.isSameDirectory(
        handle1 as unknown as FileSystemDirectoryHandle,
        handle2 as unknown as FileSystemDirectoryHandle
      );

      expect(result).toBe(true);
    });
  });

  describe('generateUniqueFolderId', () => {
    it('should generate a stable ID for a directory handle', async () => {
      const mockHandle = createSelfReferencingHandle('testDir');
      const id = await fileSystem.generateUniqueFolderId(
        mockHandle as unknown as FileSystemDirectoryHandle
      );

      expect(id).toMatch(/^h[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(1);
    });

    it('should handle missing experimental APIs', async () => {
      const mockHandle = new MockFileSystemHandle('test');
      const id = await fileSystem.generateUniqueFolderId(
        mockHandle as unknown as FileSystemDirectoryHandle
      );

      expect(id).toMatch(/^h[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(1);
    });

    it('uses handle name when isSameEntry confirms identity', async () => {
      const mockHandle = createSelfReferencingHandle('testDir');
      const id = await fileSystem.generateUniqueFolderId(
        mockHandle as unknown as FileSystemDirectoryHandle
      );

      expect(id).toMatch(/^h[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(1);
    });

    it('uses path-based ID when isSameEntry is not available', async () => {
      const mockHandle = new MockFileSystemHandle(
        'child',
        'directory',
        undefined,
        async () => new MockFileSystemHandle('parent', 'directory')
      );

      const id = await fileSystem.generateUniqueFolderId(
        mockHandle as unknown as FileSystemDirectoryHandle
      );

      expect(id).toMatch(/^h[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(1);
    });

    it('handles deep directory structures', async () => {
      const level3 = new MockFileSystemHandle('level3', 'directory');
      const level2 = new MockFileSystemHandle('level2', 'directory');
      const level1 = new MockFileSystemHandle('level1', 'directory');
      const root = new MockFileSystemHandle('root', 'directory');

      level3.setMockGetParent(async () => level2);
      level2.setMockGetParent(async () => level1);
      level1.setMockGetParent(async () => root);
      root.setMockGetParent(async () => null);

      const id = await fileSystem.generateUniqueFolderId(
        level3 as unknown as FileSystemDirectoryHandle
      );

      expect(id).toMatch(/^h[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(1);
    });

    it('handles getParent failures gracefully', async () => {
      const mockHandle = new MockFileSystemHandle('test', 'directory', undefined, async () => {
        throw new Error('getParent failed');
      });
      const id = await fileSystem.generateUniqueFolderId(
        mockHandle as unknown as FileSystemDirectoryHandle
      );

      expect(id).toMatch(/^h[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(1);
    });

    it('handles very long paths by hashing', async () => {
      const mockHandle = new MockFileSystemHandle(
        'a'.repeat(1000),
        'directory',
        undefined,
        async () => null
      );
      const id = await fileSystem.generateUniqueFolderId(
        mockHandle as unknown as FileSystemDirectoryHandle
      );

      expect(id).toMatch(/^h[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(1);
    });

    it('maintains unique IDs for different paths with same leaf name', async () => {
      const child1 = new MockFileSystemHandle('child', 'directory');
      const parent1 = new MockFileSystemHandle('parent1', 'directory');
      child1.setMockGetParent(async () => parent1);
      parent1.setMockGetParent(async () => null);

      const child2 = new MockFileSystemHandle('child', 'directory');
      const parent2 = new MockFileSystemHandle('parent2', 'directory');
      child2.setMockGetParent(async () => parent2);
      parent2.setMockGetParent(async () => null);

      const id1 = await fileSystem.generateUniqueFolderId(
        child1 as unknown as FileSystemDirectoryHandle
      );
      const id2 = await fileSystem.generateUniqueFolderId(
        child2 as unknown as FileSystemDirectoryHandle
      );

      expect(id1).toMatch(/^h[a-z0-9]+$/);
      expect(id2).toMatch(/^h[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it('handles circular directory references', async () => {
      const [circularHandle1] = createCircularHandles();

      const id = await fileSystem.generateUniqueFolderId(
        circularHandle1 as unknown as FileSystemDirectoryHandle
      );

      expect(id).toMatch(/^h[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(1);
    });
  });

  describe('readFileContent', () => {
    it('should read file content', async () => {
      const mockHandle = {
        getFile: vi.fn().mockResolvedValue({
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
          text: vi.fn().mockResolvedValue('test content'),
        }),
      };

      const result = await fileSystem.readFileContent(
        mockHandle as unknown as FileSystemFileHandle
      );
      expect(result).toBe('test content');
    });

    it('should handle text() method failure', async () => {
      // Mock the TextDecoder implementation for this test
      const originalTextDecoder = global.TextDecoder;

      // Create a custom TextDecoder implementation that returns our test content
      class TestTextDecoder {
        decode(): string {
          return 'test content';
        }
      }

      // Override the global TextDecoder for this test
      global.TextDecoder = TestTextDecoder as unknown as typeof global.TextDecoder;

      const mockHandleWithArrayBuffer = {
        getFile: vi.fn().mockResolvedValue({
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)), // Content doesn't matter as we're mocking the decoder
          text: vi.fn().mockRejectedValue(new Error('text() failed')),
        }),
      };

      try {
        const result = await fileSystem.readFileContent(
          mockHandleWithArrayBuffer as unknown as FileSystemFileHandle
        );
        expect(result).toBe('test content');
      } finally {
        // Restore the original TextDecoder
        global.TextDecoder = originalTextDecoder;
      }
    });

    it('should handle both text() and arrayBuffer() failures', async () => {
      const mockHandleWithFailures = {
        getFile: vi.fn().mockResolvedValue({
          arrayBuffer: vi.fn().mockRejectedValue(new Error('arrayBuffer() failed')),
          text: vi.fn().mockRejectedValue(new Error('text() failed')),
        }),
      };

      await expect(
        fileSystem.readFileContent(mockHandleWithFailures as unknown as FileSystemFileHandle)
      ).rejects.toThrow('Failed to read file content');
    });
  });
});
