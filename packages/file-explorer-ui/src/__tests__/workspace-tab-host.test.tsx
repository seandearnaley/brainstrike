import { INACCESSIBLE_CONTENT_PREFIX, type TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayoutGrid } from 'lucide-react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseTabManagerReturn } from '../hooks/use-tab-manager';
import type { WorkspaceApp } from '../shell/workspace-app';
import { WorkspaceTabHost } from '../shell/workspace-tab-host';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../stores/tab-manager-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import { FileExplorerTestWrapper } from './test-helpers';

// Mock the preview-panel surface (Context Explorer body) — same pattern as existing tests
vi.mock('../preview/preview-panel', () => ({
  PreviewPanel: vi.fn(() => <div data-testid="preview-panel">PreviewPanel</div>),
}));

// Mock useFileExplorer — minimal shape used by the host
vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(() => ({
    fileTree: [],
    fileContents: {},
    loadingFiles: new Set<string>(),
    loadFileContent: vi.fn(),
    loadMultipleFileContents: vi.fn(),
    rootDirectoryHandle: null,
    canLoadWithoutTree: false,
  })),
}));

vi.mock('../shell/use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(() => ({
    selectedFilePaths: new Set<string>(),
    selectedFilesList: [],
    setSelectedFilesFromList: vi.fn(),
    handleSelectionChange: vi.fn(),
    wouldExceedSelectionLimit: vi.fn(() => false),
    effectiveSelection: new Set<string>(),
    isRulesMode: false,
  })),
}));

vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...original,
    useTabFileRestoration: vi.fn(() => ({
      tabStatuses: new Map<string, TabFileStatus>(),
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      needsUserAction: () => false,
      getStatusMessage: () => null,
      isRestoring: false,
    })),
  };
});

describe('WorkspaceTabHost', () => {
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
      performUndoableAction: vi.fn(),
      clearUndoTimeout: vi.fn(),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    const empty: UseTabManagerReturn = {
      tabs: [],
      activeTabId: null,
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    };
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue(empty);
  });

  afterEach(() => {
    __resetWorkspaceTabSelectionStoreForTests();
  });

  it('renders Context Explorer as a pinned tab and shows its body by default', async () => {
    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    // Pinned app tab
    const explorerTab = await screen.findByRole('tab', { name: /context explorer/i });
    expect(explorerTab).toBeInTheDocument();
    expect(explorerTab).toHaveAttribute('aria-selected', 'true');

    // Body: the preview panel
    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();
  });

  it('does not show a "console" / south panel — file tabs live above the preview', async () => {
    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    // The legacy console / south "Show File Editor" affordance must not exist
    expect(screen.queryByRole('button', { name: /show file editor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close file editor/i })).not.toBeInTheDocument();
  });

  it('renders a file tab when one is open and switches to it on click', async () => {
    const user = userEvent.setup();
    const setActiveTab = vi.fn();
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: 'folderA|@|src/index.ts',
          path: 'src/index.ts',
          compositeKey: 'folderA|@|src/index.ts',
          content: 'export const x = 1;\n',
          isLoading: false,
        },
      ],
      activeTabId: null,
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab,
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    // Context Explorer is selected by default
    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();

    // File tab visible in the strip
    const fileTab = await screen.findByRole('tab', { name: /index\.ts/i });
    expect(fileTab).toBeInTheDocument();
    expect(fileTab).toHaveAttribute('aria-selected', 'false');

    await user.click(fileTab);

    // Tab manager active tab updated and workspace mode switched to file
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
      tabStatuses: new Map<string, TabFileStatus>([
        ['folderA|@|src/a.ts', { compositeKey: 'folderA|@|src/a.ts', status: 'needs-permission' }],
      ]),
      requestTabPermission,
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      needsUserAction: () => false,
      getStatusMessage: () => null,
      isRestoring: false,
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: 'folderA|@|src/a.ts',
          path: 'src/a.ts',
          compositeKey: 'folderA|@|src/a.ts',
          content: null,
          isLoading: false,
        },
        {
          id: 'folderA|@|src/b.ts',
          path: 'src/b.ts',
          compositeKey: 'folderA|@|src/b.ts',
          content: null,
          isLoading: false,
        },
      ],
      activeTabId: null,
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab,
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

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

  it('uses the current selection when restoration closes a stale tab', async () => {
    let closeRestoredTab: ((tabId: string) => void) | undefined;
    vi.mocked(useTabFileRestoration).mockImplementation((_tabs, onCloseTab) => {
      closeRestoredTab = onCloseTab;
      return {
        tabStatuses: new Map<string, TabFileStatus>(),
        requestTabPermission: vi.fn().mockResolvedValue(true),
        restoreTabs: vi.fn().mockResolvedValue(undefined),
        needsUserAction: () => false,
        getStatusMessage: () => null,
        isRestoring: false,
      };
    });

    const closeTab = vi.fn(() => null);
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: 'folderA|@|src/a.ts',
          path: 'src/a.ts',
          compositeKey: 'folderA|@|src/a.ts',
          content: null,
          isLoading: false,
        },
      ],
      activeTabId: 'folderA|@|src/a.ts',
      openTab: vi.fn(),
      closeTab,
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/a.ts');
    act(() => {
      closeRestoredTab?.('folderA|@|src/a.ts');
    });

    expect(closeTab).toHaveBeenCalledWith('folderA|@|src/a.ts');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'app',
      appId: 'context-explorer',
    });
  });

  it('clicking the Context Explorer tab swaps back to the preview body', async () => {
    const user = userEvent.setup();
    // Start in file mode
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: 'folderA|@|src/index.ts',
          path: 'src/index.ts',
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          isLoading: false,
        },
      ],
      activeTabId: 'folderA|@|src/index.ts',
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      fileTree: [],
      fileContents: { 'folderA|@|src/index.ts': 'export const file = "content";' },
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
      canLoadWithoutTree: false,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    // File mode body — preview panel hidden
    await screen.findByText(/export const file/);
    expect(screen.queryByTestId('preview-panel')).not.toBeInTheDocument();

    const explorerTab = await screen.findByRole('tab', { name: /context explorer/i });
    await user.click(explorerTab);

    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'app',
        appId: 'context-explorer',
      });
    });
  });

  it('renders active file content through the shared CodeSurface viewer', async () => {
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: 'folderA|@|src/index.ts',
          path: 'src/index.ts',
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          isLoading: false,
        },
      ],
      activeTabId: 'folderA|@|src/index.ts',
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      fileTree: [],
      fileContents: { 'folderA|@|src/index.ts': 'export const file = "content";' },
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
      canLoadWithoutTree: false,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    const surface = await screen.findByTestId('file-code-surface');
    expect(surface).toHaveAttribute('data-language', 'TypeScript');
    expect(surface).toHaveAttribute('data-editable', 'false');
    expect(surface).toHaveTextContent('export const file = "content";');
    expect(surface.querySelector('.cm-lineNumbers')).toBeInTheDocument();
    expect(screen.queryByText('export const file = "content";', { selector: 'pre' })).toBeNull();
  });

  it('shows "Restoring..." for a persisted tab while restoration is pending — not "File not found"', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: 'folderA|@|src/index.ts',
          path: 'src/index.ts',
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          isLoading: false,
        },
      ],
      activeTabId: 'folderA|@|src/index.ts',
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    // Restoration still in progress (no status emitted yet, isRestoring true)
    vi.mocked(useTabFileRestoration).mockReturnValue({
      tabStatuses: new Map(),
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      needsUserAction: () => false,
      getStatusMessage: () => 'Restoring...',
      isRestoring: true,
    });

    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText(/restoring/i)).toBeInTheDocument();
    expect(screen.queryByText(/file not found or unable to load/i)).not.toBeInTheDocument();
  });

  it('closing the active file tab hops to the next sibling tab, not back to Context Explorer', async () => {
    // Use the REAL tab-manager store so closeTab's successor logic actually runs and we
    // verify the workspace selection consumes the store's authoritative activeTabId.
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

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    const closeButton = await screen.findByRole('button', { name: /close b\.ts/i });
    await user.click(closeButton);

    // tab-manager-store's closeTab moves activeTabId to the row that took the closed position
    await waitFor(() => {
      expect(useTabManagerStore.getState().activeTabId).toBe('folderA|@|src/c.ts');
    });
    // Workspace selection mirrors that — not Context Explorer
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'folderA|@|src/c.ts',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('closing the last file tab falls back to Context Explorer', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/only.ts', 'folderA|@|src/only.ts', 'folderA|@|src/only.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/only.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    const closeButton = await screen.findByRole('button', { name: /close only\.ts/i });
    await user.click(closeButton);

    await waitFor(() => {
      expect(useTabManagerStore.getState().activeTabId).toBeNull();
    });
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'app',
        appId: 'context-explorer',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('"Close All Tabs" overflow action clears every file tab and routes to Context Explorer', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/b.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    await user.click(await screen.findByRole('button', { name: /more tab actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /close all tabs/i }));

    await waitFor(() => {
      expect(useTabManagerStore.getState().tabs).toEqual([]);
    });
    // Workspace selection routes back to Context Explorer when the active tab vanishes.
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'app',
        appId: 'context-explorer',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('"Close All Tabs" is disabled when no file tabs are open', async () => {
    const user = userEvent.setup();
    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    await user.click(await screen.findByRole('button', { name: /more tab actions/i }));
    const closeAll = await screen.findByRole('menuitem', { name: /close all tabs/i });
    expect(closeAll).toHaveAttribute('aria-disabled', 'true');
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
      tabs: [],
      activeTabId: null,
      openTab,
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    const loadFileContent = vi.fn();
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      fileTree: [],
      fileContents: {},
      loadingFiles: new Set<string>(),
      loadFileContent,
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
      canLoadWithoutTree: false,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

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
    expect(loadFileContent).toHaveBeenCalledWith('folderA|@|src/new.ts');
  });

  it('renders missing app fallback for an unknown persisted app selection', async () => {
    useWorkspaceTabSelectionStore.getState().selectApp('missing-app');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText('App unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('No registered workspace app matches the saved selection.')
    ).toBeInTheDocument();
  });

  it('renders permission-required restoration status without auto-loading content', async () => {
    const compositeKey = 'folderA|@|src/locked.ts';
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);
    vi.mocked(useTabFileRestoration).mockReturnValue({
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
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      needsUserAction: () => true,
      getStatusMessage: () => 'Permission was denied',
      isRestoring: false,
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: compositeKey,
          path: 'src/locked.ts',
          compositeKey,
          content: null,
          isLoading: false,
        },
      ],
      activeTabId: compositeKey,
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    const loadFileContent = vi.fn();
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      fileTree: [{ path: 'src/locked.ts' }],
      fileContents: {},
      loadingFiles: new Set<string>(),
      loadFileContent,
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
      canLoadWithoutTree: false,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText('File Access Required')).toBeInTheDocument();
    expect(screen.getByText('Permission was denied')).toBeInTheDocument();
    expect(loadFileContent).not.toHaveBeenCalled();
  });

  it('renders not-found restoration status with the decoded file path', async () => {
    const compositeKey = 'folderA|@|src/missing.ts';
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);
    vi.mocked(useTabFileRestoration).mockReturnValue({
      tabStatuses: new Map<string, TabFileStatus>([
        [
          compositeKey,
          {
            compositeKey,
            error: 'File disappeared',
            status: 'not-found',
          },
        ],
      ]),
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      needsUserAction: () => false,
      getStatusMessage: () => 'File disappeared',
      isRestoring: false,
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: compositeKey,
          path: 'src/missing.ts',
          compositeKey,
          content: null,
          isLoading: false,
        },
      ],
      activeTabId: compositeKey,
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText('File Not Found')).toBeInTheDocument();
    expect(screen.getByText('src/missing.ts')).toBeInTheDocument();
    expect(screen.getByText('File disappeared')).toBeInTheDocument();
  });

  it('renders inaccessible file content as a browser permission message', async () => {
    const compositeKey = 'folderA|@|src/locked.ts';
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      tabs: [
        {
          id: compositeKey,
          path: 'src/locked.ts',
          compositeKey,
          content: null,
          isLoading: false,
        },
      ],
      activeTabId: compositeKey,
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    const inaccessibleContent = `${INACCESSIBLE_CONTENT_PREFIX} permission required`;
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      fileTree: [],
      fileContents: { [compositeKey]: inaccessibleContent },
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
      canLoadWithoutTree: false,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText(inaccessibleContent)).toBeInTheDocument();
    expect(screen.getByText(/please open the folder again/i)).toBeInTheDocument();
  });

  it('accepts an extensible apps list — additional pinned apps render in tab order', async () => {
    const customApp: WorkspaceApp = {
      id: 'demo-app',
      label: 'Demo App',
      icon: LayoutGrid,
      render: () => <div data-testid="demo-app-body">Demo body</div>,
    };

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost extraApps={[customApp]} />
      </FileExplorerTestWrapper>
    );

    const tabs = await screen.findAllByRole('tab');
    expect(tabs[0]).toHaveAccessibleName(/context explorer/i);
    expect(tabs[1]).toHaveAccessibleName(/demo app/i);
  });
});
