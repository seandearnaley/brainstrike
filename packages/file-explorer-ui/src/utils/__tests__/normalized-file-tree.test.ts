import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  createEmptyNormalizedFileTreeState,
  createNormalizedFileTreeState,
  getNormalizedChildPaths,
  getNormalizedDescendantFileCount,
  getNormalizedNode,
  getNormalizedParentPath,
  getNormalizedRootDirectoryPaths,
  listNormalizedDescendantFilePaths,
  materializeNormalizedFileTree,
  materializeNormalizedNode,
  materializeNormalizedShallowNode,
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
  it('creates an empty normalized state', () => {
    const state = createEmptyNormalizedFileTreeState();

    expect(state.rootPaths).toEqual([]);
    expect(getNormalizedChildPaths(state, null)).toEqual([]);
    expect(getNormalizedRootDirectoryPaths(state)).toEqual([]);
  });

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
    expect(nextState.childPathsByPath.get('/root/src')).toEqual(
      state.childPathsByPath.get('/root/src')
    );
    expect(nextState.parentPathByPath.get('/root/src')).toBe(
      state.parentPathByPath.get('/root/src')
    );
    expect(nextState.descendantFileCountByPath.get('/root/src')).toBe(
      state.descendantFileCountByPath.get('/root/src')
    );
  });

  it('sets load errors and clears them when the directory load state is reset', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        loadState: 'unloaded',
      }),
    ]);

    const erroredState = setNormalizedNodeLoadState(state, '/root/src', 'error', 'boom');
    expect(getNormalizedNode(erroredState, '/root/src')).toMatchObject({
      loadState: 'error',
      loadError: 'boom',
    });

    const recoveredState = setNormalizedNodeLoadState(erroredState, '/root/src', 'loaded');
    expect(getNormalizedNode(recoveredState, '/root/src')).toMatchObject({
      loadState: 'loaded',
    });
    expect(getNormalizedNode(recoveredState, '/root/src')).not.toHaveProperty('loadError');
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

  it('materializes shallow nodes and parent links without descending recursively', () => {
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
      createFileNode({ name: 'readme.md', path: '/root/readme.md', depth: 0 }),
    ]);

    expect(materializeNormalizedNode(state, '/root/src')).toMatchObject({
      path: '/root/src',
      type: 'directory',
    });
    expect(materializeNormalizedShallowNode(state, '/root/src')).toEqual(
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        children: [
          createDirectoryNode({
            name: 'nested',
            path: '/root/src/nested',
            depth: 1,
          }),
        ],
      })
    );
    expect(getNormalizedChildPaths(state, '/root/src')).toEqual(['/root/src/nested']);
    expect(getNormalizedParentPath(state, '/root/src/nested')).toBe('/root/src');
    expect(getNormalizedRootDirectoryPaths(state)).toEqual(['/root/src']);
  });

  it('returns stable empty results for missing nodes and no-op replacements', () => {
    const state = createNormalizedFileTreeState([createFileNode({ path: '/root/file.ts' })]);

    expect(materializeNormalizedNode(state, '/missing')).toBeUndefined();
    expect(materializeNormalizedSubtree(state, '/missing')).toBeUndefined();
    expect(materializeNormalizedShallowNode(state, '/missing')).toBeUndefined();
    expect(getNormalizedDescendantFileCount(state, '/missing')).toBe(0);
    expect(listNormalizedDescendantFilePaths(state, '/missing')).toEqual([]);
    expect(replaceNormalizedDirectoryChildren(state, '/missing', [])).toBe(state);
    expect(setNormalizedNodeLoadState(state, '/missing', 'loading')).toBe(state);
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

  it('does not loop forever if subtree child paths become cyclic during replacement', () => {
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

    state.childPathsByPath.set('/root/src/nested', ['/root/src']);

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src', [
      createFileNode({ name: 'replacement.ts', path: '/root/src/replacement.ts', depth: 1 }),
    ]);

    expect(getNormalizedChildPaths(nextState, '/root/src')).toEqual(['/root/src/replacement.ts']);
    expect(getNormalizedNode(nextState, '/root/src/nested')).toBeUndefined();
  });

  it('keeps ancestor links and counts intact when a non-root subtree has a cyclic child edge to its parent', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        name: 'root',
        path: '/root',
        children: [
          createDirectoryNode({
            name: 'src',
            path: '/root/src',
            depth: 1,
            children: [
              createDirectoryNode({
                name: 'nested',
                path: '/root/src/nested',
                depth: 2,
                children: [
                  createFileNode({
                    name: 'a.ts',
                    path: '/root/src/nested/a.ts',
                    depth: 3,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ]);

    state.childPathsByPath.set('/root/src/nested', ['/root/src']);

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src/nested', [
      createFileNode({
        name: 'replacement.ts',
        path: '/root/src/nested/replacement.ts',
        depth: 3,
      }),
    ]);

    expect(getNormalizedParentPath(nextState, '/root/src/nested')).toBe('/root/src');
    expect(getNormalizedDescendantFileCount(nextState, '/root/src/nested')).toBe(1);
    expect(getNormalizedDescendantFileCount(nextState, '/root/src')).toBe(1);
    expect(getNormalizedDescendantFileCount(nextState, '/root')).toBe(1);
  });

  it('only removes descendants that match on a path boundary', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        children: [createFileNode({ name: 'index.ts', path: '/root/src/index.ts', depth: 2 })],
      }),
      createDirectoryNode({
        name: 'src-generated',
        path: '/root/src-generated',
        children: [
          createFileNode({
            name: 'generated.ts',
            path: '/root/src-generated/generated.ts',
            depth: 2,
          }),
        ],
      }),
    ]);

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src', [
      createFileNode({ name: 'replacement.ts', path: '/root/src/replacement.ts', depth: 2 }),
    ]);

    expect(getNormalizedNode(nextState, '/root/src-generated')).toMatchObject({
      path: '/root/src-generated',
      type: 'directory',
    });
    expect(listNormalizedDescendantFilePaths(nextState, '/root/src-generated')).toEqual([
      '/root/src-generated/generated.ts',
    ]);
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

  it('lists descendant file paths breadth-first with an optional max count', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        name: 'src',
        path: '/root/src',
        children: [
          createFileNode({ name: 'a.ts', path: '/root/src/a.ts', depth: 1 }),
          createDirectoryNode({
            name: 'nested',
            path: '/root/src/nested',
            depth: 1,
            children: [
              createFileNode({ name: 'b.ts', path: '/root/src/nested/b.ts', depth: 2 }),
              createFileNode({ name: 'c.ts', path: '/root/src/nested/c.ts', depth: 2 }),
            ],
          }),
        ],
      }),
    ]);

    expect(listNormalizedDescendantFilePaths(state, '/root/src')).toEqual([
      '/root/src/a.ts',
      '/root/src/nested/b.ts',
      '/root/src/nested/c.ts',
    ]);
    expect(listNormalizedDescendantFilePaths(state, '/root/src', 2)).toEqual([
      '/root/src/a.ts',
      '/root/src/nested/b.ts',
    ]);
    expect(listNormalizedDescendantFilePaths(state, '/root/src/a.ts')).toEqual(['/root/src/a.ts']);
  });
});
