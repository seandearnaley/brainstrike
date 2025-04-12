import type { IFileNode } from '@brainstrike/types';
import { vi } from 'vitest';
import {
  createDirectoryNode,
  createFileNode,
  createFileTreeFromStructure,
  createNestedDirectoryStructure,
} from '../file-node';

describe('File Node Factories', () => {
  describe('createFileNode', () => {
    it('creates a file node with default values', () => {
      const node = createFileNode({
        name: 'test.txt',
        path: '/test.txt',
      });

      expect(node).toEqual({
        name: 'test.txt',
        path: '/test.txt',
        type: 'file',
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'test-folder',
        isVisible: true,
        handle: expect.objectContaining({
          kind: 'file',
          name: 'test.txt',
          getFile: expect.any(Function),
          createWritable: expect.any(Function),
          isSameEntry: expect.any(Function),
        }),
      });
    });

    it('creates a file node with custom values', () => {
      const node = createFileNode({
        name: 'test.txt',
        path: '/test.txt',
        depth: 2,
        selectionState: 'checked',
      });

      expect(node.depth).toBe(2);
      expect(node.selectionState).toBe('checked');
    });

    it('uses provided handle if supplied', () => {
      const customHandle = {
        kind: 'file' as const,
        name: 'test.txt',
        getFile: vi.fn().mockResolvedValue(new File([], 'test.txt')),
        createWritable: vi.fn(),
        isSameEntry: vi.fn(),
      } as unknown as FileSystemFileHandle;

      const node = createFileNode({
        name: 'test.txt',
        path: '/test.txt',
        handle: customHandle,
      });

      expect(node.handle).toEqual(customHandle);
    });
  });

  describe('createDirectoryNode', () => {
    it('creates a directory node with default values', () => {
      const node = createDirectoryNode({
        name: 'testDir',
        path: '/testDir',
      });

      expect(node).toEqual({
        name: 'testDir',
        path: '/testDir',
        type: 'directory',
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'test-folder',
        isVisible: true,
        children: [],
        handle: expect.objectContaining({
          kind: 'directory',
          name: 'testDir',
          entries: expect.any(Function),
          getDirectoryHandle: expect.any(Function),
          getFileHandle: expect.any(Function),
        }),
      });
    });

    it('creates a directory node with children', () => {
      const children: IFileNode[] = [
        createFileNode({
          name: 'child.txt',
          path: '/testDir/child.txt',
          depth: 1,
        }),
      ];

      const node = createDirectoryNode({
        name: 'testDir',
        path: '/testDir',
        children,
      });

      expect(node.children).toBe(children);
    });
  });

  describe('createNestedDirectoryStructure', () => {
    it('creates a nested directory structure with default values', () => {
      const structure = createNestedDirectoryStructure() as IFileNode & {
        children: IFileNode[];
      };

      expect(structure.type).toBe('directory');
      expect(Array.isArray(structure.children)).toBe(true);
      expect(structure.children).toHaveLength(3); // 2 files + 1 subdirectory

      const subdir = structure.children.find((child) => child.type === 'directory');
      expect(subdir).toBeDefined();
      expect(subdir?.children).toHaveLength(3); // 2 files + 1 subdirectory
    });

    it('respects custom depth and filesPerLevel parameters', () => {
      const structure = createNestedDirectoryStructure('/', 2, 3) as IFileNode & {
        children: IFileNode[];
      };

      expect(Array.isArray(structure.children)).toBe(true);
      expect(structure.children).toHaveLength(4); // 3 files + 1 subdirectory

      const files = structure.children.filter((child: IFileNode) => child.type === 'file');
      expect(files).toHaveLength(3);
    });
  });

  describe('createFileTreeFromStructure', () => {
    it('creates a file tree from a simple structure', () => {
      const structure = {
        folder1: {
          'file1.txt': null,
          'file2.txt': null,
        },
        folder2: {
          subfolder: {
            'file3.txt': null,
          },
        },
      };

      const tree = createFileTreeFromStructure(structure);

      expect(tree).toHaveLength(2); // Two root folders

      const folder1 = tree.find((node: IFileNode) => node.name === 'folder1');
      expect(folder1?.type).toBe('directory');
      expect(folder1?.children).toHaveLength(2);

      const folder2 = tree.find((node: IFileNode) => node.name === 'folder2');
      expect(folder2).toBeDefined();
      if (!folder2 || !folder2.children || folder2.children.length === 0) {
        throw new Error('folder2 or its children is undefined or empty');
      }

      expect(folder2.type).toBe('directory');
      const subfolder = folder2.children[0];
      if (!subfolder) {
        throw new Error('subfolder is undefined');
      }
      expect(subfolder.name).toBe('subfolder');

      if (!subfolder.children || subfolder.children.length === 0) {
        throw new Error('subfolder children is undefined or empty');
      }

      const file3 = subfolder.children[0];
      if (!file3) {
        throw new Error('file3 is undefined');
      }
      expect(file3.name).toBe('file3.txt');
    });

    it('maintains correct paths and depths', () => {
      const structure = {
        root: {
          'file.txt': null,
        },
      };

      const tree = createFileTreeFromStructure(structure);
      expect(tree).toHaveLength(1);
      
      const rootFolder = tree[0];
      expect(rootFolder).toBeDefined();
      if (!rootFolder || !rootFolder.children || rootFolder.children.length === 0) {
        throw new Error('rootFolder or its children is undefined or empty');
      }

      const file = rootFolder.children[0];
      if (!file) {
        throw new Error('file is undefined');
      }

      expect(rootFolder.path).toBe('root');
      expect(rootFolder.depth).toBe(0);
      expect(file.path).toBe('root/file.txt');
      expect(file.depth).toBe(1);
    });
  });
});
