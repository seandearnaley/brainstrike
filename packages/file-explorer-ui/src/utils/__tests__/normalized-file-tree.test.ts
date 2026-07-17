import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import * as normalizedFileTreeModule from '../normalized-file-tree';
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

type NormalizedFileTreeStateForTest = ReturnType<typeof createNormalizedFileTreeState>;
interface DirectoryChildrenUpdateForTest {
  children: IFileNode[];
  loadState?: Extract<NonNullable<IFileNode['loadState']>, 'loaded'>;
  path: string;
}
type BulkDirectoryChildrenApplicator = (
  state: NormalizedFileTreeStateForTest,
  updates: DirectoryChildrenUpdateForTest[]
) => NormalizedFileTreeStateForTest;

function createFileNode(overrides: Partial<IFileNode>): IFileNode {
  return {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    name: 'file.txt',
    path: '/root/file.txt',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
    ...overrides,
  };
}

function createDirectoryNode(overrides: Partial<IFileNode>): IFileNode {
  return {
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    loadState: 'loaded',
    name: 'dir',
    path: '/root/dir',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
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
        children: [
          createFileNode({ depth: 1, name: 'index.ts', path: '/root/src/index.ts' }),
          createDirectoryNode({
            children: [createFileNode({ depth: 2, name: 'a.ts', path: '/root/src/nested/a.ts' })],
            depth: 1,
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        name: 'src',
        path: '/root/src',
      }),
    ];

    const state = createNormalizedFileTreeState(tree);
    expect(getNormalizedDescendantFileCount(state, '/root/src')).toBe(2);
    expect(materializeNormalizedFileTree(state)).toEqual(tree);
  });

  it('replaces a directory subtree and updates descendant file counts', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        children: [
          createFileNode({ depth: 1, name: 'old.ts', path: '/root/src/old.ts' }),
          createDirectoryNode({
            children: [
              createFileNode({ depth: 2, name: 'nested.ts', path: '/root/src/nested/nested.ts' }),
            ],
            depth: 1,
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        name: 'src',
        path: '/root/src',
      }),
    ]);

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src', [
      createFileNode({ depth: 1, name: 'new.ts', path: '/root/src/new.ts' }),
    ]);

    expect(getNormalizedDescendantFileCount(nextState, '/root/src')).toBe(1);
    expect(getNormalizedNode(nextState, '/root/src/nested')).toBeUndefined();
    expect(listNormalizedDescendantFilePaths(nextState, '/root/src')).toEqual(['/root/src/new.ts']);
  });

  it('bulk applies directory child replacements in one immutable pass', () => {
    const applyBulkDirectoryChildren = (
      normalizedFileTreeModule as unknown as {
        applyNormalizedDirectoryChildrenUpdates?: BulkDirectoryChildrenApplicator;
      }
    ).applyNormalizedDirectoryChildrenUpdates;

    expect(applyBulkDirectoryChildren).toBeTypeOf('function');
    if (!applyBulkDirectoryChildren) {
      return;
    }

    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        children: Array.from({ length: 3 }, (_, index) =>
          createDirectoryNode({
            depth: 1,
            loadState: 'unloaded',
            name: `dir-${index}`,
            path: `/root/dir-${index}`,
          })
        ),
        name: 'root',
        path: '/root',
      }),
    ]);

    const nextState = applyBulkDirectoryChildren(state, [
      {
        children: [
          createFileNode({
            depth: 2,
            name: 'a.ts',
            path: '/root/dir-0/a.ts',
          }),
        ],
        loadState: 'loaded',
        path: '/root/dir-0',
      },
      {
        children: [
          createFileNode({
            depth: 2,
            name: 'b.ts',
            path: '/root/dir-1/b.ts',
          }),
        ],
        loadState: 'loaded',
        path: '/root/dir-1',
      },
      {
        children: [
          createDirectoryNode({
            children: [
              createFileNode({
                depth: 3,
                name: 'c.ts',
                path: '/root/dir-2/nested/c.ts',
              }),
            ],
            depth: 2,
            name: 'nested',
            path: '/root/dir-2/nested',
          }),
        ],
        loadState: 'loaded',
        path: '/root/dir-2',
      },
    ]);

    expect(nextState).not.toBe(state);
    expect(getNormalizedDescendantFileCount(nextState, '/root')).toBe(3);
    expect(listNormalizedDescendantFilePaths(nextState, '/root')).toEqual([
      '/root/dir-0/a.ts',
      '/root/dir-1/b.ts',
      '/root/dir-2/nested/c.ts',
    ]);
    expect(getNormalizedNode(nextState, '/root/dir-0')?.loadState).toBe('loaded');
    expect(getNormalizedNode(state, '/root/dir-0')?.loadState).toBe('unloaded');
    expect(listNormalizedDescendantFilePaths(state, '/root')).toEqual([]);
  });

  it('bulk applies nested directory replacements parent-first regardless of input order', () => {
    const applyBulkDirectoryChildren = (
      normalizedFileTreeModule as unknown as {
        applyNormalizedDirectoryChildrenUpdates?: BulkDirectoryChildrenApplicator;
      }
    ).applyNormalizedDirectoryChildrenUpdates;

    expect(applyBulkDirectoryChildren).toBeTypeOf('function');
    if (!applyBulkDirectoryChildren) {
      return;
    }

    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        children: [],
        name: 'root',
        path: '/root',
      }),
    ]);

    const nextState = applyBulkDirectoryChildren(state, [
      {
        children: [
          createFileNode({
            depth: 2,
            name: 'index.ts',
            path: '/root/src/index.ts',
          }),
        ],
        loadState: 'loaded',
        path: '/root/src',
      },
      {
        children: [
          createDirectoryNode({
            depth: 1,
            loadState: 'unloaded',
            name: 'src',
            path: '/root/src',
          }),
        ],
        loadState: 'loaded',
        path: '/root',
      },
    ]);

    expect(listNormalizedDescendantFilePaths(nextState, '/root')).toEqual(['/root/src/index.ts']);
    expect(getNormalizedDescendantFileCount(nextState, '/root')).toBe(1);
    expect(getNormalizedNode(nextState, '/root/src')?.loadState).toBe('loaded');
  });

  it('updates load state without changing descendant file counts', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        children: [createFileNode({ depth: 1, name: 'a.ts', path: '/root/src/a.ts' })],
        loadState: 'unloaded',
        name: 'src',
        path: '/root/src',
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
        loadState: 'unloaded',
        name: 'src',
        path: '/root/src',
      }),
    ]);

    const erroredState = setNormalizedNodeLoadState(state, '/root/src', 'error', 'boom');
    expect(getNormalizedNode(erroredState, '/root/src')).toMatchObject({
      loadError: 'boom',
      loadState: 'error',
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
        children: [
          createDirectoryNode({
            children: [createFileNode({ depth: 2, name: 'a.ts', path: '/root/src/nested/a.ts' })],
            depth: 1,
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        name: 'src',
        path: '/root/src',
      }),
    ]);

    expect(materializeNormalizedSubtree(state, '/root/src/nested')).toEqual(
      createDirectoryNode({
        children: [createFileNode({ depth: 2, name: 'a.ts', path: '/root/src/nested/a.ts' })],
        depth: 1,
        name: 'nested',
        path: '/root/src/nested',
      })
    );
  });

  it('materializes shallow nodes and parent links without descending recursively', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        children: [
          createDirectoryNode({
            children: [createFileNode({ depth: 2, name: 'a.ts', path: '/root/src/nested/a.ts' })],
            depth: 1,
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        name: 'src',
        path: '/root/src',
      }),
      createFileNode({ depth: 0, name: 'readme.md', path: '/root/readme.md' }),
    ]);

    expect(materializeNormalizedNode(state, '/root/src')).toMatchObject({
      path: '/root/src',
      type: 'directory',
    });
    expect(materializeNormalizedShallowNode(state, '/root/src')).toEqual(
      createDirectoryNode({
        children: [
          createDirectoryNode({
            depth: 1,
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        name: 'src',
        path: '/root/src',
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
        children: [
          createDirectoryNode({
            children: [createFileNode({ depth: 2, name: 'a.ts', path: '/root/src/nested/a.ts' })],
            depth: 1,
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        name: 'src',
        path: '/root/src',
      }),
    ]);

    state.parentPathByPath.set('/root/src', '/root/src/nested');
    state.parentPathByPath.set('/root/src/nested', '/root/src');

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src/nested', [
      createFileNode({ depth: 2, name: 'b.ts', path: '/root/src/nested/b.ts' }),
    ]);

    expect(getNormalizedDescendantFileCount(nextState, '/root/src/nested')).toBe(1);
    expect(getNormalizedDescendantFileCount(nextState, '/root/src')).toBe(1);
  });

  it('does not loop forever if subtree child paths become cyclic during replacement', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        children: [
          createDirectoryNode({
            children: [createFileNode({ depth: 2, name: 'a.ts', path: '/root/src/nested/a.ts' })],
            depth: 1,
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        name: 'src',
        path: '/root/src',
      }),
    ]);

    state.childPathsByPath.set('/root/src/nested', ['/root/src']);

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src', [
      createFileNode({ depth: 1, name: 'replacement.ts', path: '/root/src/replacement.ts' }),
    ]);

    expect(getNormalizedChildPaths(nextState, '/root/src')).toEqual(['/root/src/replacement.ts']);
    expect(getNormalizedNode(nextState, '/root/src/nested')).toBeUndefined();
  });

  it('keeps ancestor links and counts intact when a non-root subtree has a cyclic child edge to its parent', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        children: [
          createDirectoryNode({
            children: [
              createDirectoryNode({
                children: [
                  createFileNode({
                    depth: 3,
                    name: 'a.ts',
                    path: '/root/src/nested/a.ts',
                  }),
                ],
                depth: 2,
                name: 'nested',
                path: '/root/src/nested',
              }),
            ],
            depth: 1,
            name: 'src',
            path: '/root/src',
          }),
        ],
        name: 'root',
        path: '/root',
      }),
    ]);

    state.childPathsByPath.set('/root/src/nested', ['/root/src']);

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src/nested', [
      createFileNode({
        depth: 3,
        name: 'replacement.ts',
        path: '/root/src/nested/replacement.ts',
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
        children: [createFileNode({ depth: 2, name: 'index.ts', path: '/root/src/index.ts' })],
        name: 'src',
        path: '/root/src',
      }),
      createDirectoryNode({
        children: [
          createFileNode({
            depth: 2,
            name: 'generated.ts',
            path: '/root/src-generated/generated.ts',
          }),
        ],
        name: 'src-generated',
        path: '/root/src-generated',
      }),
    ]);

    const nextState = replaceNormalizedDirectoryChildren(state, '/root/src', [
      createFileNode({ depth: 2, name: 'replacement.ts', path: '/root/src/replacement.ts' }),
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
      depth,
      name: 'leaf.ts',
      path: `${currentPath}/leaf.ts`,
    });

    for (let index = directoryPaths.length - 1; index >= 0; index -= 1) {
      const directoryPath = directoryPaths[index];
      if (!directoryPath) {
        continue;
      }
      currentNode = createDirectoryNode({
        children: [currentNode],
        depth: index,
        name: `dir-${index}`,
        path: directoryPath,
      });
    }

    const state = createNormalizedFileTreeState([currentNode]);
    expect(() => materializeNormalizedFileTree(state)).not.toThrow();
    expect(() =>
      replaceNormalizedDirectoryChildren(state, currentNode.path, [
        createFileNode({
          depth: 1,
          name: 'replacement.ts',
          path: `${currentNode.path}/replacement.ts`,
        }),
      ])
    ).not.toThrow();
  });

  it('lists descendant file paths breadth-first with an optional max count', () => {
    const state = createNormalizedFileTreeState([
      createDirectoryNode({
        children: [
          createFileNode({ depth: 1, name: 'a.ts', path: '/root/src/a.ts' }),
          createDirectoryNode({
            children: [
              createFileNode({ depth: 2, name: 'b.ts', path: '/root/src/nested/b.ts' }),
              createFileNode({ depth: 2, name: 'c.ts', path: '/root/src/nested/c.ts' }),
            ],
            depth: 1,
            name: 'nested',
            path: '/root/src/nested',
          }),
        ],
        name: 'src',
        path: '/root/src',
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

  // Structural sharing: every commit used to rematerialize the ENTIRE tree
  // (fresh objects for all N nodes, twice per directory expand). Untouched
  // subtrees must keep their materialized object identity across commits so
  // memo'd rows bail out and WeakMap-keyed derivation caches stay warm.
  describe('materialization structural sharing', () => {
    function buildWideState() {
      return createNormalizedFileTreeState([
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [
                createFileNode({ depth: 2, name: 'a.ts', path: '/root/src/alpha/a.ts' }),
                createFileNode({ depth: 2, name: 'b.ts', path: '/root/src/alpha/b.ts' }),
              ],
              depth: 1,
              name: 'alpha',
              path: '/root/src/alpha',
            }),
            createDirectoryNode({
              children: [createFileNode({ depth: 2, name: 'c.ts', path: '/root/src/beta/c.ts' })],
              depth: 1,
              loadState: 'unloaded',
              name: 'beta',
              path: '/root/src/beta',
            }),
          ],
          name: 'src',
          path: '/root/src',
        }),
      ]);
    }

    it('re-materializing the SAME state returns identical root objects', () => {
      const state = buildWideState();
      const first = materializeNormalizedFileTree(state);
      const second = materializeNormalizedFileTree(state);
      expect(second[0]).toBe(first[0]);
    });

    it('a loadState flip on one directory preserves sibling subtree identity', () => {
      const state = buildWideState();
      const before = materializeNormalizedFileTree(state);
      const next = setNormalizedNodeLoadState(state, '/root/src/beta', 'loading');
      const after = materializeNormalizedFileTree(next);

      const beforeRoot = before[0];
      const afterRoot = after[0];
      if (!(beforeRoot?.children && afterRoot?.children)) {
        throw new Error('Expected materialized roots with children.');
      }
      // The changed directory and its ancestor chain are new objects…
      expect(afterRoot).not.toBe(beforeRoot);
      const afterBeta = afterRoot.children.find((child) => child.path === '/root/src/beta');
      const beforeBeta = beforeRoot.children.find((child) => child.path === '/root/src/beta');
      expect(afterBeta).not.toBe(beforeBeta);
      expect(afterBeta?.loadState).toBe('loading');
      // …while the untouched sibling subtree keeps its identity.
      const afterAlpha = afterRoot.children.find((child) => child.path === '/root/src/alpha');
      const beforeAlpha = beforeRoot.children.find((child) => child.path === '/root/src/alpha');
      expect(afterAlpha).toBe(beforeAlpha);
    });

    it('replacing one directory children preserves sibling subtree identity and stays value-correct', () => {
      const state = buildWideState();
      const before = materializeNormalizedFileTree(state);
      const next = replaceNormalizedDirectoryChildren(state, '/root/src/beta', [
        createFileNode({ depth: 2, name: 'c.ts', path: '/root/src/beta/c.ts' }),
        createFileNode({ depth: 2, name: 'd.ts', path: '/root/src/beta/d.ts' }),
      ]);
      const after = materializeNormalizedFileTree(next);

      const beforeRoot = before[0];
      const afterRoot = after[0];
      if (!(beforeRoot?.children && afterRoot?.children)) {
        throw new Error('Expected materialized roots with children.');
      }
      const afterAlpha = afterRoot.children.find((child) => child.path === '/root/src/alpha');
      const beforeAlpha = beforeRoot.children.find((child) => child.path === '/root/src/alpha');
      expect(afterAlpha).toBe(beforeAlpha);

      const afterBeta = afterRoot.children.find((child) => child.path === '/root/src/beta');
      expect(afterBeta?.children?.map((child) => child.path)).toEqual([
        '/root/src/beta/c.ts',
        '/root/src/beta/d.ts',
      ]);
      expect(afterBeta?.loadState).toBe('loaded');
      // Value-equivalence against a from-scratch materialization of the same state.
      expect(after).toEqual(materializeNormalizedFileTree(next));
    });

    it('the old state still materializes correctly after the new state was materialized (fork safety)', () => {
      const state = buildWideState();
      const next = setNormalizedNodeLoadState(state, '/root/src/beta', 'loading');
      materializeNormalizedFileTree(next);

      const old = materializeNormalizedFileTree(state);
      const oldBeta = old[0]?.children?.find((child) => child.path === '/root/src/beta');
      expect(oldBeta?.loadState).toBe('unloaded');
    });
  });
});
