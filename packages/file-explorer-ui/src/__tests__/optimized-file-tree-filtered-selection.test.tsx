import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileTreeNormalizedContextValue } from '../tree/file-tree-provider';
import {
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
  listNormalizedDescendantFilePaths,
  materializeNormalizedSubtree,
  type NormalizedFileTreeState,
} from '../utils/normalized-file-tree';

// Inject a REAL NormalizedFileTreeState through the provider seam so the
// component exercises its normalized (desktop) branch — the raw/unfiltered
// tree — while the fileTree prop carries the FILTERED display tree, exactly
// like the live panel under an active view/quick filter.
let mockNormalizedContext: FileTreeNormalizedContextValue | null = null;

vi.mock('../tree/file-tree-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tree/file-tree-provider')>();
  return {
    ...actual,
    useOptionalFileTreeNormalizedContext: () => mockNormalizedContext,
  };
});

// Count the display-tree path-collection walks (the filteredPathSet build).
// An unfiltered display tree must skip this O(N) traversal entirely.
const collectTreePathsCalls = { count: 0 };

vi.mock('../tree/optimized-file-tree-selection-counts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../tree/optimized-file-tree-selection-counts')>();
  return {
    ...actual,
    collectTreePaths: (nodes: IFileNode[], pathSet: Set<string>) => {
      collectTreePathsCalls.count += 1;
      return actual.collectTreePaths(nodes, pathSet);
    },
  };
});

import OptimizedFileTree from '../tree/optimized-file-tree';
import { type FileExplorerStore, StoreHandleBridge } from './optimized-file-tree-test-support';
import { FileExplorerTestWrapper } from './test-helpers';

function fileNode(path: string, depth: number): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    depth,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  };
}

function directoryNode(path: string, children: IFileNode[], depth = 0): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    children,
    depth,
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

function createNormalizedContext(state: NormalizedFileTreeState): FileTreeNormalizedContextValue {
  return {
    getDescendantFileCount: (path) => getNormalizedDescendantFileCount(state, path),
    getDescendantFilePaths: (path, maxCount) =>
      listNormalizedDescendantFilePaths(state, path, maxCount),
    materializeSubtree: (path) => materializeNormalizedSubtree(state, path),
    normalizedTreeRef: { current: state },
    version: 1,
  };
}

/** Full tree /src[a.ts, b.md]; display tree filtered to *.ts (a.ts only). */
function setupFilteredWorkspace() {
  const fullTree = [directoryNode('/src', [fileNode('/src/a.ts', 1), fileNode('/src/b.md', 1)])];
  mockNormalizedContext = createNormalizedContext(createNormalizedFileTreeState(fullTree));
  const displayTree = [directoryNode('/src', [fileNode('/src/a.ts', 1)])];
  return displayTree;
}

async function renderFilteredTree(
  displayTree: IFileNode[],
  extraProps?: { isDisplayTreeFiltered?: boolean }
) {
  let fileExplorerStore: FileExplorerStore | undefined;
  render(
    <FileExplorerTestWrapper>
      <StoreHandleBridge
        onStoreReady={(store) => {
          fileExplorerStore = store;
        }}
      />
      <OptimizedFileTree
        fileTree={displayTree}
        folderId="root"
        loadingFiles={new Set()}
        {...extraProps}
      />
    </FileExplorerTestWrapper>
  );
  await act(async () => {
    await Promise.resolve();
  });
  if (!fileExplorerStore) {
    throw new Error('File explorer store is unavailable in test');
  }
  const readyStore = fileExplorerStore;
  await act(async () => {
    readyStore.getState().clearSelectedFiles();
    readyStore.getState().setMaxSelectionCount(100);
    await Promise.resolve();
  });
  return readyStore;
}

describe('OptimizedFileTree selection under an active filter (normalized path)', () => {
  // Decision D2 (docs/explorer-tristate-spike-2026-07-11.md §5): folder
  // clicks SELECT the visible (filtered) set only; deselect always clears
  // hidden residue too.

  it('renders a folder checked when every VISIBLE file is selected', async () => {
    const store = await renderFilteredTree(setupFilteredWorkspace());

    await act(async () => {
      store.getState().toggleSelectedFile('root', '/src/a.ts');
      await Promise.resolve();
    });

    // The visible universe (/src/a.ts) is fully selected — the checkbox must
    // not read indeterminate against the raw (unfiltered) descendant total.
    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'checked');
  });

  it('selects only the visible files when clicking a filtered folder', async () => {
    const store = await renderFilteredTree(setupFilteredWorkspace());

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });

    // The hidden /src/b.md must NOT enter the selection (and thus the
    // context export) from a click on the filtered folder.
    expect(Array.from(store.getState().selectedFilePaths)).toEqual([
      encodeFileSelection('root', '/src/a.ts'),
    ]);
  });

  it('renders a folder checked when the filter empties a visible subdirectory', async () => {
    // Workspace filters KEEP a directory whose contents are all filtered out
    // (filter-engine.ts), so /pkg shows [a.ts, sub(empty)]. Selecting a.ts —
    // every visible file — must read checked; the raw counts of the emptied
    // sub/ must not drag the parent to indeterminate (spike B5).
    const fullTree = [
      directoryNode('/pkg', [
        fileNode('/pkg/a.ts', 1),
        directoryNode('/pkg/sub', [fileNode('/pkg/sub/x.md', 2), fileNode('/pkg/sub/y.md', 2)], 1),
      ]),
    ];
    mockNormalizedContext = createNormalizedContext(createNormalizedFileTreeState(fullTree));
    const displayTree = [
      directoryNode('/pkg', [fileNode('/pkg/a.ts', 1), directoryNode('/pkg/sub', [], 1)]),
    ];
    const store = await renderFilteredTree(displayTree);

    await act(async () => {
      store.getState().toggleSelectedFile('root', '/pkg/a.ts');
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select pkg')).toHaveAttribute('data-state', 'checked');
  });

  it('clears hidden selected residue when deselecting the folder', async () => {
    const store = await renderFilteredTree(setupFilteredWorkspace());

    await act(async () => {
      // b.md was selected before the filter hid it.
      store.getState().addSelectedFile('root', '/src/a.ts');
      store.getState().addSelectedFile('root', '/src/b.md');
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });

    // Deselect sweeps ALL selected descendants, hidden included — never
    // leave invisible residue behind (asymmetric with select on purpose).
    expect(store.getState().selectedFilePaths).toEqual(new Set());
  });
});

describe('OptimizedFileTree filteredPathSet skip for unfiltered display trees', () => {
  // PR #1734 audit follow-up: when the caller declares the display tree
  // UNFILTERED, the O(N) full-tree path collection must be skipped — the
  // normalized tree's raw O(1) maps already cover the whole visible universe.

  it('skips the path-set walk when isDisplayTreeFiltered is false', async () => {
    const fullTree = [directoryNode('/src', [fileNode('/src/a.ts', 1), fileNode('/src/b.md', 1)])];
    mockNormalizedContext = createNormalizedContext(createNormalizedFileTreeState(fullTree));
    collectTreePathsCalls.count = 0;

    const store = await renderFilteredTree(fullTree, { isDisplayTreeFiltered: false });

    expect(collectTreePathsCalls.count).toBe(0);

    // Behavior parity: a folder click still selects every (raw) descendant.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });
    expect(new Set(store.getState().selectedFilePaths)).toEqual(
      new Set([encodeFileSelection('root', '/src/a.ts'), encodeFileSelection('root', '/src/b.md')])
    );
  });

  it('still builds the path set when isDisplayTreeFiltered is true (D2 visible-universe rules)', async () => {
    const displayTree = setupFilteredWorkspace();
    collectTreePathsCalls.count = 0;

    const store = await renderFilteredTree(displayTree, { isDisplayTreeFiltered: true });

    expect(collectTreePathsCalls.count).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select src'));
    });
    // Only the VISIBLE file enters the selection — the filtered universe rules.
    expect(Array.from(store.getState().selectedFilePaths)).toEqual([
      encodeFileSelection('root', '/src/a.ts'),
    ]);
  });

  it('defaults to building the path set when the caller does not declare filtering', async () => {
    // Legacy call sites (no isDisplayTreeFiltered prop) must keep today's
    // conservative behavior: the display tree may be filtered, so the
    // restriction set is built.
    const displayTree = setupFilteredWorkspace();
    collectTreePathsCalls.count = 0;

    await renderFilteredTree(displayTree);

    expect(collectTreePathsCalls.count).toBeGreaterThan(0);
  });
});
