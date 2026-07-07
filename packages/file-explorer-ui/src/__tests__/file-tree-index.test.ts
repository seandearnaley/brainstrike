import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { FileTreeIndex } from '../tree/file-tree-index';

const createMockFileNode = (overrides: Partial<IFileNode> = {}): IFileNode =>
  ({
    name: 'file.txt',
    path: 'src/file.txt',
    rootFolderId: 'folder-123',
    type: 'file',
    ...overrides,
  }) as IFileNode;

const createMockDirectoryNode = (overrides: Partial<IFileNode> = {}): IFileNode =>
  ({
    children: [],
    loadState: 'loaded',
    name: 'src',
    path: 'src',
    rootFolderId: 'folder-123',
    type: 'directory',
    ...overrides,
  }) as IFileNode;

describe('FileTreeIndex', () => {
  it('should create an empty index', () => {
    const index = new FileTreeIndex();
    expect(index.stats).toEqual({
      totalDirectories: 0,
      totalFiles: 0,
      totalNodes: 0,
    });
  });

  describe('addNodes', () => {
    it('should add file nodes to the index', () => {
      const index = new FileTreeIndex();
      const fileNode = createMockFileNode();
      index.addNodes([fileNode], null);
      expect(index.stats.totalNodes).toBe(1);
      expect(index.stats.totalFiles).toBe(1);
      expect(index.stats.totalDirectories).toBe(0);
    });

    it('should add directory nodes to the index', () => {
      const index = new FileTreeIndex();
      const dirNode = createMockDirectoryNode();
      index.addNodes([dirNode], null);
      expect(index.stats.totalNodes).toBe(1);
      expect(index.stats.totalFiles).toBe(0);
      expect(index.stats.totalDirectories).toBe(1);
    });

    it('should recursively add nested children', () => {
      const index = new FileTreeIndex();
      const dirNode = createMockDirectoryNode({
        children: [
          createMockFileNode({ name: 'a.txt', path: 'src/a.txt' }),
          createMockFileNode({ name: 'b.txt', path: 'src/b.txt' }),
        ],
      });
      index.addNodes([dirNode], null);
      expect(index.stats.totalNodes).toBe(3);
      expect(index.stats.totalFiles).toBe(2);
      expect(index.stats.totalDirectories).toBe(1);
    });
  });

  describe('getNode', () => {
    it('should return node by folderId and path', () => {
      const index = new FileTreeIndex();
      const fileNode = createMockFileNode({ path: 'src/file.txt', rootFolderId: 'folder-123' });
      index.addNodes([fileNode], null);

      const result = index.getNode('folder-123', 'src/file.txt');

      expect(result).toBe(fileNode);
    });

    it('should return undefined for non-existent node', () => {
      const index = new FileTreeIndex();

      const result = index.getNode('folder-123', 'nonexistent.txt');

      expect(result).toBeUndefined();
    });
  });

  describe('getHandle', () => {
    it('should return handle info for file with web handle', () => {
      const index = new FileTreeIndex();
      const mockWebHandle = { getFile: () => Promise.resolve(new File([], 'test')) };
      const fileNode = createMockFileNode({
        handle: mockWebHandle as unknown as FileSystemFileHandle,
        size: 1024,
      });
      index.addNodes([fileNode], null);

      const result = index.getHandle('folder-123', 'src/file.txt');

      expect(result).toBeDefined();
      expect(result?.webHandle).toBe(mockWebHandle);
      expect(result?.fileName).toBe('file.txt');
      expect(result?.fileSize).toBe(1024);
    });

    it('should return handle info for file with electron handle', () => {
      const index = new FileTreeIndex();
      const mockElectronHandle = {
        kind: 'file' as const,
        name: 'file.txt',
        path: '/absolute/path/file.txt',
        platform: 'electron' as const,
      };
      const fileNode = createMockFileNode({
        handle: mockElectronHandle as unknown as FileSystemFileHandle,
        size: 2048,
      });
      index.addNodes([fileNode], null);

      const result = index.getHandle('folder-123', 'src/file.txt');

      expect(result).toBeDefined();
      expect(result?.electronHandle).toBe(mockElectronHandle);
      expect(result?.fileName).toBe('file.txt');
      expect(result?.fileSize).toBe(2048);
    });

    it('should return undefined for non-existent handle', () => {
      const index = new FileTreeIndex();

      const result = index.getHandle('folder-123', 'nonexistent.txt');

      expect(result).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all entries and reset stats', () => {
      const index = new FileTreeIndex();
      index.addNodes([createMockFileNode(), createMockDirectoryNode()], null);

      index.clear();

      expect(index.stats.totalNodes).toBe(0);
      expect(index.getNode('folder-123', 'src/file.txt')).toBeUndefined();
    });
  });

  describe('incremental updates', () => {
    it('should accumulate nodes from multiple addNodes calls', () => {
      const index = new FileTreeIndex();

      index.addNodes([createMockFileNode({ path: 'a.txt' })], null);
      index.addNodes([createMockFileNode({ path: 'b.txt' })], 'src');

      expect(index.stats.totalNodes).toBe(2);
      expect(index.getNode('folder-123', 'a.txt')).toBeDefined();
      expect(index.getNode('folder-123', 'b.txt')).toBeDefined();
    });

    it('should update existing node when re-added', () => {
      const index = new FileTreeIndex();
      const originalNode = createMockFileNode({ path: 'file.txt', size: 100 });
      const updatedNode = createMockFileNode({ path: 'file.txt', size: 200 });

      index.addNodes([originalNode], null);
      index.addNodes([updatedNode], null);

      const result = index.getNode('folder-123', 'file.txt');
      expect(result?.size).toBe(200);
      // Stats should not double-count
      expect(index.stats.totalNodes).toBe(1);
    });
  });

  describe('type change handling', () => {
    it('should adjust stats when file becomes directory', () => {
      const index = new FileTreeIndex();
      const fileNode = createMockFileNode({ name: 'item', path: 'item' });

      index.addNodes([fileNode], null);
      expect(index.stats.totalFiles).toBe(1);
      expect(index.stats.totalDirectories).toBe(0);
      expect(index.stats.totalNodes).toBe(1);

      // Re-add same path as directory
      const dirNode = createMockDirectoryNode({ name: 'item', path: 'item' });
      index.addNodes([dirNode], null);

      expect(index.stats.totalFiles).toBe(0);
      expect(index.stats.totalDirectories).toBe(1);
      expect(index.stats.totalNodes).toBe(1); // Node count unchanged
    });

    it('should adjust stats when directory becomes file', () => {
      const index = new FileTreeIndex();
      const dirNode = createMockDirectoryNode({ name: 'item', path: 'item' });

      index.addNodes([dirNode], null);
      expect(index.stats.totalFiles).toBe(0);
      expect(index.stats.totalDirectories).toBe(1);

      // Re-add same path as file
      const fileNode = createMockFileNode({ name: 'item', path: 'item' });
      index.addNodes([fileNode], null);

      expect(index.stats.totalFiles).toBe(1);
      expect(index.stats.totalDirectories).toBe(0);
      expect(index.stats.totalNodes).toBe(1);
    });

    it('should handle file → directory → file correctly', () => {
      const index = new FileTreeIndex();

      // Start as file
      index.addNodes([createMockFileNode({ path: 'item' })], null);
      expect(index.stats).toEqual({ totalDirectories: 0, totalFiles: 1, totalNodes: 1 });

      // Change to directory
      index.addNodes([createMockDirectoryNode({ path: 'item' })], null);
      expect(index.stats).toEqual({ totalDirectories: 1, totalFiles: 0, totalNodes: 1 });

      // Change back to file
      index.addNodes([createMockFileNode({ path: 'item' })], null);
      expect(index.stats).toEqual({ totalDirectories: 0, totalFiles: 1, totalNodes: 1 });
    });

    it('should not change stats when type is unchanged', () => {
      const index = new FileTreeIndex();
      const fileNode = createMockFileNode({ path: 'file.txt', size: 100 });

      index.addNodes([fileNode], null);
      const initialStats = { ...index.stats };

      // Re-add same file with different size (same type)
      index.addNodes([createMockFileNode({ path: 'file.txt', size: 200 })], null);

      expect(index.stats).toEqual(initialStats);
    });
  });

  describe('handle cleanup on type change', () => {
    it('should remove file handle when node becomes directory', () => {
      const index = new FileTreeIndex();
      const mockHandle = { getFile: () => Promise.resolve(new File([], 'test')) };
      const fileNode = createMockFileNode({
        handle: mockHandle as unknown as FileSystemFileHandle,
        path: 'item',
      });

      index.addNodes([fileNode], null);
      expect(index.getHandle('folder-123', 'item')).toBeDefined();

      // Change to directory - handle should be removed
      index.addNodes([createMockDirectoryNode({ path: 'item' })], null);
      expect(index.getHandle('folder-123', 'item')).toBeUndefined();
    });

    it('should remove stale handle when file re-added without handle', () => {
      const index = new FileTreeIndex();
      const mockHandle = { getFile: () => Promise.resolve(new File([], 'test')) };
      const fileWithHandle = createMockFileNode({
        handle: mockHandle as unknown as FileSystemFileHandle,
        path: 'file.txt',
      });

      index.addNodes([fileWithHandle], null);
      expect(index.getHandle('folder-123', 'file.txt')).toBeDefined();

      // Re-add same file without handle (simulates revoked permission)
      // Don't pass handle property - createMockFileNode doesn't set one by default
      const fileWithoutHandle = createMockFileNode({ path: 'file.txt' });
      index.addNodes([fileWithoutHandle], null);

      expect(index.getHandle('folder-123', 'file.txt')).toBeUndefined();
      // Node should still exist
      expect(index.getNode('folder-123', 'file.txt')).toBeDefined();
    });

    it('should update handle when file re-added with new handle', () => {
      const index = new FileTreeIndex();
      const oldHandle = { getFile: () => Promise.resolve(new File([], 'old')) };
      const newHandle = { getFile: () => Promise.resolve(new File([], 'new')) };

      index.addNodes(
        [
          createMockFileNode({
            handle: oldHandle as unknown as FileSystemFileHandle,
            path: 'file.txt',
          }),
        ],
        null
      );

      index.addNodes(
        [
          createMockFileNode({
            handle: newHandle as unknown as FileSystemFileHandle,
            path: 'file.txt',
          }),
        ],
        null
      );

      const result = index.getHandle('folder-123', 'file.txt');
      expect(result?.webHandle).toBe(newHandle);
    });
  });

  describe('clearFolder (Phase 6 forest sharing)', () => {
    it('removes only the given folder entries and adjusts stats', () => {
      const index = new FileTreeIndex();
      index.addNodes(
        [
          createMockDirectoryNode({
            children: [
              createMockFileNode({ name: 'a.ts', path: 'src/a.ts', rootFolderId: 'root-a' }),
            ],
            path: 'src',
            rootFolderId: 'root-a',
          }),
          createMockFileNode({ name: 'b.ts', path: 'src/b.ts', rootFolderId: 'root-b' }),
        ],
        null
      );
      expect(index.stats.totalNodes).toBe(3);

      index.clearFolder('root-a');

      expect(index.getNode('root-a', 'src')).toBeUndefined();
      expect(index.getNode('root-a', 'src/a.ts')).toBeUndefined();
      // The other root's entries survive.
      expect(index.getNode('root-b', 'src/b.ts')).toBeDefined();
      expect(index.stats).toEqual({ totalDirectories: 0, totalFiles: 1, totalNodes: 1 });
    });

    it('is a no-op for a folder with no entries', () => {
      const index = new FileTreeIndex();
      index.addNodes([createMockFileNode({ path: 'b.ts', rootFolderId: 'root-b' })], null);

      index.clearFolder('root-a');

      expect(index.stats.totalNodes).toBe(1);
      expect(index.getNode('root-b', 'b.ts')).toBeDefined();
    });
  });
});
