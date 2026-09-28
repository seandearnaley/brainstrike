import { type ActionOutcome, NO_CLOSED_TAB_OUTCOME } from '@brainstrike/context-actions';
import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useWorkspaceTabs, type WorkspaceTabsValue } from '../shell/use-workspace-tabs';
import type { WorkspaceApp } from '../shell/workspace-app';
import { WorkspaceTabStrip } from '../shell/workspace-tab-strip';
import { WorkspaceTabsProvider } from '../shell/workspace-tabs-context';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../stores/tab-manager-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import { stubMatchMedia } from './setup/stub-match-media';
import { FileExplorerTestWrapper } from './test-helpers';
import { CHANGES_APP, CHILD_CEDAR_APP, FILES_APP } from './workspace-tabs-test-support';

vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(() => ({
    canLoadWithoutTree: true,
    fileContentErrors: new Map<string, Error>(),
    fileContents: {},
    fileTree: [],
    loadFileContent: vi.fn().mockResolvedValue(undefined),
    loadingFiles: new Set<string>(),
    reloadFileContents: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...original,
    useTabFileRestoration: vi.fn(() => ({
      getStatusMessage: () => null,
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>(),
    })),
  };
});

const ROOT = { displayName: 'folderA', path: '/tmp/folderA', rootId: 'folderA' };
const key = (file: string): string => `folderA|@|src/${file}`;

type FileExplorerStore = ReturnType<typeof useFileExplorerStoreContext>;

const probe: { explorer: FileExplorerStore | null; tabs: WorkspaceTabsValue | null } = {
  explorer: null,
  tabs: null,
};

function Probe(): null {
  probe.explorer = useFileExplorerStoreContext();
  probe.tabs = useWorkspaceTabs();
  return null;
}

function workspace(): WorkspaceTabsValue {
  if (!probe.tabs) {
    throw new Error('workspace tabs not rendered');
  }
  return probe.tabs;
}

/** A fresh store per test: the shared adapter would replay a prior test's roots. */
let storage = new MemoryStorageAdapter();

function Harness({ apps }: { readonly apps: readonly WorkspaceApp[] }): React.ReactElement {
  return (
    <FileExplorerTestWrapper mockStorageAdapter={storage}>
      <WorkspaceTabsProvider apps={apps}>
        <WorkspaceTabStrip />
        <Probe />
      </WorkspaceTabsProvider>
    </FileExplorerTestWrapper>
  );
}

function renderHarness(apps: readonly WorkspaceApp[] = [FILES_APP, CHANGES_APP, CHILD_CEDAR_APP]) {
  stubMatchMedia();
  const view = render(<Harness apps={apps} />);
  act(() => probe.explorer?.getState().setActiveRoots([ROOT]));
  return view;
}

function fileTabIds(): readonly string[] {
  return useTabManagerStore.getState().tabs.map((tab) => tab.id);
}

async function reopen(): Promise<ActionOutcome | undefined> {
  let outcome: ActionOutcome | undefined;
  await act(async () => {
    outcome = await workspace().onReopenClosedTab();
  });
  return outcome;
}

beforeEach(() => {
  storage = new MemoryStorageAdapter();
  __resetTabManagerStoreForTests();
  __resetWorkspaceTabSelectionStoreForTests();
  const files = useTabManagerStore.getState();
  for (const file of ['a.ts', 'b.ts', 'c.ts']) {
    files.openTab(`src/${file}`, key(file), key(file));
  }
  const selection = useWorkspaceTabSelectionStore.getState();
  selection.openApp(CHANGES_APP.id);
  selection.openApp(CHILD_CEDAR_APP.id);
  selection.selectFile(key('a.ts'));
});

afterEach(() => {
  probe.explorer = null;
  probe.tabs = null;
  __resetTabManagerStoreForTests();
  __resetWorkspaceTabSelectionStoreForTests();
});

describe('workspace strip — tab order and dispatch for chords (BST-1842)', () => {
  it('lists every tab in the strip order: pinned apps, child conversations, then files', () => {
    renderHarness();
    const stripTabs = within(screen.getByRole('tablist', { name: 'Workspace tabs' }))
      .getAllByRole('tab')
      .map((tab) => tab.textContent);

    expect(workspace().tabOrder).toEqual([
      { id: FILES_APP.id, label: 'Files' },
      { id: CHANGES_APP.id, label: 'Changes' },
      { id: CHILD_CEDAR_APP.id, label: 'Cedar' },
      { id: key('a.ts'), label: 'a.ts' },
      { id: key('b.ts'), label: 'b.ts' },
      { id: key('c.ts'), label: 'c.ts' },
    ]);
    expect(workspace().tabOrder.map((tab) => tab.label)).toEqual(stripTabs);
  });

  it('activates and closes an app or a file tab by id', () => {
    renderHarness();

    act(() => workspace().onActivateTab(CHANGES_APP.id));
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: CHANGES_APP.id,
      kind: 'app',
    });
    act(() => workspace().onActivateTab(key('c.ts')));
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: key('c.ts'),
    });

    act(() => workspace().onCloseTab(key('b.ts')));
    act(() => workspace().onCloseTab(CHANGES_APP.id));
    expect(fileTabIds()).toEqual([key('a.ts'), key('c.ts')]);
    expect(useWorkspaceTabSelectionStore.getState().openAppIds).not.toContain(CHANGES_APP.id);
  });
});

describe('workspace strip — closed-tab history (BST-1842)', () => {
  it('reopens a ✕-closed file tab at its old index and activates it', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByTitle('Close b.ts'));
    expect(fileTabIds()).toEqual([key('a.ts'), key('c.ts')]);

    expect(await reopen()).toEqual({ ok: true });
    expect(fileTabIds()).toEqual([key('a.ts'), key('b.ts'), key('c.ts')]);
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: key('b.ts'),
    });
  });

  it('records a menu bulk close so consecutive reopens rebuild the old order', async () => {
    const user = userEvent.setup();
    renderHarness();

    fireEvent.contextMenu(screen.getByRole('tab', { name: /a\.ts/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close to the Right' }));
    expect(fileTabIds()).toEqual([key('a.ts')]);

    await reopen();
    await reopen();
    expect(fileTabIds()).toEqual([key('a.ts'), key('b.ts'), key('c.ts')]);
  });

  it('records Close Others and Close All Files', async () => {
    const user = userEvent.setup();
    renderHarness();

    fireEvent.contextMenu(screen.getByRole('tab', { name: /b\.ts/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close Others' }));
    fireEvent.contextMenu(screen.getByRole('tablist', { name: 'Workspace tabs' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close All Files' }));
    expect(fileTabIds()).toEqual([]);

    await reopen();
    await reopen();
    await reopen();
    expect(fileTabIds()).toEqual([key('a.ts'), key('b.ts'), key('c.ts')]);
  });

  it('reopens a closed app tab, including a bulk app close', async () => {
    const user = userEvent.setup();
    renderHarness();

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Files/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close Others' }));
    expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
      FILES_APP.id,
      CHILD_CEDAR_APP.id,
    ]);

    expect(await reopen()).toEqual({ ok: true });
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: CHANGES_APP.id,
      kind: 'app',
    });
  });

  it('skips a file whose folder was disconnected, and an app no longer registered', async () => {
    const view = renderHarness();
    act(() => workspace().onCloseTab(CHILD_CEDAR_APP.id));
    act(() => workspace().onCloseTab(key('c.ts')));
    act(() => probe.explorer?.getState().removeActiveRoot(ROOT.rootId));
    view.rerender(<Harness apps={[FILES_APP, CHANGES_APP]} />);

    expect(await reopen()).toEqual({
      error: '"c.ts" can no longer be reopened: its folder is not connected',
      ok: false,
    });
    expect(await reopen()).toEqual({
      error: 'Cedar can no longer be reopened: it is not available',
      ok: false,
    });
    expect(await reopen()).toEqual(NO_CLOSED_TAB_OUTCOME);
    expect(fileTabIds()).toEqual([key('a.ts'), key('b.ts')]);
  });

  it('enables Reopen Closed Tab on the strip background only once a tab has closed', async () => {
    const user = userEvent.setup();
    renderHarness();
    const background = screen.getByRole('tablist', { name: 'Workspace tabs' });
    expect(workspace().hasClosedTabs()).toBe(false);

    fireEvent.contextMenu(background);
    expect(await screen.findByRole('menuitem', { name: 'Reopen Closed Tab' })).toHaveAttribute(
      'data-disabled'
    );
    await user.keyboard('{Escape}');

    await user.click(screen.getByTitle('Close b.ts'));
    expect(workspace().hasClosedTabs()).toBe(true);
    fireEvent.contextMenu(background);
    const reopenItem = await screen.findByRole('menuitem', { name: 'Reopen Closed Tab' });
    expect(reopenItem).not.toHaveAttribute('data-disabled');
    await user.click(reopenItem);

    await waitFor(() => expect(fileTabIds()).toEqual([key('a.ts'), key('b.ts'), key('c.ts')]));
    expect(workspace().hasClosedTabs()).toBe(false);
  });

  it('only activates a closed file tab that was opened again in the meantime', async () => {
    renderHarness();
    act(() => workspace().onCloseTab(key('a.ts')));
    act(() => useTabManagerStore.getState().openTab('src/a.ts', key('a.ts'), key('a.ts')));

    expect(await reopen()).toEqual({ ok: true });
    expect(fileTabIds()).toEqual([key('b.ts'), key('c.ts'), key('a.ts')]);
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: key('a.ts'),
    });
  });
});
