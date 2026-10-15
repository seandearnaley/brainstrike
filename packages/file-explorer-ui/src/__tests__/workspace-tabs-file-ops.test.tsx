import { INACCESSIBLE_CONTENT_PREFIX, type TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseTabManagerReturn } from '../hooks/use-tab-manager';
import { useEditorViewStateStore } from '../stores/editor-view-state-store';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../stores/tab-manager-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import { DEMO_APP, FILES_APP, renderWorkspace } from './workspace-tabs-test-support';

async function openThreeTabsWithDemoAppSelected(): Promise<void> {
  const tabModule = await import('../hooks/use-tab-manager');
  vi.mocked(tabModule.useTabManager).mockRestore();
  __resetTabManagerStoreForTests();
  const store = useTabManagerStore.getState();
  store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
  store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
  store.openTab('src/c.ts', 'folderA|@|src/c.ts', 'folderA|@|src/c.ts');
  useWorkspaceTabSelectionStore.getState().selectApp(DEMO_APP.id);
}

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

describe('workspace tabs — file tab operations', () => {
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

  it('renders a file tab when one is open and switches to it on click', async () => {
    const user = userEvent.setup();
    const setActiveTab = vi.fn();
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab,
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          content: 'export const x = 1;\n',
          id: 'folderA|@|src/index.ts',
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    renderWorkspace();

    expect(await screen.findByTestId('files-app-body')).toBeInTheDocument();

    const fileTab = await screen.findByRole('tab', { name: /index\.ts/i });
    expect(fileTab).toHaveAttribute('aria-selected', 'false');

    await user.click(fileTab);

    expect(setActiveTab).toHaveBeenCalledWith('folderA|@|src/index.ts');
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'folderA|@|src/index.ts',
      });
    });
  });

  it('does not let a resolved permission prompt override a newer tab selection', async () => {
    const user = userEvent.setup();
    const setActiveTab = vi.fn();
    let resolvePermission: ((granted: boolean) => void) | undefined;
    const requestTabPermission = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        })
    );
    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => null,
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission,
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>([
        ['folderA|@|src/a.ts', { compositeKey: 'folderA|@|src/a.ts', status: 'needs-permission' }],
      ]),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab,
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/a.ts',
          content: null,
          id: 'folderA|@|src/a.ts',
          isLoading: false,
          path: 'src/a.ts',
        },
        {
          compositeKey: 'folderA|@|src/b.ts',
          content: null,
          id: 'folderA|@|src/b.ts',
          isLoading: false,
          path: 'src/b.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    renderWorkspace();

    await user.click(await screen.findByRole('tab', { name: /a\.ts/i }));
    await user.click(await screen.findByRole('tab', { name: /b\.ts/i }));

    expect(setActiveTab).toHaveBeenCalledWith('folderA|@|src/b.ts');
    await act(async () => {
      resolvePermission?.(true);
      await Promise.resolve();
    });

    expect(setActiveTab).not.toHaveBeenCalledWith('folderA|@|src/a.ts');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/b.ts',
    });
  });

  it('a resolved permission prompt cannot clobber a selection made through openFileInTab', async () => {
    // Review finding: handleOpenFileInTab (and the close paths) previously did
    // NOT bump the selection-intent counter, so a permission prompt resolving
    // after a newer selection re-selected the stale tab.
    const user = userEvent.setup();
    let registeredOpenFile: ((compositeKey: string) => void) | undefined;
    const uiModule = await import('@brainstrike/ui');
    vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab: vi.fn(),
      registerOpenFileInTab: vi.fn((callback: (compositeKey: string) => void) => {
        registeredOpenFile = callback;
      }),
    });

    const setActiveTab = vi.fn();
    let resolvePermission: ((granted: boolean) => void) | undefined;
    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => null,
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolvePermission = resolve;
          })
      ),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>([
        ['folderA|@|src/a.ts', { compositeKey: 'folderA|@|src/a.ts', status: 'needs-permission' }],
      ]),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab,
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/a.ts',
          content: null,
          id: 'folderA|@|src/a.ts',
          isLoading: false,
          path: 'src/a.ts',
        },
        {
          compositeKey: 'folderA|@|src/b.ts',
          content: null,
          id: 'folderA|@|src/b.ts',
          isLoading: false,
          path: 'src/b.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    renderWorkspace();

    // Click the needs-permission tab: its selection awaits the prompt.
    await user.click(await screen.findByRole('tab', { name: /a\.ts/i }));

    // While the prompt is up, a tree click opens another file via the seam.
    act(() => {
      registeredOpenFile?.('folderA|@|src/b.ts');
    });
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/b.ts',
    });

    // The prompt resolves late — the stale continuation must NOT re-select A.
    await act(async () => {
      resolvePermission?.(true);
      await Promise.resolve();
    });
    expect(setActiveTab).not.toHaveBeenCalledWith('folderA|@|src/a.ts');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/b.ts',
    });
  });

  it('clicking the Files tab swaps back to the Files body', async () => {
    const user = userEvent.setup();
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: 'folderA|@|src/index.ts',
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          id: 'folderA|@|src/index.ts',
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContentErrors: new Map<string, Error>(),
      fileContents: { 'folderA|@|src/index.ts': 'export const file = "content";' },
      fileTree: [],
      loadFileContent: vi.fn().mockResolvedValue(undefined),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    renderWorkspace();

    await screen.findByText(/export const file/);
    // Files was activated at the session default, so it stays MOUNTED but
    // hidden while a file tab is showing (keep-alive contract).
    expect(screen.getByTestId('files-app-body')).not.toBeVisible();

    await user.click(await screen.findByRole('tab', { name: /files/i }));

    expect(await screen.findByTestId('files-app-body')).toBeVisible();
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });
  });

  it('renders active file content through the shared CodeSurface viewer', async () => {
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: 'folderA|@|src/index.ts',
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          id: 'folderA|@|src/index.ts',
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContentErrors: new Map<string, Error>(),
      fileContents: { 'folderA|@|src/index.ts': 'export const file = "content";' },
      fileTree: [],
      loadFileContent: vi.fn().mockResolvedValue(undefined),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    renderWorkspace();

    const surface = await screen.findByTestId('file-code-surface');
    expect(surface).toHaveAttribute('data-language', 'TypeScript');
    expect(surface).toHaveAttribute('data-editable', 'false');
    expect(surface).toHaveTextContent('export const file = "content";');
    expect(surface.querySelector('.cm-lineNumbers')).toBeInTheDocument();
    expect(screen.queryByText('export const file = "content";', { selector: 'pre' })).toBeNull();
  });

  it('consumes the one-shot target line after the opening render so switching away and back does not re-scroll to it', async () => {
    const user = userEvent.setup();
    const indexKey = 'folderA|@|src/index.ts';
    const otherKey = 'folderA|@|src/other.ts';

    useEditorViewStateStore.getState().setTarget(indexKey, { line: 42 });
    useWorkspaceTabSelectionStore.getState().selectFile(indexKey);

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: indexKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: indexKey,
          content: null,
          id: indexKey,
          isLoading: false,
          path: 'src/index.ts',
        },
        {
          compositeKey: otherKey,
          content: null,
          id: otherKey,
          isLoading: false,
          path: 'src/other.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContentErrors: new Map<string, Error>(),
      fileContents: {
        [indexKey]: 'export const file = "content";',
        [otherKey]: 'export const other = true;',
      },
      fileTree: [],
      loadFileContent: vi.fn().mockResolvedValue(undefined),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    const uiModule = await import('@brainstrike/ui');
    const OriginalCodeSurface = uiModule.CodeSurface;
    let indexSurfaceInitialLines: (number | undefined)[] = [];
    vi.spyOn(uiModule, 'CodeSurface').mockImplementation((props) => {
      if (props.path === 'src/index.ts') {
        indexSurfaceInitialLines.push(props.initialLine);
      }
      return <OriginalCodeSurface {...props} />;
    });

    renderWorkspace();

    await screen.findByTestId('file-code-surface');
    expect(indexSurfaceInitialLines[0]).toBe(42);
    await waitFor(() =>
      expect(useEditorViewStateStore.getState().getTarget(indexKey)).toBeUndefined()
    );

    indexSurfaceInitialLines = [];

    await user.click(await screen.findByRole('tab', { name: /other\.ts/i }));
    await waitFor(() => {
      expect(screen.getByTestId('file-code-surface')).toHaveTextContent(
        'export const other = true;'
      );
    });

    await user.click(await screen.findByRole('tab', { name: /index\.ts/i }));
    await waitFor(() => {
      expect(screen.getByTestId('file-code-surface')).toHaveTextContent(
        'export const file = "content";'
      );
    });

    expect(indexSurfaceInitialLines.length).toBeGreaterThan(0);
    expect(indexSurfaceInitialLines.every((line) => line === undefined)).toBe(true);
  });

  it('passes a one-shot chunk selection range to CodeSurface as initialSelection', async () => {
    const indexKey = 'folderA|@|src/index.ts';
    useEditorViewStateStore
      .getState()
      .setTarget(indexKey, { line: 8, selection: { endLine: 12, startLine: 8 } });
    useWorkspaceTabSelectionStore.getState().selectFile(indexKey);

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: indexKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: indexKey,
          content: null,
          id: indexKey,
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContentErrors: new Map<string, Error>(),
      fileContents: { [indexKey]: 'export const file = "content";' },
      fileTree: [],
      loadFileContent: vi.fn().mockResolvedValue(undefined),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    const uiModule = await import('@brainstrike/ui');
    const OriginalCodeSurface = uiModule.CodeSurface;
    const capturedSelections: ({ startLine: number; endLine: number } | undefined)[] = [];
    vi.spyOn(uiModule, 'CodeSurface').mockImplementation((props) => {
      if (props.path === 'src/index.ts') {
        capturedSelections.push(props.initialSelection);
      }
      return <OriginalCodeSurface {...props} />;
    });

    renderWorkspace();

    await screen.findByTestId('file-code-surface');
    expect(capturedSelections[0]).toEqual({ endLine: 12, startLine: 8 });
    await waitFor(() =>
      expect(useEditorViewStateStore.getState().getTarget(indexKey)).toBeUndefined()
    );
  });

  it('shows "Restoring..." for a persisted tab while restoration is pending — not "File not found"', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: 'folderA|@|src/index.ts',
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          id: 'folderA|@|src/index.ts',
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => 'Restoring...',
      isRestoring: true,
      needsUserAction: () => false,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map(),
    });

    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    renderWorkspace();

    expect(await screen.findByText(/restoring/i)).toBeInTheDocument();
    expect(screen.queryByText(/file not found or unable to load/i)).not.toBeInTheDocument();
  });

  it('closing the active file tab hops to the next sibling tab, not back to Files', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    store.openTab('src/c.ts', 'folderA|@|src/c.ts', 'folderA|@|src/c.ts');
    useTabManagerStore.getState().setActiveTab('folderA|@|src/b.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/b.ts');

    renderWorkspace();

    await user.click(await screen.findByTitle('Close b.ts'));

    await waitFor(() => {
      expect(useTabManagerStore.getState().activeTabId).toBe('folderA|@|src/c.ts');
    });
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'folderA|@|src/c.ts',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('closing the last file tab falls back to the first open app', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    useTabManagerStore
      .getState()
      .openTab('src/only.ts', 'folderA|@|src/only.ts', 'folderA|@|src/only.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/only.ts');

    renderWorkspace();

    await user.click(await screen.findByTitle('Close only.ts'));

    await waitFor(() => {
      expect(useTabManagerStore.getState().activeTabId).toBeNull();
    });
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('closing the last file tab with NO open apps lands on the launcher', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    useTabManagerStore
      .getState()
      .openTab('src/only.ts', 'folderA|@|src/only.ts', 'folderA|@|src/only.ts');
    useWorkspaceTabSelectionStore.getState().closeApp('context-explorer');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/only.ts');

    renderWorkspace();

    await user.click(await screen.findByTitle('Close only.ts'));

    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ kind: 'empty' });
    });
    expect(await screen.findByTestId('workspace-launcher')).toBeInTheDocument();

    __resetTabManagerStoreForTests();
  });

  it('the strip background Close All Files clears every file tab and routes to the first open app', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/b.ts');

    renderWorkspace();

    await screen.findByRole('tab', { name: /b\.ts/i });
    fireEvent.contextMenu(screen.getByRole('tablist', { name: 'Workspace tabs' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close All Files' }));

    await waitFor(() => {
      expect(useTabManagerStore.getState().tabs).toEqual([]);
    });
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('right-clicking an inactive file tab can close it without activating it', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    store.openTab('src/c.ts', 'folderA|@|src/c.ts', 'folderA|@|src/c.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/c.ts');

    renderWorkspace();

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }));

    await waitFor(() => {
      expect(useTabManagerStore.getState().tabs.map((tab) => tab.id)).toEqual([
        'folderA|@|src/a.ts',
        'folderA|@|src/c.ts',
      ]);
    });
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/c.ts',
    });
  });

  it('right-click Close Others uses the clicked tab as the atomic retained target', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    store.openTab('src/c.ts', 'folderA|@|src/c.ts', 'folderA|@|src/c.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/c.ts');

    renderWorkspace();

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Others' }));

    await waitFor(() => {
      expect(useTabManagerStore.getState().tabs.map((tab) => tab.id)).toEqual([
        'folderA|@|src/b.ts',
      ]);
    });
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/b.ts',
    });
  });

  it('keeps an app selected when Close Others changes background file tabs', async () => {
    await openThreeTabsWithDemoAppSelected();
    renderWorkspace([FILES_APP, DEMO_APP]);

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Others' }));

    expect(useTabManagerStore.getState().tabs.map((tab) => tab.id)).toEqual(['folderA|@|src/b.ts']);
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: DEMO_APP.id,
      kind: 'app',
    });
  });

  it('keeps an app selected when closing background file tabs to the right', async () => {
    await openThreeTabsWithDemoAppSelected();
    renderWorkspace([FILES_APP, DEMO_APP]);

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close to the Right' }));

    expect(useTabManagerStore.getState().tabs.map((tab) => tab.id)).toEqual([
      'folderA|@|src/a.ts',
      'folderA|@|src/b.ts',
    ]);
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: DEMO_APP.id,
      kind: 'app',
    });
  });

  it('keeps an app selected when closing all background file tabs', async () => {
    await openThreeTabsWithDemoAppSelected();
    renderWorkspace([FILES_APP, DEMO_APP]);

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close All' }));

    expect(useTabManagerStore.getState().tabs).toEqual([]);
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: DEMO_APP.id,
      kind: 'app',
    });
  });

  it('disables file-tab actions when their claimed target becomes stale', async () => {
    await openThreeTabsWithDemoAppSelected();
    renderWorkspace([FILES_APP, DEMO_APP]);

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));
    const close = await screen.findByRole('menuitem', { name: 'Close' });
    act(() => {
      useTabManagerStore.getState().closeTab('folderA|@|src/b.ts');
    });

    await waitFor(() => {
      expect(close).toHaveAttribute('data-disabled');
    });
  });

  it('registers openFileInTab and loads newly opened file content once', async () => {
    let registeredOpenFile: ((compositeKey: string) => void) | undefined;
    const registerOpenFileInTab = vi.fn((callback: (compositeKey: string) => void) => {
      registeredOpenFile = callback;
    });
    const uiModule = await import('@brainstrike/ui');
    vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab: vi.fn(),
      registerOpenFileInTab,
    });

    const openTab = vi.fn();
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab,
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [],
      updateTabContent: vi.fn(),
    });

    const loadFileContent = vi.fn().mockResolvedValue(undefined);
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContentErrors: new Map<string, Error>(),
      fileContents: {},
      fileTree: [],
      loadFileContent,
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    renderWorkspace();

    if (!registeredOpenFile) {
      throw new Error('Expected openFileInTab registration');
    }
    const openFileInTab = registeredOpenFile;

    act(() => {
      openFileInTab('folderA|@|src/new.ts');
      openFileInTab('malformed-key');
    });

    expect(openTab).toHaveBeenCalledWith(
      'src/new.ts',
      'folderA|@|src/new.ts',
      'folderA|@|src/new.ts'
    );
    expect(loadFileContent).toHaveBeenCalledTimes(1);
    expect(loadFileContent).toHaveBeenCalledWith('folderA|@|src/new.ts', 'interactive');
  });

  it('renders permission-required restoration status without auto-loading content', async () => {
    const compositeKey = 'folderA|@|src/locked.ts';
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);
    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => 'Permission was denied',
      isRestoring: false,
      needsUserAction: () => true,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>([
        [
          compositeKey,
          {
            compositeKey,
            error: 'Permission was denied',
            status: 'needs-permission',
          },
        ],
      ]),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: compositeKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
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
          path: 'src/locked.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const loadFileContent = vi.fn().mockResolvedValue(undefined);
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContentErrors: new Map<string, Error>(),
      fileContents: {},
      fileTree: [{ path: 'src/locked.ts' }],
      loadFileContent,
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    renderWorkspace();

    expect(await screen.findByText('File Access Required')).toBeInTheDocument();
    expect(screen.getByText('Permission was denied')).toBeInTheDocument();
    expect(loadFileContent).not.toHaveBeenCalled();
  });

  it('renders inaccessible file content as a browser permission message', async () => {
    const compositeKey = 'folderA|@|src/locked.ts';
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: compositeKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
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
          path: 'src/locked.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const inaccessibleContent = `${INACCESSIBLE_CONTENT_PREFIX} permission required`;
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContentErrors: new Map<string, Error>(),
      fileContents: { [compositeKey]: inaccessibleContent },
      fileTree: [],
      loadFileContent: vi.fn().mockResolvedValue(undefined),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    renderWorkspace();

    expect(await screen.findByText(inaccessibleContent)).toBeInTheDocument();
    expect(screen.getByText(/please open the folder again/i)).toBeInTheDocument();
  });
});
