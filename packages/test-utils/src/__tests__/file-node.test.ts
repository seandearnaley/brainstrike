import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  createDirectoryNode,
  createFileNode,
  createFileTreeFromStructure,
  createNestedDirectoryStructure,
  flattenTreeForCount,
  generateLargeTree,
  largeTreePresets,
} from '../factories/file-node';

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
      depth: 0,
      isVisible: true,
      name: 'test.txt',
      path: '/test.txt',
      rootFolderId: 'test-folder',
      selectionState: 'unchecked',
      type: 'file',
    });
    expect(node.handle).toBeDefined();
    expect((node.handle as { kind: string }).kind).toBe('file');
  });

  it('creates a file node with custom options', () => {
    const customHandle = { kind: 'file' } as unknown as FileSystemFileHandle;
    const node = createFileNode({
      depth: 2,
      handle: customHandle,
      isVisible: false,
      name: 'foo.txt',
      path: '/foo/foo.txt',
      rootFolderId: 'foo-folder',
      selectionState: 'checked',
    });
    expect(node).toMatchObject({
      depth: 2,
      isVisible: false,
      name: 'foo.txt',
      path: '/foo/foo.txt',
      rootFolderId: 'foo-folder',
      selectionState: 'checked',
      type: 'file',
    });
    expect(node.handle).toBe(customHandle);
  });
});

describe('createDirectoryNode', () => {
  it('creates a directory node with default options', () => {
    const node = createDirectoryNode();
    expect(node).toMatchObject({
      children: [],
      depth: 0,
      isVisible: true,
      name: 'test-directory',
      path: '/test-directory',
      rootFolderId: 'test-folder',
      selectionState: 'unchecked',
      type: 'directory',
    });
    expect(node.handle).toBeDefined();
    expect((node.handle as { kind: string }).kind).toBe('directory');
  });

  it('creates a directory node with custom options', () => {
    const children = [createFileNode({ name: 'child.txt' })];
    const node = createDirectoryNode({
      children,
      depth: 1,
      isVisible: false,
      name: 'foo',
      path: '/foo',
      rootFolderId: 'foo-folder',
      selectionState: 'checked',
    });
    expect(node).toMatchObject({
      depth: 1,
      isVisible: false,
      name: 'foo',
      path: '/foo',
      rootFolderId: 'foo-folder',
      selectionState: 'checked',
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

  it('uses the root fallback name and generated file names', () => {
    const root = createNestedDirectoryStructure('/', 0, 1);
    expect(root.name).toBe('root');
    const onlyChild = root.children?.[0];
    expect(onlyChild?.name).toBe('file0.txt');
    expect(onlyChild?.path).toBe('//file0.txt');
    expect(onlyChild?.depth).toBe(0);
  });

  it('creates deterministic subdirectory names per depth', () => {
    const root = createNestedDirectoryStructure('/base', 2, 0);
    const level1Dir = root.children?.[0];
    const level2Dir = level1Dir?.children?.[0];

    expect(level1Dir?.name).toBe('subdir2');
    expect(level1Dir?.path).toBe('/base/subdir2');
    expect(level1Dir?.depth).toBe(1);

    expect(level2Dir?.name).toBe('subdir1');
    expect(level2Dir?.path).toBe('/base/subdir2/subdir1');
    expect(level2Dir?.depth).toBe(2);
  });
});

describe('createFileTreeFromStructure', () => {
  it('converts a simple object into tree nodes', () => {
    const structure = {
      src: {
        components: {
          'button.tsx': null,
        },
        'index.ts': null,
      },
    };

    const tree = createFileTreeFromStructure(structure);
    expect(tree).toHaveLength(1);

    const src = tree[0]!;
    expect(src).toBeDefined();
    expect(src.name).toBe('src');
    expect(src.type).toBe('directory');
    expect(src.depth).toBe(0);
    expect(src.children?.length).toBe(2);

    const index = src.children?.find((c) => c.name === 'index.ts');
    expect(index).toBeDefined();
    expect(index?.type).toBe('file');
    expect(index?.path).toBe('src/index.ts');
    expect(index?.depth).toBe(1);

    const components = src.children?.find((c) => c.name === 'components');
    expect(components).toBeDefined();
    expect(components?.type).toBe('directory');
    expect(components?.depth).toBe(1);
    const button = components?.children?.[0];
    expect(button?.name).toBe('button.tsx');
    expect(button?.depth).toBe(2);
  });

  it('should handle empty structures', () => {
    const tree = createFileTreeFromStructure({});
    expect(tree).toHaveLength(0);
  });

  it('should handle single file at root', () => {
    const structure = {
      'README.md': null,
    };

    const tree = createFileTreeFromStructure(structure);
    expect(tree).toHaveLength(1);
    const readme = tree[0]!;
    expect(readme).toBeDefined();
    expect(readme.name).toBe('README.md');
    expect(readme.type).toBe('file');
    expect(readme.path).toBe('README.md');
    expect(readme.depth).toBe(0);
  });

  it('should handle deeply nested structures', () => {
    const structure = {
      a: {
        b: {
          c: {
            'd.txt': null,
          },
        },
      },
    };

    const tree = createFileTreeFromStructure(structure);
    const a = tree[0]!;
    expect(a).toBeDefined();
    const b = a.children?.[0];
    const c = b?.children?.[0];
    const d = c?.children?.[0];

    expect(a.depth).toBe(0);
    expect(b?.depth).toBe(1);
    expect(c?.depth).toBe(2);
    expect(d?.depth).toBe(3);
    expect(d?.path).toBe('a/b/c/d.txt');
  });

  it('should create correct paths for nested files', () => {
    const structure = {
      root: {
        'file1.ts': null,
        nested: {
          'file2.ts': null,
        },
      },
    };

    const tree = createFileTreeFromStructure(structure);
    const root = tree[0]!;
    expect(root).toBeDefined();
    const file1 = root.children?.find((c) => c.name === 'file1.ts');
    const nested = root.children?.find((c) => c.name === 'nested');
    const file2 = nested?.children?.[0];

    expect(file1?.path).toBe('root/file1.ts');
    expect(nested?.path).toBe('root/nested');
    expect(file2?.path).toBe('root/nested/file2.ts');
  });
});

describe('createNestedDirectoryStructure edge cases', () => {
  it('should handle depth of 0', () => {
    const root = createNestedDirectoryStructure('/', 0, 2);
    expect(root.depth).toBe(0);
    expect(root.children?.length).toBe(2);
    expect(root.children?.every((c) => c.type === 'file')).toBe(true);
  });

  it('should handle 0 files per level', () => {
    const root = createNestedDirectoryStructure('/', 2, 0);
    const totalFiles = countFiles(root);
    expect(totalFiles).toBe(0);
  });

  it('should create correct paths for subdirectories', () => {
    const root = createNestedDirectoryStructure('/test', 2, 1);
    expect(root.path).toBe('/test');

    const subdir = root.children?.find((c) => c.type === 'directory');
    expect(subdir?.path).toContain('/test/subdir');
  });

  it('should assign correct depth values', () => {
    const root = createNestedDirectoryStructure('/', 3, 1);
    expect(root.depth).toBe(0);

    const level1Dir = root.children?.find((c) => c.type === 'directory');
    expect(level1Dir?.depth).toBe(1);

    const level2Dir = level1Dir?.children?.find((c) => c.type === 'directory');
    expect(level2Dir?.depth).toBe(2);

    const level3Dir = level2Dir?.children?.find((c) => c.type === 'directory');
    expect(level3Dir?.depth).toBe(3);
  });
});

describe('generateLargeTree', () => {
  it('generates a deterministic bounded tree from a custom config', () => {
    const { tree, nodeCount } = generateLargeTree({
      filesPerDir: 2,
      maxDepth: 3,
      subdirsPerDir: 2,
      targetNodeCount: 20,
    });

    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root).toMatchObject({
      depth: 0,
      name: 'root',
      path: 'root',
      type: 'directory',
    });
    expect(root.children?.filter((child) => child.type === 'file')).toHaveLength(2);
    expect(root.children?.filter((child) => child.type === 'directory')).toHaveLength(2);

    const flattened = flattenTreeForCount(tree);
    expect(nodeCount).toBe(flattened.length);
    expect(flattened.every((node) => node.rootFolderId === 'test-folder')).toBe(true);
    expect(Math.max(...flattened.map((node) => node.depth))).toBeLessThanOrEqual(3);
  });

  it('respects maxDepth even when the target count is much larger', () => {
    const { tree, nodeCount } = generateLargeTree({
      filesPerDir: 3,
      maxDepth: 1,
      subdirsPerDir: 10,
      targetNodeCount: 10_000,
    });

    const flattened = flattenTreeForCount(tree);

    expect(nodeCount).toBe(4);
    expect(flattened.map((node) => node.path)).toEqual([
      'root',
      'root/file-0.ts',
      'root/file-1.ts',
      'root/file-2.ts',
    ]);
  });

  it('provides named presets that can be flattened for smoke coverage', () => {
    const { tree, nodeCount } = generateLargeTree(largeTreePresets.small);
    const flattened = flattenTreeForCount(tree);

    expect(nodeCount).toBe(flattened.length);
    expect(nodeCount).toBeGreaterThan(0);
    expect(nodeCount).toBeLessThanOrEqual(largeTreePresets.small.targetNodeCount);
    expect(flattened.some((node) => node.type === 'directory')).toBe(true);
    expect(flattened.some((node) => node.type === 'file')).toBe(true);
  });
});
