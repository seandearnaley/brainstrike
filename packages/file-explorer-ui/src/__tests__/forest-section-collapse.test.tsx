/**
 * BST-571: forest Expand All / Collapse All must affect the root sections
 * themselves, not only the directory expansion set.
 *
 * Two pinned behaviors:
 * - A COLLAPSED section must stay registered with the forest registry (its
 *   registration lives in RootSectionInner, above the collapse branch). Before
 *   the fix, collapsing a section unmounted PerRootTreePane and unregistered
 *   it, so Expand All / Select All silently skipped that root.
 * - Collapse All closes every section header; Expand All reopens each section
 *   as the sweep reaches it.
 */
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { composeWrappers, createFileNode, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import {
  ForestTreeActionsProvider,
  type ForestTreeActionsValue,
  useOptionalForestTreeActions,
} from '../shell/forest-tree-actions-context';
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
        ? [createFileNode({ name: 'a1.ts', path: '/project-a/a1.ts', rootFolderId: ROOT_ID_A })]
        : [createFileNode({ name: 'b1.ts', path: '/project-b/b1.ts', rootFolderId: ROOT_ID_B })];
    onBatch(nodes, { done: true, total: nodes.length });
  });
  return adapter;
}

function renderForest() {
  const actionsRef: { current: ForestTreeActionsValue | null } = { current: null };
  function ActionsProbe() {
    actionsRef.current = useOptionalForestTreeActions();
    return null;
  }
  const wrapper = composeWrappers(({ children }) => (
    <FileExplorerTestWrapper
      mockFileSystemAdapter={makeAdapter()}
      mockStorageAdapter={new MemoryStorageAdapter()}
    >
      {children}
    </FileExplorerTestWrapper>
  ));
  const renderWithProviders = makeRenderWithProviders(wrapper);
  act(() => {
    renderWithProviders(
      <ForestTreeActionsProvider>
        <ActionsProbe />
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
  return actionsRef;
}

async function waitForBothTrees() {
  await waitFor(() => {
    expect(screen.getByText('a1.ts')).toBeInTheDocument();
    expect(screen.getByText('b1.ts')).toBeInTheDocument();
  });
}

/** Header toggle buttons in section render order: [project-a, project-b]. */
function sectionHeaders(): HTMLElement[] {
  return screen.getAllByTestId('root-section-header');
}

describe('forest section collapse vs Expand All / Collapse All (BST-571)', () => {
  it('reopens a manually collapsed section when Expand All reaches it', async () => {
    const actionsRef = renderForest();
    await waitForBothTrees();

    // Collapse section B by clicking its header toggle.
    act(() => {
      fireEvent.click(sectionHeaders()[1] as HTMLElement);
    });
    expect(screen.queryByText('b1.ts')).toBeNull();
    expect(sectionHeaders()[1]).toHaveAttribute('aria-expanded', 'false');

    // Expand All must reach the COLLAPSED section too: it stays registered
    // (registration lives above the collapse branch) and its header reopens.
    await act(async () => {
      await actionsRef.current?.runExpandAll();
    });

    expect(sectionHeaders()[1]).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => {
      expect(screen.getByText('b1.ts')).toBeInTheDocument();
    });
  });

  it('reserves clearance on the first section header for the floating tree actions cluster', async () => {
    renderForest();
    await waitForBothTrees();

    // The floating Expand/Collapse cluster pins to the tree area's top-right
    // (top-2 right-2, ~56px wide). At scrollTop 0 the FIRST root section
    // header occupies that band, so its trailing controls (the hover-revealed
    // disconnect X) would sit under the cluster and lose their pointer
    // clicks. The first header alone reserves matching right clearance;
    // later headers keep the full row (they only pass under the cluster
    // transiently while scrolling).
    const headerRows = screen.getAllByTestId('root-section-header-row');
    expect(headerRows[0]).toHaveClass('pr-16');
    expect(headerRows[1]).not.toHaveClass('pr-16');
  });

  it('collapseAllSections closes every root section header', async () => {
    const actionsRef = renderForest();
    await waitForBothTrees();

    act(() => {
      actionsRef.current?.collapseAllSections();
    });

    for (const header of sectionHeaders()) {
      expect(header).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByText('a1.ts')).toBeNull();
    expect(screen.queryByText('b1.ts')).toBeNull();
  });
});
