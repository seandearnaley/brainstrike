import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayoutGrid } from 'lucide-react';
import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseTabManagerReturn } from '../hooks/use-tab-manager';
import { useWorkspaceTabs } from '../shell/use-workspace-tabs';
import type { WorkspaceApp } from '../shell/workspace-app';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../stores/tab-manager-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import { CANVAS_APP, CHANGES_APP, FILES_APP, renderWorkspace } from './workspace-tabs-test-support';

// Mock the preview-panel surface (Files app body) — same pattern as existing tests
vi.mock('../preview/preview-panel', () => ({
  PreviewPanel: vi.fn(() => <div data-testid="preview-panel">PreviewPanel</div>),
}));

// File tabs mount the explorer pane by default (BST-1318); the real one
// requires a FileSystemProvider — stub it, pane tests cover its behavior.
vi.mock('../shell/file-tab-explorer-pane', () => ({
  FileTabExplorerPane: () => <div data-testid="pane-spy" />,
}));

// Mock useFileExplorer — minimal shape used by the controller
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

describe('workspace tabs — apps, launcher, selection', () => {
  let useTabFileRestoration: typeof import('@brainstrike/file-explorer-hooks').useTabFileRestoration;

  beforeAll(async () => {
    const restorationModule = await import('@brainstrike/file-explorer-hooks');
    useTabFileRestoration = restorationModule.useTabFileRestoration;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetWorkspaceTabSelectionStoreForTests();

    const uiModule = await import('@brainstrike/ui');
    vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab: vi.fn(),
      registerOpenFileInTab: vi.fn(),
    });
    vi.spyOn(uiModule, 'useUndoableAction').mockReturnValue({
      clearUndoTimeout: vi.fn(),
      performUndoableAction: vi.fn(),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    const empty: UseTabManagerReturn = {
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [],
      updateTabContent: vi.fn(),
    };
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue(empty);
  });

  afterEach(() => {
    __resetWorkspaceTabSelectionStoreForTests();
  });

  it('useWorkspaceTabs outside the provider throws (no silent fallback)', () => {
    expect(() => renderHook(() => useWorkspaceTabs())).toThrow(/WorkspaceTabsProvider/);
  });

  it('renders the Files app tab and shows its body by default', async () => {
    renderWorkspace();

    const filesTab = await screen.findByRole('tab', { name: /files/i });
    expect(filesTab).toBeInTheDocument();
    expect(filesTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('workspace-tab-strip')).toBeInTheDocument();
    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();
  });

  it('renders app tabs in registry order regardless of open order', async () => {
    useWorkspaceTabSelectionStore.getState().openApp('canvas');
    useWorkspaceTabSelectionStore.getState().openApp('changes');
    renderWorkspace([FILES_APP, CHANGES_APP, CANVAS_APP]);

    const tabs = await screen.findAllByRole('tab');
    expect(tabs[0]).toHaveAccessibleName(/files/i);
    expect(tabs[1]).toHaveAccessibleName(/changes/i);
    expect(tabs[2]).toHaveAccessibleName(/canvas/i);
  });

  it('does not render tabs for registered apps that are not open', async () => {
    renderWorkspace([FILES_APP, CHANGES_APP, CANVAS_APP]);

    await screen.findByRole('tab', { name: /files/i });
    expect(screen.queryByRole('tab', { name: /changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /canvas/i })).not.toBeInTheDocument();
  });

  it('app tabs are closable: closing the last open app shows the launcher', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: /close files/i }));

    expect(await screen.findByTestId('workspace-launcher')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /files/i })).not.toBeInTheDocument();
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ kind: 'empty' });
  });

  it('the launcher lists every REGISTERED app and reopens one on click', async () => {
    const user = userEvent.setup();
    useWorkspaceTabSelectionStore.getState().closeApp('context-explorer');
    renderWorkspace([FILES_APP, CHANGES_APP, CANVAS_APP]);

    const launcher = await screen.findByTestId('workspace-launcher');
    expect(launcher).toBeInTheDocument();
    expect(screen.getByTestId('workspace-launcher-open-context-explorer')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-launcher-open-changes')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-launcher-open-canvas')).toBeInTheDocument();

    await user.click(screen.getByTestId('workspace-launcher-open-changes'));

    expect(await screen.findByTestId('changes-app-body')).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /changes/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('the launcher only offers registered apps (web shows Files only)', async () => {
    useWorkspaceTabSelectionStore.getState().closeApp('context-explorer');
    renderWorkspace([FILES_APP]);

    await screen.findByTestId('workspace-launcher');
    expect(screen.getByTestId('workspace-launcher-open-context-explorer')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-launcher-open-changes')).not.toBeInTheDocument();
  });

  it('closing the active app with a file tab open selects the file tab instead of the launcher', async () => {
    const user = userEvent.setup();
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();
    __resetTabManagerStoreForTests();
    useTabManagerStore.getState().openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    useWorkspaceTabSelectionStore.getState().selectApp('context-explorer');

    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: /close files/i }));

    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'folderA|@|src/a.ts',
      });
    });
    expect(screen.queryByTestId('workspace-launcher')).not.toBeInTheDocument();

    __resetTabManagerStoreForTests();
  });

  it('keeps an app mounted across tab switches, but CLOSING unmounts and reopening remounts', async () => {
    const user = userEvent.setup();
    let mountCount = 0;
    function MountProbe() {
      useEffect(() => {
        mountCount += 1;
      }, []);
      return <div data-testid="probe-body">probe</div>;
    }
    const probeApp: WorkspaceApp = {
      icon: LayoutGrid,
      id: 'context-explorer',
      label: 'Files',
      render: () => <MountProbe />,
    };
    renderWorkspace([probeApp, CHANGES_APP]);

    await screen.findByTestId('probe-body');
    expect(mountCount).toBe(1);

    // Switch to Changes, then back — keep-alive: no remount, body stays hidden.
    act(() => {
      useWorkspaceTabSelectionStore.getState().openApp('changes');
    });
    await screen.findByTestId('changes-app-body');
    expect(screen.getByTestId('probe-body')).toBeInTheDocument();
    expect(screen.getByTestId('probe-body')).not.toBeVisible();

    await user.click(await screen.findByRole('tab', { name: /files/i }));
    await waitFor(() => {
      expect(screen.getByTestId('probe-body')).toBeVisible();
    });
    expect(mountCount).toBe(1);

    // CLOSING the tab unmounts the surface — the ✕ is the user's lever to
    // release a runaway Canvas iframe (review finding).
    await user.click(await screen.findByRole('button', { name: /close files/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('probe-body')).not.toBeInTheDocument();
    });

    // Reopening remounts fresh.
    act(() => {
      useWorkspaceTabSelectionStore.getState().openApp('context-explorer');
    });
    await waitFor(() => {
      expect(screen.getByTestId('probe-body')).toBeVisible();
    });
    expect(mountCount).toBe(2);
  });

  it('moves focus with ArrowRight WITHOUT activating the tab (manual activation)', async () => {
    useWorkspaceTabSelectionStore.getState().openApp('changes');
    useWorkspaceTabSelectionStore.getState().selectApp('context-explorer');
    renderWorkspace([FILES_APP, CHANGES_APP]);

    const filesTab = await screen.findByRole('tab', { name: /files/i });
    const changesTab = await screen.findByRole('tab', { name: /changes/i });
    filesTab.focus();

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });

    expect(changesTab).toHaveFocus();
    // Selection did NOT follow focus — activating a needs-permission file tab
    // would raise a real browser permission prompt (review finding).
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'context-explorer',
      kind: 'app',
    });
  });

  it('keeps the tablist tabs-only and close buttons out of the tab order', async () => {
    useWorkspaceTabSelectionStore.getState().openApp('changes');
    renderWorkspace([FILES_APP, CHANGES_APP]);

    const tablist = await screen.findByRole('tablist');
    // Every focusable child of the tablist is a tab (close buttons are
    // tabIndex=-1; chevrons and the overflow menu live OUTSIDE the tablist).
    for (const button of Array.from(tablist.querySelectorAll('button'))) {
      if (button.getAttribute('role') === 'tab') {
        continue;
      }
      expect(button).toHaveAttribute('tabindex', '-1');
    }
    // Chevrons and the ⋯ overflow menu are NOT tablist children.
    expect(tablist.contains(screen.getByRole('button', { name: /more tab actions/i }))).toBe(false);
  });

  it('Delete closes the focused tab and moves focus to its successor', async () => {
    useWorkspaceTabSelectionStore.getState().openApp('changes');
    useWorkspaceTabSelectionStore.getState().selectApp('context-explorer');
    renderWorkspace([FILES_APP, CHANGES_APP]);

    const filesTab = await screen.findByRole('tab', { name: /files/i });
    filesTab.focus();

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Delete' });

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /files/i })).not.toBeInTheDocument();
    });
    // Focus lands on the tab that slid into the closed one's place — keyboard
    // navigation survives the close (Codex review finding).
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /changes/i })).toHaveFocus();
    });
  });

  it('an unregistered persisted app selection routes to the first open registered app', async () => {
    useWorkspaceTabSelectionStore.getState().selectApp('changes'); // registered on desktop, not here
    renderWorkspace([FILES_APP]);

    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });
    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();
  });

  it('an unregistered persisted app selection with no other open app lands on the launcher', async () => {
    useWorkspaceTabSelectionStore.getState().closeApp('context-explorer');
    useWorkspaceTabSelectionStore.getState().selectApp('changes');
    renderWorkspace([FILES_APP]);

    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ kind: 'empty' });
    });
    expect(await screen.findByTestId('workspace-launcher')).toBeInTheDocument();
  });

  it('shows the Workspace label in the strip when nothing is open', async () => {
    useWorkspaceTabSelectionStore.getState().closeApp('context-explorer');
    renderWorkspace();

    await screen.findByTestId('workspace-launcher');
    expect(screen.getByTestId('workspace-tab-strip')).toHaveTextContent('Workspace');
  });

  it('a not-found (deleted) tab stays open and marked instead of auto-closing', async () => {
    const compositeKey = 'folderA|@|src/deleted.ts';
    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => 'File no longer exists',
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>([
        [compositeKey, { compositeKey, error: 'File no longer exists', status: 'not-found' }],
      ]),
    });

    const closeTab = vi.fn(() => null);
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: compositeKey,
      clearTabs: vi.fn(),
      closeTab,
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey,
          content: null,
          id: compositeKey,
          isLoading: false,
          path: 'src/deleted.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);
    renderWorkspace();

    // Tab remains in the strip — restoration must not close it.
    const tab = await screen.findByRole('tab', { name: /deleted\.ts/i });
    expect(tab).toBeInTheDocument();
    expect(closeTab).not.toHaveBeenCalled();
    // Marked as deleted: distinct data-state for styling/e2e and an
    // accessible-name suffix so screen readers hear the deletion.
    expect(tab).toHaveAttribute('data-state', 'not-found');
    expect(tab).toHaveAccessibleName('deleted.ts (deleted)');
    // Body explains the deletion.
    expect(await screen.findByText('File Not Found')).toBeInTheDocument();
  });

  it('does not invent a context menu for workspace app tabs', async () => {
    renderWorkspace();

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /files/i }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
