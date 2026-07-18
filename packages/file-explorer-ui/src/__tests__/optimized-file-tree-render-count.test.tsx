/**
 * Render-count measurement at 10k+ rows (#1734 perf follow-up).
 *
 * Drives the real chain — model row build → reuseEqualFileTreeRows →
 * TreeTable (pre-flattened, virtual) — with a counting cell, and pins the
 * before/after delta in one deterministic place:
 *
 * - WITHOUT the adapter reuse pass (the old behavior): a rebuild mints fresh
 *   TreeNode identities, TreeTable's `a.node === b.node` flatten reuse never
 *   hits, and EVERY visible row re-renders.
 * - WITH the reuse pass: a content-equal rebuild re-renders ZERO rows.
 */
import type { IFileNode } from '@brainstrike/types';
import { TreeTable, type TreeTableColumn } from '@brainstrike/ui';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type BuildFileTreeRowsOptions,
  buildRowsFromNormalizedTree,
  type FileTreeRowData,
  reuseEqualFileTreeRows,
} from '../tree/optimized-file-tree-model';
import {
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  type NormalizedFileTreeState,
} from '../utils/normalized-file-tree';

const VISIBLE_ROW_COUNT = 60;

// Stable virtualizer instance rendering a fixed visible window — mirrors the
// real library's create-once behavior (see tree-table-render-stability.test.tsx
// in packages/ui) and keeps a 10k-row tree fast under jsdom.
vi.mock('@tanstack/react-virtual', () => {
  const state = { count: 0 };
  const instance = {
    getTotalSize: () => state.count * 32,
    getVirtualItems: () =>
      Array.from({ length: Math.min(state.count, VISIBLE_ROW_COUNT) }, (_, i) => ({
        end: (i + 1) * 32,
        index: i,
        key: `item-${i}`,
        size: 32,
        start: i * 32,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  };
  return {
    useVirtualizer: vi.fn(({ count }: { count: number }) => {
      state.count = count;
      return instance;
    }),
  };
});

function createFileNode(path: string): IFileNode {
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
  };
}

function createDirectoryNode(path: string, children: IFileNode[]): IFileNode {
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
  };
}

function createTenThousandRowFixture(): {
  options: BuildFileTreeRowsOptions;
  tree: NormalizedFileTreeState;
} {
  const directories: IFileNode[] = [];
  const expandedPaths = new Set<string>();
  for (let dirIndex = 0; dirIndex < 100; dirIndex += 1) {
    const dirPath = `/root/dir-${dirIndex}`;
    expandedPaths.add(dirPath);
    const files: IFileNode[] = [];
    for (let fileIndex = 0; fileIndex < 100; fileIndex += 1) {
      files.push(createFileNode(`${dirPath}/file-${fileIndex}.ts`));
    }
    directories.push(createDirectoryNode(dirPath, files));
  }
  return {
    options: {
      expandedDirectoryPaths: expandedPaths,
      folderId: 'root',
      loadingFiles: new Set<string>(),
    },
    tree: createNormalizedFileTreeState(directories),
  };
}

function buildRows(tree: NormalizedFileTreeState, options: BuildFileTreeRowsOptions) {
  return buildRowsFromNormalizedTree(
    tree,
    options,
    (path) => getNormalizedDescendantFileCount(tree, path),
    null
  );
}

describe('10k-row rebuild render counts', () => {
  it('re-renders zero rows on a content-equal rebuild WITH the reuse pass (every visible row without it)', () => {
    const { tree, options } = createTenThousandRowFixture();
    const firstRows = buildRows(tree, options);
    expect(firstRows.length).toBe(10_100);

    const cellRenders = vi.fn();
    const columns: TreeTableColumn<FileTreeRowData>[] = [
      {
        cell: ({ node }) => {
          cellRenders(node.id);
          return <span>{node.data.fileNode.name}</span>;
        },
        id: 'name',
      },
    ];
    const expandedIds = options.expandedDirectoryPaths;
    const onToggleExpand = () => {};

    const treeTableProps = {
      columns,
      expandedIds,
      nodesArePreFlattened: true,
      onToggleExpand,
      rowHeight: 32,
      selectionMode: 'single' as const,
      windowingStrategy: 'virtual' as const,
    };
    const view = render(<TreeTable {...treeTableProps} nodes={firstRows} />);
    const rendersAfterMount = cellRenders.mock.calls.length;
    expect(rendersAfterMount).toBeGreaterThanOrEqual(VISIBLE_ROW_COUNT);

    // OLD behavior (no adapter reuse): fresh TreeNode identities defeat
    // TreeTable's flatten reuse — every visible row re-renders.
    const rebuiltWithoutReuse = buildRows(tree, options);
    view.rerender(<TreeTable {...treeTableProps} nodes={rebuiltWithoutReuse} />);
    const rendersAfterUnsharedRebuild = cellRenders.mock.calls.length;
    expect(rendersAfterUnsharedRebuild - rendersAfterMount).toBeGreaterThanOrEqual(
      VISIBLE_ROW_COUNT
    );

    // NEW behavior: the reuse pass restores row identity, so the memo'd rows
    // all bail out — zero additional cell renders.
    const previousById = new Map(rebuiltWithoutReuse.map((row) => [row.id, row]));
    const stabilized = reuseEqualFileTreeRows(previousById, buildRows(tree, options));
    view.rerender(<TreeTable {...treeTableProps} nodes={stabilized} />);
    expect(cellRenders.mock.calls.length).toBe(rendersAfterUnsharedRebuild);
  });
});
