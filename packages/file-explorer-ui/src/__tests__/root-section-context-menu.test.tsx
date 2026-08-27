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
    // activeRootIds must include the rendered roots' ids — Set as Main's
    // `!activeRootIds.includes(target.rootId)` gate (BST-1393 review
    // fold-in) would otherwise reject every claim in this harness, since the
    // store's default is `[]` and nothing here goes through the normal
    // addActiveRoot flow.
    storeRef.current?.setState({
      activeRootIds: [ROOT_ID_A, ROOT_ID_B, ROOT_ID_FSA],
      setMainRoot: setMainRootMock,
    });
  });

  return { removeRootMock, setMainRootMock };
}

/**
 * The single-root layout's own equivalent of `renderRootSections` (BST-1393
 * review fold-in): that branch has no `RootSectionHeader`/forest sections at
 * all, so it needs its own render helper rather than reusing the
 * three-handle forest harness above. `onRemoveRoot` defaults to a mock (so
 * Disconnect… is present, matching the golden-path call site in
 * file-explorer-panel.tsx) but can be omitted per-test to prove the gating
 * fix applies here too.
 */
function renderSingleRoot(
  options: {
    onRemoveRoot?: ((rootId: string, opts?: { deleteData?: boolean }) => Promise<void>) | null;
    rootActions?: readonly AnyContextAction[];
  } = {}
) {
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
  const onRemoveRoot =
    options.onRemoveRoot === null ? undefined : (options.onRemoveRoot ?? removeRootMock);

  act(() => {
    renderWithProviders(
      <div data-testid="explorer-scroll-root">
        <FileExplorerSidebar
          currentFolderId={ROOT_ID_A}
          filterError={null}
          isInitialLoad={false}
          isLoading={false}
          loadingFiles={new Set<string>()}
          mainRootId={ROOT_ID_B}
          onRemoveRoot={onRemoveRoot}
          quickFilteredTree={[]}
          rootActions={options.rootActions}
          rootDirectoryHandle={handleA}
          rootIdByPath={new Map([[handleA.path, ROOT_ID_A]])}
          setFocusedRoot={vi.fn()}
          treeError={null}
        />
      </div>
    );
  });

  return { removeRootMock };
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

  it('claims path: null for a web FSA root — a web FSA handle path IS its name', async () => {
    // Durable invariant (packages/types/src/file-system.ts: "on web `path`
    // is only the directory name"): a web FSA handle has no absolute path
    // distinct from its name, so the claimed target's `path` must be `null`.
    // `claimRootTarget` hoists ONE `rootPath` normalization
    // (file-explorer-sidebar.tsx) shared by both the claimed target and the
    // header's tooltip `path` prop, so this is the single source of that
    // behavior, not two independently-written checks that happen to agree.
    // Reuse the `rootActions` spy seam to observe the claimed target rather
    // than reaching into internal state.
    //
    // This root section's `rootDirectoryHandle` is a real web FSA shape:
    // `{ name: 'notes', path: 'notes', platform: 'web' }` — name and path
    // IDENTICAL. It deliberately does not reuse the existing
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
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kind: 'workspace-root', path: null });
  });

  it('cross-section isolation: claiming B after A never carries a stale target between sections', async () => {
    // (Delta-review correction: this test's PRIOR name/comment claimed to be
    // "the real falsifier for the capture-phase reset protocol" — that
    // overclaimed. `onContextMenu={claimRootTarget}` sits on RootSectionHeader's
    // OWN root div, and every descendant inside it bubbles a contextmenu
    // event up to that same div — there is no reachable non-claiming gap
    // inside this wrapper on the current surface. Each section also owns an
    // INDEPENDENT `useContextMenuTarget()` controller and its own separate
    // Radix ContextMenuTrigger boundary, so right-clicking header B always
    // calls B's own claim with B's own controller regardless of whether
    // `resetRootTarget`'s capture-phase handler ran at all — delete the
    // reset entirely and this test still passes. What this DOES prove, with
    // a genuine positive control (claim A, close, claim B, assert B's own
    // rootId is what the injected action receives): cross-section isolation
    // — B's claimed target is never A's. `resetRootTarget` itself remains in
    // place as the convention-mandated defense `ui-conventions.md`'s
    // reset-then-claim protocol requires of every context-menu surface
    // (defense-in-depth against a FUTURE structural change that introduces a
    // non-claiming region inside a wrapper); it has no reachable failure
    // path to falsify on THIS surface today. The prior version of this test
    // (`fireEvent.contextMenu` on `explorer-scroll-root`, an ANCESTOR of
    // every trigger) was worse than this: that event never even propagates
    // through any trigger's `onContextMenu`, so no root menu could open
    // regardless of anything — deleting `claimRootTarget` entirely left it
    // green.
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
    const headerA = screen.getAllByTestId('root-section-header-row')[0];
    const headerB = screen.getAllByTestId('root-section-header-row')[1];
    if (!(headerA && headerB)) {
      throw new Error('expected two root header rows');
    }

    fireEvent.contextMenu(headerA);
    expect(await screen.findByText('Probe')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('Probe')).not.toBeInTheDocument();
    });

    fireEvent.contextMenu(headerB);
    fireEvent.click(await screen.findByText('Probe'));
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kind: 'workspace-root', rootId: ROOT_ID_B });
  });
});

describe('single-root header menu (BST-1393 review fold-in)', () => {
  // The primary (one-folder) workspace scenario had NO trigger for any of
  // the five workspace-root actions: `RootSectionInner` and its
  // `ActionContextMenu` are instantiated only when `isForestMode`
  // (rootDirectoryHandles.length > 1). This suite proves the single-root
  // layout's own header row is a real, working trigger for the same menu.
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetBackgroundIndexingPreferencesStoreForTests();
  });

  afterEach(async () => {
    await closeMenuAndFlushFocusRestore();
  });

  it('opens a root menu whose items reflect the claimed target', async () => {
    renderSingleRoot();
    const header = screen.getByTestId('single-root-header-row');
    fireEvent.contextMenu(header);
    expect(await screen.findByText('Set as Main')).toBeInTheDocument();
    expect(screen.getByText('Disconnect…')).toBeInTheDocument();
  });

  it('OMITS Disconnect… when onRemoveRoot is absent, mirroring the forest gating fix', async () => {
    renderSingleRoot({ onRemoveRoot: null });
    const header = screen.getByTestId('single-root-header-row');
    fireEvent.contextMenu(header);
    expect(await screen.findByText('Set as Main')).toBeInTheDocument();
    expect(screen.queryByText('Disconnect…')).not.toBeInTheDocument();
  });

  it('renders injected host actions on the single-root trigger, receiving the claimed target', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    renderSingleRoot({
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
    const header = screen.getByTestId('single-root-header-row');
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

  it('Disconnect… STAGES the dialog and removes nothing', async () => {
    const { removeRootMock } = renderSingleRoot();
    const header = screen.getByTestId('single-root-header-row');
    fireEvent.contextMenu(header);
    fireEvent.click(await screen.findByText('Disconnect…'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(removeRootMock).not.toHaveBeenCalled();
  });
});
