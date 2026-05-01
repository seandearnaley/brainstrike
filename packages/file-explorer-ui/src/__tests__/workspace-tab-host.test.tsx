import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayoutGrid } from 'lucide-react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseTabManagerReturn } from '../hooks/use-tab-manager';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../stores/tab-manager-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import type { WorkspaceApp } from '../workspace-app';
import { WorkspaceTabHost } from '../workspace-tab-host';
import { FileExplorerTestWrapper } from './test-helpers';

// Mock the preview-panel surface (Context Explorer body) — same pattern as existing tests
vi.mock('../preview-panel', () => ({
  PreviewPanel: vi.fn(() => <div data-testid="preview-panel">PreviewPanel</div>),
}));

// Mock useFileExplorer — minimal shape used by the host
vi.mock('../use-file-explorer-context', () => ({
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

vi.mock('../use-selection-manager-context', () => ({
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

    const fileExplorerModule = await import('../use-file-explorer-context');
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
