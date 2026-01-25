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
});
