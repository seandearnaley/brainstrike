import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  getNormalizedNode,
  listNormalizedDescendantFilePaths,
  materializeNormalizedFileTree,
  materializeNormalizedSubtree,
  replaceNormalizedDirectoryChildren,
  setNormalizedNodeLoadState,
} from '../normalized-file-tree';

function createFileNode(overrides: Partial<IFileNode>): IFileNode {
  return {
    name: 'file.txt',
    path: '/root/file.txt',
    type: 'file',
    depth: 1,
    handle: {} as FileSystemFileHandle,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    ...overrides,
  };
}

function createDirectoryNode(overrides: Partial<IFileNode>): IFileNode {
  return {
    name: 'dir',
    path: '/root/dir',
    type: 'directory',
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    loadState: 'loaded',
    ...overrides,
  };
}

describe('normalized-file-tree', () => {
  it('round-trips a nested tree through normalized state', () => {
    const tree: IFileNode[] = [
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        children: [
          createFileNode({ name: 'index.ts', path: '/root/src/index.ts', depth: 1 }),
          createDirectoryNode({
            name: 'nested',
            path: '/root/src/nested',
            depth: 1,
            children: [createFileNode({ name: 'a.ts', path: '/root/src/nested/a.ts', depth: 2 })],
          }),
        ],
      }),
    ];

    const state = createNormalizedFileTreeState(tree);
    expect(getNormalizedDescendantFileCount(state, '/root/src')).toBe(2);
    expect(materializeNormalizedFileTree(state)).toEqual(tree);
  });

  it('replaces a directory subtree and updates descendant file counts', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        children: [
          createFileNode({ name: 'old.ts', path: '/root/src/old.ts', depth: 1 }),
          createDirectoryNode({
            name: 'nested',
            path: '/root/src/nested',
            depth: 1,
            children: [
              createFileNode({ name: 'nested.ts', path: '/root/src/nested/nested.ts', depth: 2 }),
            ],
          }),
        ],
      }),
    ]);

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src', [
      createFileNode({ name: 'new.ts', path: '/root/src/new.ts', depth: 1 }),
    ]);

    expect(getNormalizedDescendantFileCount(nextState, '/root/src')).toBe(1);
    expect(getNormalizedNode(nextState, '/root/src/nested')).toBeUndefined();
    expect(listNormalizedDescendantFilePaths(nextState, '/root/src')).toEqual(['/root/src/new.ts']);
  });

  it('updates load state without changing descendant file counts', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        loadState: 'unloaded',
        children: [createFileNode({ name: 'a.ts', path: '/root/src/a.ts', depth: 1 })],
      }),
    ]);

    const nextState = setNormalizedNodeLoadState(state, '/root/src', 'loading');

    expect(getNormalizedNode(nextState, '/root/src')?.loadState).toBe('loading');
    expect(getNormalizedDescendantFileCount(nextState, '/root/src')).toBe(1);
    expect(nextState.childPathsByPath).toBe(state.childPathsByPath);
    expect(nextState.parentPathByPath).toBe(state.parentPathByPath);
    expect(nextState.descendantFileCountByPath).toBe(state.descendantFileCountByPath);
  });

  it('materializes a single subtree on demand', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        children: [
          createDirectoryNode({
            name: 'nested',
            path: '/root/src/nested',
            depth: 1,
            children: [createFileNode({ name: 'a.ts', path: '/root/src/nested/a.ts', depth: 2 })],
          }),
        ],
      }),
    ]);

    expect(materializeNormalizedSubtree(state, '/root/src/nested')).toEqual(
      createDirectoryNode({
        name: 'nested',
        path: '/root/src/nested',
        depth: 1,
        children: [createFileNode({ name: 'a.ts', path: '/root/src/nested/a.ts', depth: 2 })],
      })
    );
  });

  it('does not loop forever if parent references become cyclic during count recomputation', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        children: [
          createDirectoryNode({
            name: 'nested',
            path: '/root/src/nested',
            depth: 1,
            children: [createFileNode({ name: 'a.ts', path: '/root/src/nested/a.ts', depth: 2 })],
          }),
        ],
      }),
    ]);

    state.parentPathByPath.set('/root/src', '/root/src/nested');
    state.parentPathByPath.set('/root/src/nested', '/root/src');

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src/nested', [
      createFileNode({ name: 'b.ts', path: '/root/src/nested/b.ts', depth: 2 }),
    ]);

    expect(getNormalizedDescendantFileCount(nextState, '/root/src/nested')).toBe(1);
    expect(getNormalizedDescendantFileCount(nextState, '/root/src')).toBe(1);
  });

  it('handles deeply nested trees without recursive stack overflow', () => {
    const depth = 12_000;
    const directoryPaths: string[] = [];
    let currentPath = '/root';
    for (let index = 0; index < depth; index += 1) {
      currentPath = `${currentPath}/dir-${index}`;
      directoryPaths.push(currentPath);
    }

    let currentNode = createFileNode({
      name: 'leaf.ts',
      path: `${currentPath}/leaf.ts`,
      depth,
    });

    for (let index = directoryPaths.length - 1; index >= 0; index -= 1) {
      const directoryPath = directoryPaths[index];
      if (!directoryPath) {
        continue;
      }
      currentNode = createDirectoryNode({
        name: `dir-${index}`,
        path: directoryPath,
        depth: index,
        children: [currentNode],
      });
    }

    const state = createNormalizedFileTreeState([currentNode]);
    expect(() => materializeNormalizedFileTree(state)).not.toThrow();
    expect(() =>
      replaceNormalizedDirectoryChildren(state, currentNode.path, [
        createFileNode({
          name: 'replacement.ts',
          path: `${currentNode.path}/replacement.ts`,
          depth: 1,
        }),
      ])
    ).not.toThrow();
  });
});
