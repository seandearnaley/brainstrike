/**
 * FOREST + metadata seam, composed (whole-branch review F2).
 *
 * Every other test in this package exercises ONE of these: the seam with a
 * single tree, or the forest without the seam. The defect only exists where
 * they meet — the panel owns the store and the background token indexer, but in
 * forest mode each `RootSection` mounts its own `FileTreeProvider` that the
 * panel never sees. Deriving the visible-file key set from the panel's own
 * `useFileExplorer()` tree therefore covered the FOCUSED root only: roots 2..N
 * got no visible/expanded token indexing at all, their Tokens cells stayed
 * `pending` forever, and because a rollup goes partial on the first pending
 * descendant their folder Size totals were dead too.
 *
 * So this renders the REAL forest sidebar underneath the REAL seam and asserts
 * the merged key set the panel would hand the indexer.
 */
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/file-tree-test-fixtures';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useExplorerRowMetadata } from '../indexing/file-row-metadata-context';
import { FileRowMetadataProvider } from '../indexing/file-row-metadata-provider';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import { ForestTreeActionsProvider } from '../shell/forest-tree-actions-provider';
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

const SINGLE_ROOT_DISPLAY_TREE = [
  createFileNode({ name: 'a1.ts', path: '/project-a/a1.ts', rootFolderId: ROOT_ID_A }),
];

function makeAdapter(): MockFileSystemAdapter {
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

/**
 * Stands in for `FileExplorerPanel`: owns the seam, and would forward
 * `visibleFileKeys` to `useBackgroundTokenIndexerIntegration`.
 */
function ForestPanelHarness({
  onVisibleKeys,
  rootDirectoryHandles,
}: {
  onVisibleKeys: (keys: ReadonlySet<string>) => void;
  rootDirectoryHandles: (typeof handleA)[];
}) {
  const rowMetadata = useExplorerRowMetadata();
  // Report from an effect, not during render: the real panel forwards these
  // keys to the indexer after commit, and a render React discards must not
  // publish keys for a tree that never mounted.
  useEffect(() => {
    onVisibleKeys(rowMetadata.visibleFileKeys);
  }, [onVisibleKeys, rowMetadata.visibleFileKeys]);
  return (
    <FileRowMetadataProvider value={rowMetadata.contextValue}>
      <ForestTreeActionsProvider>
        <FileExplorerSidebar
          currentFolderId={ROOT_ID_A}
          filterError={null}
          isInitialLoad={false}
          isLoading={false}
          loadingFiles={new Set<string>()}
          // Single-root mode renders from this panel-supplied display tree;
          // forest sections derive their own from their providers.
          quickFilteredTree={SINGLE_ROOT_DISPLAY_TREE}
          rootDirectoryHandle={handleA}
          rootDirectoryHandles={rootDirectoryHandles}
          rootIdByPath={
            new Map([
              ['/project-a', ROOT_ID_A],
              ['/project-b', ROOT_ID_B],
            ])
          }
          setFocusedRoot={vi.fn()}
          treeError={null}
        />
      </ForestTreeActionsProvider>
    </FileRowMetadataProvider>
  );
}

function renderForest(rootDirectoryHandles = [handleA, handleB]): {
  latest: () => ReadonlySet<string>;
} {
  let latestKeys: ReadonlySet<string> = new Set<string>();
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
      <ForestPanelHarness
        onVisibleKeys={(keys) => {
          latestKeys = keys;
        }}
        rootDirectoryHandles={rootDirectoryHandles}
      />
    );
  });
  return { latest: () => latestKeys };
}

describe('forest visible-file token indexing', () => {
  it('covers EVERY mounted root, not just the focused one', async () => {
    const { latest } = renderForest();

    await waitFor(() => {
      expect(screen.getByText('a1.ts')).toBeInTheDocument();
      expect(screen.getByText('b1.ts')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect([...latest()].sort()).toEqual([
        `${ROOT_ID_A}|@|/project-a/a1.ts`,
        `${ROOT_ID_B}|@|/project-b/b1.ts`,
      ]);
    });
  });

  it('withdraws a section’s keys when it collapses', async () => {
    const user = userEvent.setup();
    const { latest } = renderForest();
    await waitFor(() => {
      expect(latest().size).toBe(2);
    });

    // Collapsing unmounts that section's tree; its files are no longer on
    // screen, so the indexer must stop being asked for them.
    await user.click(screen.getByRole('button', { name: /project-b/i }));

    await waitFor(() => {
      expect([...latest()]).toEqual([`${ROOT_ID_A}|@|/project-a/a1.ts`]);
    });
  });

  it('publishes the single-root key set unchanged', async () => {
    const { latest } = renderForest([handleA]);

    await waitFor(() => {
      expect(screen.getByText('a1.ts')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect([...latest()]).toEqual([`${ROOT_ID_A}|@|/project-a/a1.ts`]);
    });
  });
});
