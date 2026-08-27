import { __resetBackgroundIndexingPreferencesStoreForTests } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { type AnyContextAction, defineContextAction } from '@brainstrike/context-actions';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import { FileExplorerTestWrapper } from './test-helpers';

const ROOT_ID_A = 'root-1';
const ROOT_ID_B = 'root-2';
const ROOT_ID_FSA = 'root-fsa';

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
const fsaHandle = {
  _internal: {} as FileSystemDirectoryHandle,
  kind: 'directory' as const,
  name: 'notes',
  path: 'notes',
  platform: 'web' as const,
};

async function closeMenuAndFlushFocusRestore(): Promise<void> {
  if (screen.queryByRole('menu')) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function renderRootSections(options: { rootActions?: readonly AnyContextAction[] } = {}) {
  const adapter = new MockFileSystemAdapter();
  vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
    async (_handle, onBatch, _options) => {
      onBatch([], { done: true, total: 0 });
    }
  );
  const storageAdapter = new MemoryStorageAdapter();
  const Wrapper = composeWrappers(({ children }) => (
    <FileExplorerTestWrapper mockFileSystemAdapter={adapter} mockStorageAdapter={storageAdapter}>
      {children}
    </FileExplorerTestWrapper>
  ));
  const renderWithProviders = makeRenderWithProviders(Wrapper);
  const removeRootMock = vi.fn().mockResolvedValue(undefined);
  const setMainRootMock = vi.fn();
  const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
    current: null,
  };

  function StoreProbe() {
    storeRef.current = useFileExplorerStoreContext();
    return null;
  }

  act(() => {
    renderWithProviders(
      <>
        <StoreProbe />
        <div data-testid="explorer-scroll-root">
          <FileExplorerSidebar
            currentFolderId={ROOT_ID_A}
            filterError={null}
            isInitialLoad={false}
            isLoading={false}
            loadingFiles={new Set<string>()}
            mainRootId={ROOT_ID_B}
            onRemoveRoot={removeRootMock}
            quickFilteredTree={[]}
            rootActions={options.rootActions}
            rootDirectoryHandle={handleA}
            rootDirectoryHandles={[handleA, handleB, fsaHandle]}
            rootIdByPath={
              new Map([
                [handleA.path, ROOT_ID_A],
                [handleB.path, ROOT_ID_B],
                [fsaHandle.path, ROOT_ID_FSA],
              ])
            }
            setFocusedRoot={vi.fn()}
            treeError={null}
          />
        </div>
      </>
    );
  });
  act(() => {
    storeRef.current?.setState({ setMainRoot: setMainRootMock });
  });

  return { removeRootMock, setMainRootMock };
}

describe('root section context menu', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetBackgroundIndexingPreferencesStoreForTests();
  });

  afterEach(async () => {
    await closeMenuAndFlushFocusRestore();
  });

  it('opens a root menu whose items reflect the claimed target', async () => {
    renderRootSections();
    const header = screen.getAllByTestId('root-section-header-row')[0];
    if (!header) {
      throw new Error('expected a root header row');
    }
    fireEvent.contextMenu(header);
    expect(await screen.findByText('Set as Main')).toBeInTheDocument();
    expect(screen.getByText('Disconnect…')).toBeInTheDocument();
  });

  it('omits Set as Main on the root that already is Main', async () => {
    renderRootSections();
    const mainHeader = screen.getAllByTestId('root-section-header-row')[1];
    if (!mainHeader) {
      throw new Error('expected the Main root header row');
    }
    fireEvent.contextMenu(mainHeader);
    expect(await screen.findByText('Disconnect…')).toBeInTheDocument();
    expect(screen.queryByText('Set as Main')).not.toBeInTheDocument();
  });

  it('Set as Main calls setMainRoot with the row identity and disconnects nothing', async () => {
    const { removeRootMock, setMainRootMock } = renderRootSections();
    const header = screen.getAllByTestId('root-section-header-row')[0];
    if (!header) {
      throw new Error('expected a root header row');
    }
    fireEvent.contextMenu(header);
    fireEvent.click(await screen.findByText('Set as Main'));
    await waitFor(() => {
      expect(setMainRootMock).toHaveBeenCalledExactlyOnceWith(ROOT_ID_A);
    });
    expect(removeRootMock).not.toHaveBeenCalled();
  });

  it('Disconnect… STAGES the dialog and removes nothing', async () => {
    const { removeRootMock } = renderRootSections();
    const header = screen.getAllByTestId('root-section-header-row')[0];
    if (!header) {
      throw new Error('expected a root header row');
    }
    fireEvent.contextMenu(header);
    fireEvent.click(await screen.findByText('Disconnect…'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(removeRootMock).not.toHaveBeenCalled();
  });

  it('renders injected host actions alongside the local ones', async () => {
    // Proves the `rootActions` seam: an injected action reaches the menu and
    // receives the SAME claimed target.
    const run = vi.fn().mockResolvedValue({ ok: true });
    renderRootSections({
      rootActions: [
        defineContextAction({
          appliesTo: ['workspace-root'],
          group: 'navigate',
          id: 'test.injected',
          label: 'Injected',
          run,
        }),
      ],
    });
    const header = screen.getAllByTestId('root-section-header-row')[0];
    if (!header) {
      throw new Error('expected a root header row');
    }
    fireEvent.contextMenu(header);
    fireEvent.click(await screen.findByText('Injected'));
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      kind: 'workspace-root',
      rootId: ROOT_ID_A,
    });
  });

  it('claims path: null for a web FSA root, proving displayName === handle.name (Refinement A)', async () => {
    // Post-Task-2-review requirement. The adapter compares
    // `path !== displayName` (workspace-root-target.ts); this file's OWN
    // `<RootSectionHeader path={…}>` prop is built elsewhere by comparing
    // `path !== handle.name`. Those two independently-written equality
    // checks only agree because `claimRootTarget` passes
    // `displayName: rootDirectoryHandle.name` — this test is the falsifier
    // for a future edit that passes a DIFFERENT displayName (e.g. a
    // localized label) and silently breaks the null result. Reuse the
    // `rootActions` spy seam (same pattern as the previous test) to observe
    // the claimed target rather than reaching into internal state.
    //
    // This root section's `rootDirectoryHandle` is a real web FSA shape:
    // `{ name: 'notes', path: 'notes', platform: 'web' }` — name and path
    // IDENTICAL, per DirectoryHandle's documented web contract
    // (packages/types/src/file-system.ts: "on web `path` is only the
    // directory name"). It deliberately does not reuse the existing
    // file-explorer-sidebar.test.tsx fixture, whose path and name differ.
    const run = vi.fn().mockResolvedValue({ ok: true });
    renderRootSections({
      rootActions: [
        defineContextAction({
          appliesTo: ['workspace-root'],
          group: 'navigate',
          id: 'test.probe',
          label: 'Probe',
          run,
        }),
      ],
    });
    const fsaHeader = screen.getAllByTestId('root-section-header-row')[2];
    if (!fsaHeader) {
      throw new Error('expected the web FSA root header row');
    }
    fireEvent.contextMenu(fsaHeader);
    fireEvent.click(await screen.findByText('Probe'));
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    // path: null is ONLY possible if displayName reached the adapter equal
    // to the handle's path ('notes' === 'notes') — this assertion IS the
    // Refinement-A pin, not a restatement of it.
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kind: 'workspace-root', path: null });
  });

  it('opens NO menu when a right-click claims nothing', async () => {
    renderRootSections();
    await waitFor(() => {
      expect(screen.getAllByText('No files in this folder')).toHaveLength(3);
    });
    // The reset-then-claim protocol's falsifier: right-click the tree
    // container (outside any header) and assert no root menu items appear.
    fireEvent.contextMenu(screen.getByTestId('explorer-scroll-root'));
    expect(screen.queryByText('Disconnect…')).not.toBeInTheDocument();
  });
});
