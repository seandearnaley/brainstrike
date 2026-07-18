/**
 * Row-projection identity reuse (#1734 perf follow-up).
 *
 * TreeTable's flatten pass reuses value-equal rows only when `a.node === b.node`
 * (reuseEqualFlattenedRows). That contract is worthless if the adapter mints
 * fresh TreeNode/FileTreeRowData/IFileNode objects on every rebuild — these
 * tests pin identity stability of the row projections across rebuilds with
 * unchanged inputs, at 1-row and 10k-row scale.
 */
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  type BuildFileTreeRowsOptions,
  buildFileTreeRows,
  buildRowsFromNormalizedTree,
  getNormalizedImmediateChildren,
  reuseEqualFileTreeRows,
} from '../tree/optimized-file-tree-model';
import {
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  type NormalizedFileTreeState,
  setNormalizedNodeLoadState,
} from '../utils/normalized-file-tree';

function createFileNode(path: string, overrides: Partial<IFileNode> = {}): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
    ...overrides,
  };
}

function createDirectoryNode(
  path: string,
  children: IFileNode[] = [],
  overrides: Partial<IFileNode> = {}
): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    children,
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'loaded',
    name,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
    ...overrides,
  };
}

function buildOptions(expandedPaths: Iterable<string>): BuildFileTreeRowsOptions {
  return {
    expandedDirectoryPaths: new Set(expandedPaths),
    folderId: 'root',
    loadingFiles: new Set<string>(),
  };
}

function buildNormalizedRows(tree: NormalizedFileTreeState, options: BuildFileTreeRowsOptions) {
  return buildRowsFromNormalizedTree(
    tree,
    options,
    (path) => getNormalizedDescendantFileCount(tree, path),
    null
  );
}

describe('normalized row projections are identity-stable across rebuilds', () => {
  const fixtureTree = () =>
    createNormalizedFileTreeState([
      createDirectoryNode('/root/src', [
        createFileNode('/root/src/a.ts'),
        createFileNode('/root/src/b.ts'),
        createDirectoryNode('/root/src/lib', [createFileNode('/root/src/lib/c.ts')]),
      ]),
      createFileNode('/root/readme.md'),
    ]);

  it('yields the same fileNode object per path on consecutive builds', () => {
    const tree = fixtureTree();
    const options = buildOptions(['/root/src', '/root/src/lib']);

    const first = buildNormalizedRows(tree, options);
    const second = buildNormalizedRows(tree, options);

    expect(second.length).toBe(first.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(second[index]?.data.fileNode).toBe(first[index]?.data.fileNode);
    }
  });

  it('yields identity-stable immediate-children projections on consecutive calls', () => {
    const tree = fixtureTree();

    const first = getNormalizedImmediateChildren(tree, '/root/src', null);
    const second = getNormalizedImmediateChildren(tree, '/root/src', null);

    expect(second.length).toBe(first.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(second[index]).toBe(first[index]);
    }
  });

  it('produces a FRESH fileNode projection when the normalized node is replaced', () => {
    const tree = fixtureTree();
    const options = buildOptions(['/root/src', '/root/src/lib']);
    const first = buildNormalizedRows(tree, options);

    const updatedTree = setNormalizedNodeLoadState(tree, '/root/src/lib', 'loading');
    const second = buildNormalizedRows(updatedTree, options);

    const firstLib = first.find((row) => row.id === '/root/src/lib');
    const secondLib = second.find((row) => row.id === '/root/src/lib');
    expect(firstLib).toBeDefined();
    expect(secondLib).toBeDefined();
    expect(secondLib?.data.fileNode).not.toBe(firstLib?.data.fileNode);
    expect(secondLib?.data.fileNode.loadState).toBe('loading');
    // Untouched sibling files keep their projection identity.
    const firstA = first.find((row) => row.id === '/root/src/a.ts');
    const secondA = second.find((row) => row.id === '/root/src/a.ts');
    expect(secondA?.data.fileNode).toBe(firstA?.data.fileNode);
  });
});

describe('reuseEqualFileTreeRows', () => {
  it('reuses previous row objects when a rebuild produced value-equal rows', () => {
    const tree = fixtureNormalizedTree();
    const options = buildOptions(['/root/src', '/root/src/lib']);
    const first = buildNormalizedRows(tree, options);
    const previousById = new Map(first.map((row) => [row.id, row]));

    const rebuilt = buildNormalizedRows(tree, options);
    const stabilized = reuseEqualFileTreeRows(previousById, rebuilt);

    expect(stabilized.length).toBe(first.length);
    for (let index = 0; index < stabilized.length; index += 1) {
      expect(stabilized[index]).toBe(first[index]);
    }
  });

  it('keeps fresh identities ONLY for rows whose inputs changed', () => {
    const tree = fixtureNormalizedTree();
    const options = buildOptions(['/root/src', '/root/src/lib']);
    const first = buildNormalizedRows(tree, options);
    const previousById = new Map(first.map((row) => [row.id, row]));

    const updatedTree = setNormalizedNodeLoadState(tree, '/root/src/lib', 'loading');
    const rebuilt = buildNormalizedRows(updatedTree, options);
    const stabilized = reuseEqualFileTreeRows(previousById, rebuilt);

    for (const row of stabilized) {
      const previous = previousById.get(row.id);
      if (row.id === '/root/src/lib' || row.id === '/root/src') {
        // The reloaded directory got a replaced node; its parent's
        // immediateChildren/hasUnloaded flags changed with it.
        expect(row).not.toBe(previous);
      } else {
        expect(row).toBe(previous);
      }
    }
  });

  it('reuses main-thread (web) rows built from the same IFileNode tree', () => {
    const fileTree = [
      createDirectoryNode('/root/src', [
        createFileNode('/root/src/a.ts'),
        createFileNode('/root/src/b.ts'),
      ]),
      createFileNode('/root/readme.md'),
    ];
    const options = buildOptions(['/root/src']);
    const first = buildFileTreeRows(fileTree, options);
    const previousById = new Map(first.map((row) => [row.id, row]));

    const rebuilt = buildFileTreeRows(fileTree, options);
    const stabilized = reuseEqualFileTreeRows(previousById, rebuilt);

    for (let index = 0; index < stabilized.length; index += 1) {
      expect(stabilized[index]).toBe(first[index]);
    }
  });

  it('achieves full identity reuse across a 10k-row rebuild with unchanged inputs', () => {
    const directories: IFileNode[] = [];
    const expandedPaths: string[] = [];
    for (let dirIndex = 0; dirIndex < 100; dirIndex += 1) {
      const dirPath = `/root/dir-${dirIndex}`;
      expandedPaths.push(dirPath);
      const files: IFileNode[] = [];
      for (let fileIndex = 0; fileIndex < 100; fileIndex += 1) {
        files.push(createFileNode(`${dirPath}/file-${fileIndex}.ts`));
      }
      directories.push(createDirectoryNode(dirPath, files));
    }
    const tree = createNormalizedFileTreeState(directories);
    const options = buildOptions(expandedPaths);

    const first = buildNormalizedRows(tree, options);
    expect(first.length).toBe(10_100);
    const previousById = new Map(first.map((row) => [row.id, row]));

    const rebuilt = buildNormalizedRows(tree, options);
    const stabilized = reuseEqualFileTreeRows(previousById, rebuilt);

    let reusedCount = 0;
    for (let index = 0; index < stabilized.length; index += 1) {
      if (stabilized[index] === first[index]) {
        reusedCount += 1;
      }
    }
    expect(reusedCount).toBe(first.length);
  });
});

function fixtureNormalizedTree(): NormalizedFileTreeState {
  return createNormalizedFileTreeState([
    createDirectoryNode('/root/src', [
      createFileNode('/root/src/a.ts'),
      createFileNode('/root/src/b.ts'),
      createDirectoryNode('/root/src/lib', [createFileNode('/root/src/lib/c.ts')]),
    ]),
    createFileNode('/root/readme.md'),
  ]);
}
