import { createTestActionRegistry } from '@brainstrike/context-actions';
import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileEntryActions } from '../context-actions';
import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  TERMINAL_APP_ID,
  WORKTREE_MAP_APP_ID,
} from '../shell/workspace-app';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../stores/tab-manager-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import {
  CANVAS_APP,
  CHANGES_APP,
  CHILD_CEDAR_APP,
  CHILD_FLINT_APP,
  FILES_APP,
  renderWorkspace,
} from './workspace-tabs-test-support';

vi.mock('../shell/file-tab-explorer-pane', () => ({
  FileTabExplorerPane: () => <div data-testid="pane-spy" />,
}));

vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(() => ({
    canLoadWithoutTree: false,
    fileContentErrors: new Map<string, Error>(),
    fileContents: {},
    fileTree: [],
    loadFileContent: vi.fn().mockResolvedValue(undefined),
    loadingFiles: new Set<string>(),
    loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
    rootDirectoryHandle: null,
  })),
}));

vi.mock('../shell/use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(() => ({
    effectiveSelection: new Set<string>(),
    handleSelectionChange: vi.fn(),
    selectedFilePaths: new Set<string>(),
    selectedFilesList: [],
    setSelectedFilesFromList: vi.fn(),
    wouldExceedSelectionLimit: vi.fn(() => false),
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

const A = 'folderA|@|src/a.ts';
const B = 'folderA|@|src/b.ts';
const C = 'folderA|@|src/c.ts';

function openFileTabs(...ids: readonly string[]): void {
  for (const id of ids) {
    useTabManagerStore.getState().openTab(decodeFileSelection(id).path, id, id);
  }
}

function fileTabOrder(): readonly string[] {
  return useTabManagerStore.getState().tabs.map((tab) => tab.id);
}

function tabNamed(name: RegExp): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('workspace tab strip on the shared TabStrip', () => {
  let useTabFileRestoration: typeof import('@brainstrike/file-explorer-hooks').useTabFileRestoration;

  beforeAll(async () => {
    useTabFileRestoration = (await import('@brainstrike/file-explorer-hooks'))
      .useTabFileRestoration;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetWorkspaceTabSelectionStoreForTests();
    __resetTabManagerStoreForTests();
    const uiModule = await import('@brainstrike/ui');
    vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab: vi.fn(),
      registerOpenFileInTab: vi.fn(),
    });
  });

  afterEach(() => {
    __resetWorkspaceTabSelectionStoreForTests();
    __resetTabManagerStoreForTests();
  });

  describe('groups', () => {
    it('pins singleton apps and scrolls child conversations ahead of the file tabs', async () => {
      const store = useWorkspaceTabSelectionStore.getState();
      store.openApp(CHILD_CEDAR_APP.id);
      store.openApp(CHANGES_APP.id);
      openFileTabs(A, B);
      renderWorkspace([FILES_APP, CHANGES_APP, CHILD_CEDAR_APP]);

      const tablist = await screen.findByRole('tablist', { name: 'Workspace tabs' });
      const pinned = tablist.querySelector<HTMLElement>('[data-group="pinned"]');
      const scroll = screen.getByTestId('workspace-tab-scroll');
      expect(pinned).not.toBeNull();
      expect(
        within(pinned as HTMLElement)
          .getAllByRole('tab')
          .map((tab) => tab.id)
      ).toEqual(['workspace-app-tab-context-explorer', 'workspace-app-tab-changes']);
      expect(
        within(scroll)
          .getAllByRole('tab')
          .map((tab) => tab.id)
      ).toEqual([
        `workspace-app-tab-${CHILD_CEDAR_APP.id}`,
        `workspace-file-tab-${A}`,
        `workspace-file-tab-${B}`,
      ]);
      // Existing ids and test hooks survive the migration.
      const fileTab = screen.getByTestId(`workspace-file-tab-${A}`);
      expect(fileTab).toHaveAttribute('data-tab-id', A);
      expect(fileTab).toHaveAttribute('aria-controls', `workspace-file-panel-${A}`);
      expect(screen.getByTestId('workspace-app-tab-changes')).toHaveAttribute(
        'data-app-id',
        'changes'
      );
      expect(screen.getByTestId('workspace-app-tab-close-changes')).toHaveAttribute(
        'aria-hidden',
        'true'
      );
    });

    it('drops the old scroll chevrons and the "More tab actions" menu for the All-tabs menu', async () => {
      openFileTabs(A);
      renderWorkspace();

      await screen.findByRole('tab', { name: /a\.ts/i });
      expect(screen.queryByRole('button', { name: /scroll tabs/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /more tab actions/i })).toBeNull();
      const strip = screen.getByTestId('workspace-tab-strip');
      expect(within(strip).getByRole('button', { name: 'All tabs' })).toBeInTheDocument();
      expect(within(strip).getByTestId('workspace-add-tab')).toBeInTheDocument();
    });

    it('marks file-tab status in the icon slot and the accessible name', async () => {
      vi.mocked(useTabFileRestoration).mockReturnValue({
        getStatusMessage: (key: string) => (key === A ? 'Click to restore access' : null),
        isRestoring: false,
        needsUserAction: () => false,
        requestTabPermission: vi.fn().mockResolvedValue(true),
        restoreTabs: vi.fn().mockResolvedValue(undefined),
        tabStatuses: new Map<string, TabFileStatus>([
          [A, { compositeKey: A, status: 'needs-permission' }],
        ]),
      });
      openFileTabs(A, B);
      renderWorkspace();

      const locked = await screen.findByRole('tab', { name: 'a.ts, needs permission' });
      expect(locked.querySelector('[data-tab-status="locked"]')).not.toBeNull();
      expect(locked).toHaveAttribute('title', 'Click to restore access');
      expect(tabNamed(/^b\.ts$/)).toHaveAttribute('title', 'b.ts');
    });

    it('never lets an app id pass for a file-tab id (the menu dispatches on it)', () => {
      // File-tab ids are composite keys; every registry app id must fail to decode as one.
      for (const appId of [
        CONTEXT_EXPLORER_APP_ID,
        CHANGES_APP_ID,
        CANVAS_APP_ID,
        TERMINAL_APP_ID,
        WORKTREE_MAP_APP_ID,
      ]) {
        expect(() => decodeFileSelection(appId)).toThrow();
      }
      expect(decodeFileSelection(A)).toEqual({ folderId: 'folderA', path: 'src/a.ts' });
    });
  });

  describe('activation', () => {
    it('raises the permission prompt on Enter, never on arrow-key focus', async () => {
      const requestTabPermission = vi.fn().mockResolvedValue(true);
      vi.mocked(useTabFileRestoration).mockReturnValue({
        getStatusMessage: () => null,
        isRestoring: false,
        needsUserAction: () => false,
        requestTabPermission,
        restoreTabs: vi.fn().mockResolvedValue(undefined),
        tabStatuses: new Map<string, TabFileStatus>([
          [A, { compositeKey: A, status: 'needs-permission' }],
        ]),
      });
      openFileTabs(A);
      const user = userEvent.setup();
      renderWorkspace();

      const filesTab = await screen.findByRole('tab', { name: /files/i });
      filesTab.focus();
      await user.keyboard('{ArrowRight}');

      const locked = tabNamed(/a\.ts/);
      expect(locked).toHaveFocus();
      expect(requestTabPermission).not.toHaveBeenCalled();
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });

      await user.keyboard('{Enter}');

      expect(requestTabPermission).toHaveBeenCalledWith(A);
      await waitFor(() => {
        expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
          kind: 'file',
          tabId: A,
        });
      });
    });
  });

  describe('app-tab menu (workspace-app-tab target)', () => {
    function openMixedWorkspace(): void {
      const store = useWorkspaceTabSelectionStore.getState();
      store.openApp(CHANGES_APP.id);
      store.openApp(CANVAS_APP.id);
      store.openApp(CHILD_CEDAR_APP.id);
      store.openApp(CHILD_FLINT_APP.id);
    }

    const APPS = [FILES_APP, CHANGES_APP, CANVAS_APP, CHILD_CEDAR_APP, CHILD_FLINT_APP];

    it('offers Close, Close Others and Close All — and no reordering', async () => {
      renderWorkspace();

      const filesTab = await screen.findByRole('tab', { name: /files/i });
      expect(filesTab).toHaveAttribute('aria-haspopup', 'menu');
      fireEvent.contextMenu(filesTab);

      const menu = await screen.findByRole('menu');
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent)
      ).toEqual(['Close', 'Close Others', 'Close All']);
    });

    it('Close Others stays inside the pinned group and keeps the clicked app', async () => {
      openMixedWorkspace();
      useWorkspaceTabSelectionStore.getState().selectApp(CANVAS_APP.id);
      const user = userEvent.setup();
      renderWorkspace(APPS);

      fireEvent.contextMenu(await screen.findByRole('tab', { name: /changes/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Close Others' }));

      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        CHANGES_APP.id,
        CHILD_CEDAR_APP.id,
        CHILD_FLINT_APP.id,
      ]);
      // The selected Canvas closed, so selection follows closeApp's successor rule.
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: CHILD_CEDAR_APP.id,
        kind: 'app',
      });
    });

    it('Close All closes only the clicked group and keeps a selected app of the other group', async () => {
      openMixedWorkspace();
      useWorkspaceTabSelectionStore.getState().selectApp(CHANGES_APP.id);
      const user = userEvent.setup();
      renderWorkspace(APPS);

      fireEvent.contextMenu(await screen.findByRole('tab', { name: /cedar/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Close All' }));

      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        FILES_APP.id,
        CHANGES_APP.id,
        CANVAS_APP.id,
      ]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: CHANGES_APP.id,
        kind: 'app',
      });
    });

    it('Close All on the selected group lands on the active file tab when no app remains', async () => {
      openFileTabs(A, B);
      useTabManagerStore.getState().setActiveTab(B);
      useWorkspaceTabSelectionStore.getState().openApp(CHANGES_APP.id);
      const user = userEvent.setup();
      renderWorkspace([FILES_APP, CHANGES_APP]);

      fireEvent.contextMenu(await screen.findByRole('tab', { name: /files/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Close All' }));

      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: B,
      });
      expect(fileTabOrder()).toEqual([A, B]);
    });
  });

  describe('file-tab menu (workspace-file-tab target)', () => {
    it('adds tab management, reordering and the global file-entry actions', async () => {
      openFileTabs(A, B, C);
      const { registry } = createTestActionRegistry({ actions: fileEntryActions });
      renderWorkspace([FILES_APP], { actionRegistry: registry });

      fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));

      const menu = await screen.findByRole('menu');
      const labels = within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent ?? '');
      expect(labels.slice(0, 6)).toEqual([
        'Close',
        'Close Others',
        'Close to the Right',
        'Close All',
        'Move Left',
        'Move Right',
      ]);
      expect(labels.some((label) => label.startsWith('Copy Name'))).toBe(true);
    });

    it('Move Right swaps the file tab with its right neighbour and persists the order', async () => {
      openFileTabs(A, B, C);
      const user = userEvent.setup();
      renderWorkspace();

      fireEvent.contextMenu(await screen.findByRole('tab', { name: /a\.ts/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Move Right' }));

      expect(fileTabOrder()).toEqual([B, A, C]);
      await waitFor(() => {
        expect(
          within(screen.getByTestId('workspace-tab-scroll'))
            .getAllByRole('tab')
            .map((tab) => tab.id)
        ).toEqual([
          `workspace-file-tab-${B}`,
          `workspace-file-tab-${A}`,
          `workspace-file-tab-${C}`,
        ]);
      });
    });
  });

  describe('reorder', () => {
    it('⌥⇧→ moves a file tab, keeps focus on it and announces the new position', async () => {
      openFileTabs(A, B, C);
      renderWorkspace();

      const tabA = await screen.findByRole('tab', { name: /a\.ts/i });
      tabA.focus();
      fireEvent.keyDown(tabA, { altKey: true, key: 'ArrowRight', shiftKey: true });

      expect(fileTabOrder()).toEqual([B, A, C]);
      expect(await screen.findByRole('status')).toHaveTextContent('a.ts moved to position 2 of 3');
      await waitFor(() => {
        expect(tabNamed(/a\.ts/)).toHaveFocus();
      });
    });

    it('never moves a child-conversation tab, nor a file tab across it', async () => {
      useWorkspaceTabSelectionStore.getState().openApp(CHILD_CEDAR_APP.id);
      openFileTabs(A, B);
      renderWorkspace([FILES_APP, CHILD_CEDAR_APP]);

      const cedar = await screen.findByRole('tab', { name: /cedar/i });
      fireEvent.keyDown(cedar, { altKey: true, key: 'ArrowRight', shiftKey: true });
      fireEvent.keyDown(tabNamed(/a\.ts/), { altKey: true, key: 'ArrowLeft', shiftKey: true });

      expect(fileTabOrder()).toEqual([A, B]);
      expect(cedar.closest('[data-slot="tab-shell"]')).not.toHaveAttribute('data-reorderable');
      expect(tabNamed(/a\.ts/).closest('[data-slot="tab-shell"]')).toHaveAttribute(
        'data-reorderable',
        'true'
      );
    });

    it('⌥⇧→ reorders file tabs while a child conversation shares the scroll group', async () => {
      useWorkspaceTabSelectionStore.getState().openApp(CHILD_CEDAR_APP.id);
      openFileTabs(A, B, C);
      renderWorkspace([FILES_APP, CHILD_CEDAR_APP]);

      const tabA = await screen.findByRole('tab', { name: /a\.ts/i });
      tabA.focus();
      fireEvent.keyDown(tabA, { altKey: true, key: 'ArrowRight', shiftKey: true });

      // The strip hands onReorder only the reorderable (file) ids, so the
      // store accepts the move instead of rejecting a mixed id list.
      expect(fileTabOrder()).toEqual([B, A, C]);
      await waitFor(() => {
        expect(
          within(screen.getByTestId('workspace-tab-scroll'))
            .getAllByRole('tab')
            .map((tab) => tab.id)
        ).toEqual([
          `workspace-app-tab-${CHILD_CEDAR_APP.id}`,
          `workspace-file-tab-${B}`,
          `workspace-file-tab-${A}`,
          `workspace-file-tab-${C}`,
        ]);
      });
    });
  });

  describe('strip background and All-tabs menus', () => {
    it('the empty strip background offers Close All Files, which keeps the app tabs', async () => {
      openFileTabs(A, B);
      const user = userEvent.setup();
      renderWorkspace();

      await screen.findByRole('tab', { name: /a\.ts/i });
      fireEvent.contextMenu(screen.getByRole('tablist', { name: 'Workspace tabs' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Close All Files' }));

      expect(fileTabOrder()).toEqual([]);
      expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
    });

    it('the All-tabs menu lists every group, pinned apps first, and offers no Close All', async () => {
      // It lists apps AND files, so a "Close All" there that closed only files
      // would be ambiguous; the strip background's "Close All Files" owns that.
      useWorkspaceTabSelectionStore.getState().openApp(CHILD_CEDAR_APP.id);
      openFileTabs(A);
      const user = userEvent.setup();
      renderWorkspace([FILES_APP, CHILD_CEDAR_APP]);

      await user.click(await screen.findByRole('button', { name: 'All tabs' }));
      expect((await screen.findAllByRole('menuitemradio')).map((item) => item.textContent)).toEqual(
        ['Files', 'Cedar', 'a.ts']
      );
      expect(screen.queryByRole('menuitem', { name: 'Close All' })).toBeNull();
    });
  });
});
