import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { FileTreeIndex } from '../file-tree-index';

const createMockFileNode = (overrides: Partial<IFileNode> = {}): IFileNode =>
  ({
    name: 'file.txt',
    path: 'src/file.txt',
    type: 'file',
    rootFolderId: 'folder-123',
    ...overrides,
  }) as IFileNode;

const createMockDirectoryNode = (overrides: Partial<IFileNode> = {}): IFileNode =>
  ({
    name: 'src',
    path: 'src',
    type: 'directory',
    rootFolderId: 'folder-123',
    children: [],
    loadState: 'loaded',
    ...overrides,
  }) as IFileNode;

describe('FileTreeIndex', () => {
  it('should create an empty index', () => {
    const index = new FileTreeIndex();
    expect(index.stats).toEqual({
      totalNodes: 0,
      totalFiles: 0,
      totalDirectories: 0,
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
        path: '/absolute/path/file.txt',
        name: 'file.txt',
        kind: 'file' as const,
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
});
