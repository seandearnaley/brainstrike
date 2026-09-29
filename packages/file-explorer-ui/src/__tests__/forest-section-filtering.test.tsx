/**
 * Forest sections must apply the workspace view filters ONCE per section:
 * the section header's select-all checkbox and the tree pane share a single
 * filtered-tree derivation (PR #1734 audit follow-up). Before the fix each
 * of them independently re-filtered the whole root tree — two full O(N)
 * passes per section per tree commit.
 */
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/file-tree-test-fixtures';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Count applyFileFilters tree walks per (input-tree identity, filter values)
// pair. Two components filtering the same tree under the same filters each
// memoize their own pass — a duplicated derivation shows up as 2 passes for
// one input. A filter-value change legitimately re-filters the same tree, so
// the filters participate in the key.
const treeIds = new WeakMap<IFileNode[], number>();
let nextTreeId = 0;
const filterPassesByInput = new Map<string, number>();

vi.mock('@brainstrike/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/hooks')>();
  return {
    ...actual,
    useFileFilters: () => {
      const real = actual.useFileFilters();
      return {
        ...real,
        applyFileFilters: (
          tree: IFileNode[],
          includeFilters: string[],
          excludeFilters?: string[],
          useRegex?: boolean
        ) => {
          if (tree.length > 0) {
            let treeId = treeIds.get(tree);
            if (treeId === undefined) {
              nextTreeId += 1;
              treeId = nextTreeId;
              treeIds.set(tree, treeId);
            }
            const key = `${treeId}:${includeFilters.join(',')}|${(excludeFilters ?? []).join(',')}|${useRegex === true}`;
            filterPassesByInput.set(key, (filterPassesByInput.get(key) ?? 0) + 1);
          }
          return real.applyFileFilters(tree, includeFilters, excludeFilters, useRegex);
        },
      };
    },
  };
});

import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import { ForestTreeActionsProvider } from '../shell/forest-tree-actions-provider';
import { resolveSectionDisplayFilterFlag } from '../utils/quick-filter-tree';
import { FileExplorerTestWrapper } from './test-helpers';

const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

const handleA = {
  _internal: {} as FileSystemDirectoryHandle,
  kind: 'directory' as const,
  name: 'project-a',
  path: '/project-a',
  platform: 'web' as const,
};
const handleB = {
  _internal: {} as FileSystemDirectoryHandle,
  kind: 'directory' as const,
  name: 'project-b',
  path: '/project-b',
  platform: 'web' as const,
};

const defaultProps = {
  currentFolderId: ROOT_ID_A,
  filterError: null,
  isInitialLoad: false,
  isLoading: false,
  loadingFiles: new Set<string>(),
  onTreeRender: vi.fn(),
  quickFilteredTree: null,
  rootDirectoryHandle: handleA,
  treeError: null,
};

function makeAdapter() {
  const adapter = new MockFileSystemAdapter();
  vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(async (handle, onBatch) => {
    const nodes =
      handle.path === '/project-a'
        ? [
            createFileNode({ name: 'a1.ts', path: '/project-a/a1.ts', rootFolderId: ROOT_ID_A }),
            createFileNode({ name: 'a2.md', path: '/project-a/a2.md', rootFolderId: ROOT_ID_A }),
          ]
        : [createFileNode({ name: 'b1.ts', path: '/project-b/b1.ts', rootFolderId: ROOT_ID_B })];
    onBatch(nodes, { done: true, total: nodes.length });
  });
  return adapter;
}

function renderForest(adapter: MockFileSystemAdapter) {
  const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
    current: null,
  };
  function StoreProbe() {
    storeRef.current = useFileExplorerStoreContext();
    return null;
  }
  const wrapper = composeWrappers(({ children }) => (
    <FileExplorerTestWrapper
      mockFileSystemAdapter={adapter}
      mockStorageAdapter={new MemoryStorageAdapter()}
    >
      {children}
    </FileExplorerTestWrapper>
  ));
  const renderWithProviders = makeRenderWithProviders(wrapper);
  act(() => {
    renderWithProviders(
      <ForestTreeActionsProvider>
        <StoreProbe />
        <FileExplorerSidebar
          {...defaultProps}
          rootDirectoryHandles={[handleA, handleB]}
          rootIdByPath={
            new Map([
              ['/project-a', ROOT_ID_A],
              ['/project-b', ROOT_ID_B],
            ])
          }
          setFocusedRoot={vi.fn()}
        />
      </ForestTreeActionsProvider>
    );
  });
  return storeRef;
}

describe('forest section shared view-filter derivation', () => {
  beforeEach(() => {
    filterPassesByInput.clear();
    vi.clearAllMocks();
  });

  it('filters each section tree at most once per tree commit (header + pane share the pass)', async () => {
    const storeRef = renderForest(makeAdapter());
    act(() => {
      storeRef.current?.getState().setCurrentFolderId(ROOT_ID_A);
      // Active include filter → applyFileFilters takes its real tree walk.
      storeRef.current?.getState().setFilters(['*.ts'], []);
    });

    await waitFor(() => {
      expect(screen.getByText('a1.ts')).toBeInTheDocument();
      expect(screen.getByText('b1.ts')).toBeInTheDocument();
    });
    // The *.md file is hidden by the view filter.
    expect(screen.queryByText('a2.md')).toBeNull();

    // Every unique tree input was filtered exactly once — the section header
    // checkbox and the tree pane consume ONE shared derivation instead of
    // duplicating the full-tree walk.
    const passCounts = Array.from(filterPassesByInput.values());
    expect(passCounts.length).toBeGreaterThan(0);
    expect(Math.max(...passCounts)).toBe(1);
  });

  it('keeps the header checkbox tristate in agreement with the shared filtered tree', async () => {
    const storeRef = renderForest(makeAdapter());
    act(() => {
      storeRef.current?.getState().setCurrentFolderId(ROOT_ID_A);
      storeRef.current?.getState().setFilters(['*.ts'], []);
    });
    await waitFor(() => {
      expect(screen.getByText('a1.ts')).toBeInTheDocument();
    });

    // Only a1.ts is visible under the filter; selecting it covers the whole
    // visible universe, so the section checkbox must read fully checked (the
    // hidden a2.md must not drag it to indeterminate).
    act(() => {
      storeRef.current?.getState().addSelectedFile(ROOT_ID_A, '/project-a/a1.ts');
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Select all in project-a')).toHaveAttribute(
        'data-state',
        'checked'
      );
    });
  });
});

describe('resolveSectionDisplayFilterFlag (deferred-tree guard)', () => {
  const treeA: IFileNode[] = [];
  const treeB: IFileNode[] = [];
  const treeC: IFileNode[] = [];

  it('reports filtered when the display tree diverged from the deferred input', () => {
    expect(
      resolveSectionDisplayFilterFlag({
        canonicalTree: treeA,
        deferredTree: treeA,
        displayTree: treeB,
      })
    ).toBe(true);
  });

  it('only claims unfiltered once the deferred tree caught up to the canonical tree', () => {
    expect(
      resolveSectionDisplayFilterFlag({
        canonicalTree: treeA,
        deferredTree: treeA,
        displayTree: treeA,
      })
    ).toBe(false);
  });

  it('falls back to the conservative build while the deferred tree lags', () => {
    // Codex review (PR #1740): during an expand-all/lazy-load burst the
    // normalized universe is newer than the displayed (deferred) tree —
    // `false` here would render that newer universe unrestricted and defeat
    // the deferral. Undefined keeps the legacy path-set restriction.
    expect(
      resolveSectionDisplayFilterFlag({
        canonicalTree: treeC,
        deferredTree: treeA,
        displayTree: treeA,
      })
    ).toBeUndefined();
  });
});
