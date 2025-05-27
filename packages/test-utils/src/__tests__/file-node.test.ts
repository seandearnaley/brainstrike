import { describe, expect, it } from 'vitest';
import {
  createDirectoryNode,
  createFileNode,
  createFileTreeFromStructure,
  createNestedDirectoryStructure,
} from '../factories/file-node';

import type { IFileNode } from '@brainstrike/types';
function countFiles(node: IFileNode): number {
  let count = node.type === 'file' ? 1 : 0;
  if (node.children) {
    for (const child of node.children) {
      count += countFiles(child);
    }
  }
  return count;
}

function maxDepth(node: IFileNode): number {
  let depth = node.depth;
  if (node.children) {
    for (const child of node.children) {
      const childDepth = maxDepth(child);
      if (childDepth > depth) {
        depth = childDepth;
      }
    }
  }
  return depth;
}

describe('createFileNode', () => {
  it('creates a file node with default options', () => {
    const node = createFileNode();
    expect(node).toMatchObject({
      name: 'test.txt',
      path: '/test.txt',
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'test-folder',
      isVisible: true,
      type: 'file',
    });
    expect(node.handle).toBeDefined();
    expect((node.handle as { kind: string }).kind).toBe('file');
  });

  it('creates a file node with custom options', () => {
    const customHandle = { kind: 'file' } as unknown as FileSystemFileHandle;
    const node = createFileNode({
      name: 'foo.txt',
      path: '/foo/foo.txt',
      depth: 2,
      selectionState: 'checked',
      rootFolderId: 'foo-folder',
      isVisible: false,
      handle: customHandle,
    });
    expect(node).toMatchObject({
      name: 'foo.txt',
      path: '/foo/foo.txt',
      depth: 2,
      selectionState: 'checked',
      rootFolderId: 'foo-folder',
      isVisible: false,
      type: 'file',
    });
    expect(node.handle).toBe(customHandle);
  });
});

describe('createDirectoryNode', () => {
  it('creates a directory node with default options', () => {
    const node = createDirectoryNode();
    expect(node).toMatchObject({
      name: 'test-directory',
      path: '/test-directory',
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'test-folder',
      isVisible: true,
      type: 'directory',
      children: [],
    });
    expect(node.handle).toBeDefined();
    expect((node.handle as { kind: string }).kind).toBe('directory');
  });

  it('creates a directory node with custom options', () => {
    const children = [createFileNode({ name: 'child.txt' })];
    const node = createDirectoryNode({
      name: 'foo',
      path: '/foo',
      depth: 1,
      selectionState: 'checked',
      rootFolderId: 'foo-folder',
      isVisible: false,
      children,
    });
    expect(node).toMatchObject({
      name: 'foo',
      path: '/foo',
      depth: 1,
      selectionState: 'checked',
      rootFolderId: 'foo-folder',
      isVisible: false,
      type: 'directory',
    });
    expect(node.children).toBe(children);
  });
});

describe('createNestedDirectoryStructure', () => {
  it('creates the correct number of files and depth', () => {
    const depth = 2;
    const filesPerLevel = 3;
    const root = createNestedDirectoryStructure('/', depth, filesPerLevel);
    const totalFiles = countFiles(root);
    const deepest = maxDepth(root);

    expect(totalFiles).toBe((depth + 1) * filesPerLevel);
    expect(deepest).toBe(depth);
  });
});

describe('createFileTreeFromStructure', () => {
  it('converts a simple object into tree nodes', () => {
    const structure = {
      src: {
        'index.ts': null,
        components: {
          'button.tsx': null,
        },
      },
    };

    const tree = createFileTreeFromStructure(structure);
    expect(tree).toHaveLength(1);

    const src = tree[0];
    expect(src.name).toBe('src');
    expect(src.type).toBe('directory');
    expect(src.depth).toBe(0);
    expect(src.children?.length).toBe(2);

    const index = src.children?.find((c) => c.name === 'index.ts');
    expect(index?.type).toBe('file');
    expect(index?.path).toBe('src/index.ts');
    expect(index?.depth).toBe(1);

    const components = src.children?.find((c) => c.name === 'components');
    expect(components?.type).toBe('directory');
    expect(components?.depth).toBe(1);
    const button = components?.children?.[0];
    expect(button?.name).toBe('button.tsx');
    expect(button?.depth).toBe(2);
  });
});
