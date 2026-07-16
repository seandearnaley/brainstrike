import type { PendingRestoreState } from '@brainstrike/file-explorer-hooks';
import { type DirectoryHandle, MockFileSystemAdapter } from '@brainstrike/file-system';
import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import type { FileExplorerState } from '@brainstrike/types';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { FileExplorerPanel } from '../shell/file-explorer-panel';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEventDetail,
} from '../shell/file-explorer-refresh-event';
import { useFileExplorer } from '../shell/use-file-explorer-context';
import { useSelectionManager } from '../shell/use-selection-manager-context';
import { type FileTreeRefreshResult, useFileTree } from '../tree/use-file-tree-context';
import { __resetInFlightRootLoads } from '../tree/use-lazy-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

// biome-ignore lint/suspicious/noVar: var required for vi.mock hoisting - let creates temporal dead zone
var FileExplorerSidebarMock: ReturnType<typeof vi.fn> | undefined;
// biome-ignore lint/suspicious/noVar: var required for vi.mock hoisting - let creates temporal dead zone
var ActionButtonsMock: ReturnType<typeof vi.fn> | undefined;

// Mock UI components that are imported relatively within the panel
vi.mock('../shell/file-explorer-toolbar', () => ({
  FileExplorerToolbar: ({
    bulkSelectionControl,
    filtersControl,
    onDirectorySelect,
    isLoading,
    selectionStatusControl,
  }: {
    bulkSelectionControl?: ReactNode;
    filtersControl?: ReactNode;
    onDirectorySelect: () => void;
    isLoading: boolean;
    selectionStatusControl?: ReactNode;
  }) => (
    <div data-testid="file-explorer-toolbar">
      <div data-testid="toolbar">
        Toolbar
        <button disabled={isLoading} onClick={onDirectorySelect} type="button">
          Select Directory
        </button>
        {bulkSelectionControl}
        {selectionStatusControl}
        {filtersControl}
      </div>
    </div>
  ),
}));

vi.mock('../shell/file-explorer-sidebar', () => {
  FileExplorerSidebarMock = vi.fn(() => <div data-testid="sidebar">Sidebar</div>);
  return { default: FileExplorerSidebarMock };
});

vi.mock('../action-buttons', () => {
  ActionButtonsMock = vi.fn(() => (
    <div data-testid="actions">
      <button type="button">Select All</button>
    </div>
  ));
  return { ActionButtons: ActionButtonsMock };
});

// Note: ScanningStatus is no longer imported by file-explorer-left-panel
// The scanning indicator is now inline in TreeActionButtons component

// Mock hooks used by the component
vi.mock('../shell/file-explorer-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shell/file-explorer-provider')>();
  const useFileExplorerStoreContext = vi.fn();
  return {
    ...actual,
    useFileExplorerStoreContext,
    useFileExplorerStoreSelector: vi.fn((selector: (state: unknown) => unknown) => {
      const store = useFileExplorerStoreContext();
      return store(selector);
    }),
  };
});
vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(),
}));
vi.mock('../shell/use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(),
}));
vi.mock('../hooks/use-view-filter-presets', () => ({
  useViewFilterPresets: vi.fn(() => ({
    createPreset: vi.fn(),
    deletePreset: vi.fn(),
    error: null,
    getPreset: vi.fn(),
    loading: false,
    presets: [],
    refresh: vi.fn(),
    updatePreset: vi.fn(),
  })),
}));
vi.mock('../indexing/use-background-token-indexer-integration', () => ({
  useBackgroundTokenIndexerIntegration: vi.fn(() => ({
    diagnostics: {
      cacheOperational: true,
      cachePersisted: true,
      clearIndexedCache: vi.fn(),
      fileHandleMapSize: 0,
      indexedCount: 0,
      inFlightCount: 0,
      workerReady: true,
    },
    isIndexing: false,
    isReady: true,
    progress: null,
    triggerIndexing: vi.fn(),
  })),
}));
vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...actual,
    useAdapters: vi.fn(() => ({ fileSystemAdapter: {}, storageAdapter: {} })),
    useRestoreAccess: vi.fn(() => ({
      beginRestore: vi.fn().mockResolvedValue([]),
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: vi.fn(),
      isCheckingStoredHandles: false,
      pendingRestore: null,
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
    })),
    useToastManager: vi.fn(() => ({
      handleBrowserCompatibilityError: vi.fn(),
      handleDirectorySelectError: handleDirectorySelectErrorMock,
      handleRefreshError: vi.fn(),
      showToast: showToastMock,
      toast: vi.fn(),
    })),
  };
});

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

let refreshFileExplorerMock: Mock<() => Promise<FileTreeRefreshResult>>;
let showToastMock: Mock<(options: unknown) => void>;
let handleDirectorySelectErrorMock: ReturnType<typeof vi.fn>;
let setFiltersMock: ReturnType<typeof vi.fn>;
let applyFileFiltersMock: ReturnType<typeof vi.fn>;
let handleRootDirectorySelectMock: ReturnType<typeof vi.fn>;
let isFileSystemAccessSupportedMock: ReturnType<typeof vi.fn>;
let setDevInlineFixtureEnabledMock: ReturnType<typeof vi.fn>;
let hydrateFolderStateMock: ReturnType<typeof vi.fn>;
let fileExplorerReturnValue: ReturnType<typeof useFileExplorer>;

function createPendingRestore(
  rawHandle: FileSystemDirectoryHandle,
  overrides: Partial<PendingRestoreState> = {}
): PendingRestoreState {
  return {
    folderId: 'brainstrike',
    name: 'brainstrike',
    permissionState: 'prompt',
    rawHandle,
    ...overrides,
  };
}

describe('FileExplorerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    setFiltersMock = vi.fn();
    setDevInlineFixtureEnabledMock = vi.fn();
    hydrateFolderStateMock = vi.fn();
    const storeState = {
      clearQuickFilter: vi.fn(),
      collapseAllDirectories: vi.fn(),
      currentFolderId: '/root',
      devInlineFixtureEnabled: false,
      disabledExcludeFilters: new Set<string>(),
      disabledIncludeFilters: new Set<string>(),
      excludeFilters: [],
      expandAllDirectories: vi.fn(),
      folderStates: {
        '/root': {
          excludeFilters: [],
          expandedDirectoryPaths: new Set<string>(),
          folderSummaryThreshold: 5,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: Date.now(),
          lastActiveTab: 'files' as const,
          maxSelectionCount: 5,
          selectedFilePaths: new Set<string>(['/root|@|file.ts']),
          selectionModel: {
            explicitPaths: new Set<string>(['/root|@|file.ts']),
            materializedAt: null,
            materializedPaths: null,
            mode: 'explicit' as const,
            queryDescriptor: null,
            ruleSetJson: null,
          },
          tokenBudget: 100_000,
          useRegex: false,
          viewFilterPresetId: null,
        },
      },
      folderSummaryThreshold: 5,
      hydrateFolderState: hydrateFolderStateMock,
      includeFilters: [],
      includeProjectTree: true,
      isFiltersExpanded: true,
      maxSelectionCount: 5,
      quickFilter: '',
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
        ruleSetJson: null,
      },
      setCurrentFolderId: vi.fn(),
      setDevInlineFixtureEnabled: setDevInlineFixtureEnabledMock,
      setFilters: setFiltersMock,
      setFiltersExpanded: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setMaterializedPaths: vi.fn(),
      setQuickFilter: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      toggleFilterEnabled: vi.fn(),
      useRegex: false,
      viewFilterPresetId: null,
    };

    const mockStore = Object.assign(
      (selector?: (s: typeof storeState) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(
      mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
    );

    handleRootDirectorySelectMock = vi.fn();
    applyFileFiltersMock = vi.fn();
    refreshFileExplorerMock = vi
      .fn<() => Promise<FileTreeRefreshResult>>()
      .mockResolvedValue({ status: 'completed' });
    isFileSystemAccessSupportedMock = vi.fn(() => ({ reason: '', supported: true }));
    fileExplorerReturnValue = {
      addRootDirectory: vi.fn().mockResolvedValue(null),
      applyFileFilters: applyFileFiltersMock,
      cancelChildLoading: vi.fn(),
      cancelExpandAll: vi.fn(),
      cancellable: false,
      cancelOperation: vi.fn(),
      cancelRecursiveSelect: vi.fn(),
      cancelSelectAll: vi.fn(),
      canLoadWithoutTree: false,
      clearFileContents: vi.fn(),
      clearRootDirectory: vi.fn(),
      error: null,
      expandAllProgress: null,
      expandAllProgressively: vi.fn(),
      fileContents: {},
      fileTree: [],
      filterError: null,
      handleRootDirectorySelect: handleRootDirectorySelectMock,
      isCancelling: false,
      isExpandingAll: false,
      isFileSystemAccessSupported: isFileSystemAccessSupportedMock,
      isInitialLoad: false,
      isLoading: false,
      isLoadingForSelectAll: false,
      isLoadingForSelection: false,
      isRestoringExpandedPaths: false,
      loadChildren: vi.fn(),
      loadFileContent: vi.fn(),
      loadingFiles: new Set<string>(),
      loadingPathForSelection: null,
      loadingPaths: new Set<string>(),
      loadingProgress: null,
      loadMultipleFileContents: vi.fn(),
      refreshDirectory: vi.fn(),
      refreshFileExplorer: refreshFileExplorerMock,
      registerRestoredHandles: vi.fn().mockResolvedValue(undefined),
      removeRootDirectory: vi.fn().mockResolvedValue(undefined),
      restorationProgress: null,
      rootDirectoryHandle: {
        _internal: {} as FileSystemDirectoryHandle,
        kind: 'directory',
        name: 'root',
        path: '/root',
        platform: 'web' as const,
      },
      // Multi-root (Phase 4+)
      rootDirectoryHandles: [],
      // Storage v5
      rootIdByPath: new Map<string, string>(),
      selectAllRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
      selectFolderRecursively: vi.fn().mockResolvedValue({ filePaths: [], success: true }),
      setAccessLoading: vi.fn(),
      setFocusedRoot: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
    } as ReturnType<typeof useFileExplorer>;
    vi.mocked(useFileExplorer).mockReturnValue(fileExplorerReturnValue);

    vi.mocked(useSelectionManager).mockReturnValue({
      effectiveSelection: new Set<string>(),
      handleSelectionChange: vi.fn(),
      isQueryMode: false,
      isRulesMode: false,
      // required API surface for selection manager
      selectedCount: 0,
      selectedFilePaths: new Set<string>(),
      selectedFilesList: [],
      setSelectedFilesFromList: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
    } as unknown as ReturnType<typeof useSelectionManager>);

    showToastMock = vi.fn<(options: unknown) => void>();
    handleDirectorySelectErrorMock = vi.fn();
  });

  it('renders toolbar, sidebar and action buttons', async () => {
    renderWithProviders(<FileExplorerPanel />);

    const toolbar = await screen.findByTestId('toolbar');
    expect(await screen.findByTestId('sidebar')).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /select all/i })).toBeInTheDocument();
    expect(within(toolbar).getByTestId('selection-count')).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /Selection settings/ })).toBeInTheDocument();
    expect(within(toolbar).getByTestId('selection-status-controls')).toHaveClass(
      'gap-0.5',
      '@[128px]:gap-1.5'
    );
    expect(within(toolbar).getByTestId('selection-counter-control')).toHaveClass(
      'hidden',
      '@[72px]:block'
    );
  });

  it('rehydrates the persisted folder state when the restored root matches the current folder id', () => {
    renderWithProviders(<FileExplorerPanel />);

    expect(hydrateFolderStateMock).toHaveBeenCalledWith('/root');
  });

  it('blocks stale-state clearing while stored handles are still being checked', async () => {
    const { useRestoreAccess } = await import('@brainstrike/file-explorer-hooks');
    const setAccessLoadingMock = vi.fn();

    vi.mocked(useRestoreAccess).mockReturnValueOnce({
      beginRestore: vi.fn(),
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: vi.fn(),
      isCheckingStoredHandles: true,
      pendingRestore: null,
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
    });
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: null,
      setAccessLoading: setAccessLoadingMock,
    });

    renderWithProviders(<FileExplorerPanel />);

    expect(setAccessLoadingMock).toHaveBeenCalledWith(true);
  });

  it('keeps the recoverable current folder while a web root handle is missing', async () => {
    const setCurrentFolderId = vi.fn();
    const storeState = {
      clearQuickFilter: vi.fn(),
      collapseAllDirectories: vi.fn(),
      currentFolderId: 'brainstrike',
      devInlineFixtureEnabled: false,
      disabledExcludeFilters: new Set<string>(),
      disabledIncludeFilters: new Set<string>(),
      excludeFilters: [],
      expandAllDirectories: vi.fn(),
      folderStates: {
        brainstrike: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set<string>(['src']),
          folderSummaryThreshold: 5,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: Date.now(),
          lastActiveTab: 'files' as const,
          maxSelectionCount: 2000,
          selectedFilePaths: new Set<string>(['brainstrike|@|src/file-0.ts']),
          selectionModel: {
            explicitPaths: new Set<string>(['brainstrike|@|src/file-0.ts']),
            materializedAt: null,
            materializedPaths: null,
            mode: 'explicit' as const,
            queryDescriptor: null,
            ruleSetJson: null,
          },
          tokenBudget: 100_000,
          useRegex: false,
          viewFilterPresetId: null,
        },
      },
      folderSummaryThreshold: 5,
      hydrateFolderState: vi.fn(),
      includeFilters: [],
      includeProjectTree: true,
      isFiltersExpanded: true,
      maxSelectionCount: 2000,
      quickFilter: '',
      selectionModel: {
        explicitPaths: new Set<string>(['brainstrike|@|src/file-0.ts']),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
        ruleSetJson: null,
      },
      setCurrentFolderId,
      setDevInlineFixtureEnabled: vi.fn(),
      setFilters: vi.fn(),
      setFiltersExpanded: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setMaterializedPaths: vi.fn(),
      setQuickFilter: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      toggleFilterEnabled: vi.fn(),
      useRegex: false,
      viewFilterPresetId: null,
    };
    const mockStore = Object.assign(
      (selector?: (s: typeof storeState) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );

    vi.mocked(useFileExplorerStoreContext).mockReturnValue(
      mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
    );
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      fileTree: [],
      isLoading: false,
      rootDirectoryHandle: null,
    });

    renderWithProviders(<FileExplorerPanel />);

    expect(setCurrentFolderId).not.toHaveBeenCalledWith(null);
  });

  it('lets the restore modal choose a new root when stale persisted state has no root handle', async () => {
    const { useRestoreAccess } = await import('@brainstrike/file-explorer-hooks');
    const user = userEvent.setup();
    const dismissRestoreMock = vi.fn();
    const setAccessLoadingMock = vi.fn();

    handleRootDirectorySelectMock.mockResolvedValueOnce({
      _internal: {},
      kind: 'directory',
      name: 'new-root',
      path: 'new-root',
      platform: 'web',
    });
    vi.mocked(useRestoreAccess).mockReturnValueOnce({
      beginRestore: vi.fn(),
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: dismissRestoreMock,
      isCheckingStoredHandles: false,
      pendingRestore: null,
      showDeniedBanner: false,
      showStaleBanner: true,
      storedFolders: [{ folderId: 'brainstrike', name: 'brainstrike' }],
    });
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: null,
      setAccessLoading: setAccessLoadingMock,
    });

    renderWithProviders(<FileExplorerPanel />);

    await user.click(screen.getByRole('button', { name: 'Choose different folder' }));

    await waitFor(() => expect(handleRootDirectorySelectMock).toHaveBeenCalledTimes(1));
    expect(dismissRestoreMock).toHaveBeenCalledTimes(1);
  });

  it('restores a pending raw handle immediately when read permission is granted', async () => {
    const { useRestoreAccess } = await import('@brainstrike/file-explorer-hooks');
    const user = userEvent.setup();
    const beginRestoreMock = vi.fn<() => Promise<readonly DirectoryHandle[]>>(async () => []);
    const setAccessLoadingMock = vi.fn();
    const setRootDirectoryHandleMock = vi.fn();
    const requestPermissionMock = vi.fn<() => Promise<PermissionState>>(async () => 'granted');
    const rawHandle = {
      kind: 'directory',
      name: 'brainstrike',
      requestPermission: requestPermissionMock,
    } as unknown as FileSystemDirectoryHandle;

    vi.mocked(useRestoreAccess).mockReturnValueOnce({
      beginRestore: beginRestoreMock,
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: vi.fn(),
      isCheckingStoredHandles: false,
      pendingRestore: createPendingRestore(rawHandle),
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
    });
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: null,
      setAccessLoading: setAccessLoadingMock,
      setRootDirectoryHandle: setRootDirectoryHandleMock,
    });

    renderWithProviders(<FileExplorerPanel />);
    await user.click(screen.getByRole('button', { name: 'Restore folder access' }));

    expect(requestPermissionMock).toHaveBeenCalledWith({ mode: 'read' });
    await waitFor(() =>
      expect(setRootDirectoryHandleMock).toHaveBeenCalledWith({
        _internal: rawHandle,
        kind: 'directory',
        name: 'brainstrike',
        path: 'brainstrike',
        platform: 'web',
        // The restore modal now stamps the durable rootId (pendingRestore.folderId).
        rootId: 'brainstrike',
      })
    );
    expect(beginRestoreMock).toHaveBeenCalledTimes(1);
    expect(setAccessLoadingMock).toHaveBeenCalledWith(true);
    expect(setAccessLoadingMock).toHaveBeenLastCalledWith(false);
  });

  it('registers EVERY restored handle when pending raw-handle permission is denied (multi-root)', async () => {
    const { useRestoreAccess } = await import('@brainstrike/file-explorer-hooks');
    const user = userEvent.setup();
    const restoredHandleA = {
      _internal: {},
      kind: 'directory' as const,
      name: 'restored-a',
      path: 'restored-a',
      platform: 'web' as const,
    } satisfies DirectoryHandle;
    const restoredHandleB = {
      _internal: {},
      kind: 'directory' as const,
      name: 'restored-b',
      path: 'restored-b',
      platform: 'web' as const,
    } satisfies DirectoryHandle;
    const beginRestoreMock = vi.fn(
      async () => [restoredHandleA, restoredHandleB] as readonly DirectoryHandle[]
    );
    const registerRestoredHandlesMock = vi.fn().mockResolvedValue(undefined);
    const requestPermissionMock = vi.fn<() => Promise<PermissionState>>(async () => 'denied');
    const rawHandle = {
      kind: 'directory',
      name: 'brainstrike',
      requestPermission: requestPermissionMock,
    } as unknown as FileSystemDirectoryHandle;

    vi.mocked(useRestoreAccess).mockReturnValueOnce({
      beginRestore: beginRestoreMock,
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: vi.fn(),
      isCheckingStoredHandles: false,
      pendingRestore: createPendingRestore(rawHandle, { permissionState: 'denied' }),
      showDeniedBanner: true,
      showStaleBanner: false,
      storedFolders: [],
    });
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      registerRestoredHandles: registerRestoredHandlesMock,
      rootDirectoryHandle: null,
    });

    renderWithProviders(<FileExplorerPanel />);
    await user.click(screen.getByRole('button', { name: 'Restore folder access' }));

    await waitFor(() => expect(beginRestoreMock).toHaveBeenCalledTimes(1));
    // ALL restored handles flow into the multi-root registration path —
    // not just handles[0] via setRootDirectoryHandle.
    await waitFor(() =>
      expect(registerRestoredHandlesMock).toHaveBeenCalledWith([restoredHandleA, restoredHandleB])
    );
  });

  it('falls back to beginRestore when raw-handle permission rejects', async () => {
    const { useRestoreAccess } = await import('@brainstrike/file-explorer-hooks');
    const user = userEvent.setup();
    const beginRestoreMock = vi.fn(async () => [] as readonly DirectoryHandle[]);
    const requestPermissionMock = vi.fn<() => Promise<PermissionState>>(async () => {
      throw new Error('permission failed');
    });
    const rawHandle = {
      kind: 'directory',
      name: 'brainstrike',
      requestPermission: requestPermissionMock,
    } as unknown as FileSystemDirectoryHandle;

    vi.mocked(useRestoreAccess).mockReturnValueOnce({
      beginRestore: beginRestoreMock,
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: vi.fn(),
      isCheckingStoredHandles: false,
      pendingRestore: createPendingRestore(rawHandle),
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
    });
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: null,
    });

    renderWithProviders(<FileExplorerPanel />);
    await user.click(screen.getByRole('button', { name: 'Restore folder access' }));

    await waitFor(() => expect(beginRestoreMock).toHaveBeenCalledTimes(1));
  });

  it('uses the legacy restore path when no raw handle is available', async () => {
    const { useRestoreAccess } = await import('@brainstrike/file-explorer-hooks');
    const user = userEvent.setup();
    const restoredHandle = {
      _internal: {},
      kind: 'directory' as const,
      name: 'legacy',
      path: 'legacy',
      platform: 'web' as const,
    } satisfies DirectoryHandle;
    const beginRestoreMock = vi.fn(async () => [restoredHandle] as readonly DirectoryHandle[]);
    const registerRestoredHandlesMock = vi.fn().mockResolvedValue(undefined);
    const pendingRestore = createPendingRestore({
      name: 'brainstrike',
    } as FileSystemDirectoryHandle);

    vi.mocked(useRestoreAccess).mockReturnValueOnce({
      beginRestore: beginRestoreMock,
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: vi.fn(),
      isCheckingStoredHandles: false,
      pendingRestore,
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
    });
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      registerRestoredHandles: registerRestoredHandlesMock,
      rootDirectoryHandle: null,
    });

    renderWithProviders(<FileExplorerPanel />);
    await user.click(screen.getByRole('button', { name: 'Restore folder access' }));

    await waitFor(() => expect(beginRestoreMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(registerRestoredHandlesMock).toHaveBeenCalledWith([restoredHandle]));
  });

  it('triggers refresh and shows toast when refresh button is clicked', async () => {
    const user = userEvent.setup();
    const refreshEvents: CustomEvent<FileExplorerRefreshEventDetail>[] = [];
    const downstreamFullSync = vi.fn();
    const onRefresh = (event: Event): void => {
      refreshEvents.push(event as CustomEvent<FileExplorerRefreshEventDetail>);
      downstreamFullSync();
    };
    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);

    try {
      refreshFileExplorerMock.mockResolvedValueOnce({ status: 'completed' });
      renderWithProviders(<FileExplorerPanel />);

      // Click the refresh button which is now rendered by FileExplorerPanel itself
      await user.click(screen.getByTestId('refresh-button-small'));

      expect(refreshFileExplorerMock).toHaveBeenCalledTimes(1);
      expect(showToastMock).toHaveBeenCalledTimes(1);
      expect(refreshEvents).toHaveLength(1);
      expect(downstreamFullSync).toHaveBeenCalledOnce();
      expect(refreshEvents[0]?.detail).toEqual({
        roots: [],
        scope: 'full',
        source: 'manual',
      });
    } finally {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);
    }
  });

  it('does not report a cancelled real root refresh as successful', async () => {
    __resetInFlightRootLoads();
    const mockAdapter = new MockFileSystemAdapter();
    mockAdapter.setMockFileSystem(MockFileSystemAdapter.createSimpleFileSystem());
    const handle = await mockAdapter.requestDirectoryAccess();
    const { useAdapters, useToastManager } = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(useAdapters).mockReturnValue({
      fileSystemAdapter: mockAdapter,
      storageAdapter: {} as ReturnType<typeof useAdapters>['storageAdapter'],
    });

    const TestWrapper = ({ children }: { children: React.ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
    const treeHook = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });
    await waitFor(() => expect(treeHook.result.current.isLoading).toBe(false));

    const committedTree = treeHook.result.current.fileTree;
    let releaseRefresh: (() => void) | null = null;
    const readDirectoryStreamingSpy = vi
      .spyOn(mockAdapter, 'readDirectoryStreaming')
      .mockImplementation(async (_handle, onBatch) => {
        await new Promise<void>((resolve) => {
          releaseRefresh = () => {
            onBatch(committedTree, { done: true, total: committedTree.length });
            resolve();
          };
        });
      });

    let refreshOutcome: FileTreeRefreshResult | undefined;
    refreshFileExplorerMock.mockImplementation(async () => {
      refreshOutcome = await treeHook.result.current.refreshTree();
      return refreshOutcome;
    });
    const handleRefreshError = vi.fn();
    vi.mocked(useToastManager).mockReturnValue({
      handleBrowserCompatibilityError: vi.fn(),
      handleDirectorySelectError: vi.fn(),
      handlePartialRefreshError: vi.fn(),
      handleRefreshError,
      showToast: (toastOptions) => showToastMock(toastOptions),
      toast: vi.fn(),
    });
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      cancelOperation: () => treeHook.result.current.cancelOperation(),
      refreshFileExplorer: refreshFileExplorerMock,
      rootDirectoryHandle: handle,
    });

    const refreshEvents: CustomEvent<FileExplorerRefreshEventDetail>[] = [];
    const downstreamFullSync = vi.fn();
    const onRefresh = (event: Event): void => {
      refreshEvents.push(event as CustomEvent<FileExplorerRefreshEventDetail>);
      downstreamFullSync();
    };
    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);

    try {
      const user = userEvent.setup();
      renderWithProviders(<FileExplorerPanel />);
      showToastMock.mockClear();

      await user.click(screen.getByTestId('refresh-button-small'));
      await waitFor(() => {
        expect(readDirectoryStreamingSpy).toHaveBeenCalledOnce();
        expect(treeHook.result.current.isLoading).toBe(true);
      });

      act(() => {
        treeHook.result.current.cancelOperation();
      });
      await act(async () => {
        await Promise.resolve();
      });

      const refreshIoPromise = readDirectoryStreamingSpy.mock.results[0]?.value;
      await act(async () => {
        releaseRefresh?.();
        await refreshIoPromise;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      await waitFor(() => expect(refreshOutcome).toEqual({ status: 'cancelled' }));
      expect(showToastMock).not.toHaveBeenCalled();
      expect(refreshEvents).toEqual([]);
      expect(downstreamFullSync).not.toHaveBeenCalled();
      expect(handleRefreshError).not.toHaveBeenCalled();
      expect(treeHook.result.current.fileTree).toEqual(committedTree);
      expect(treeHook.result.current.isLoading).toBe(false);
    } finally {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);
      treeHook.unmount();
      __resetInFlightRootLoads();
    }
  });

  it('handles directory selection errors', async () => {
    const user = userEvent.setup();
    const error = new Error('fail');
    handleRootDirectorySelectMock.mockRejectedValueOnce(error);
    renderWithProviders(<FileExplorerPanel />);

    await user.click(screen.getByRole('button', { name: 'Select Directory' }));

    expect(handleDirectorySelectErrorMock).toHaveBeenCalledWith(error);
  });

  // Note: Filter button tests removed - workspace settings modal was migrated to Settings page
  // Filter functionality is now tested via the Settings page tests

  it('displays error boundary when sidebar throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    FileExplorerSidebarMock?.mockImplementation(() => {
      throw new Error('boom');
    });

    renderWithProviders(<FileExplorerPanel />);

    expect(await screen.findByText('Error')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();

    FileExplorerSidebarMock?.mockImplementation(() => <div data-testid="sidebar">Sidebar</div>);
  });

  it('cancels loading and shows toast via inline indicator', async () => {
    const cancelOperationMock = vi.fn();
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      cancellable: true,
      cancelOperation: cancelOperationMock,
      isLoading: true,
      loadingProgress: { isInitialLoading: true, loadingCount: 1 },
    });

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerPanel />);

    // Cancel button is now in the inline scanning indicator with aria-label
    await user.click(screen.getByRole('button', { name: 'Cancel operation' }));

    expect(cancelOperationMock).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith({
      description: 'The file loading operation has been cancelled.',
      title: 'Operation Cancelled',
      variant: 'default',
    });
  });

  it('displays inline scanning indicator when loading', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      cancellable: false,
      isLoading: true,
      loadingProgress: { isInitialLoading: true, loadingCount: 1 },
    });

    renderWithProviders(<FileExplorerPanel />);

    // Inline scanning indicator is now part of TreeActionButtons
    expect(await screen.findByTestId('inline-scanning-indicator')).toBeInTheDocument();
  });

  it('shows error when browser is not compatible', async () => {
    const handleBrowserCompatibilityErrorMock = vi.fn();
    isFileSystemAccessSupportedMock.mockReturnValueOnce({
      reason: 'Browser not supported',
      supported: false,
    });

    // Update the mock before rendering
    const { useToastManager } = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(useToastManager).mockReturnValueOnce({
      handleBrowserCompatibilityError: handleBrowserCompatibilityErrorMock,
      handleDirectorySelectError: vi.fn(),
      handlePartialRefreshError: vi.fn(),
      handleRefreshError: vi.fn(),
      showToast: vi.fn(),
      toast: vi.fn(),
    });

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerPanel />);

    await user.click(screen.getByRole('button', { name: 'Select Directory' }));

    expect(handleBrowserCompatibilityErrorMock).toHaveBeenCalledWith('Browser not supported');
  });

  it('enables inline fixture when directory picker is unavailable and fixture adapter is present', async () => {
    isFileSystemAccessSupportedMock.mockReturnValueOnce({
      reason: 'Browser not supported',
      supported: false,
    });

    const { useAdapters } = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(useAdapters).mockReturnValueOnce({
      fileSystemAdapter: {
        canLoadInlineFixture: true,
        clearInlineFixture: vi.fn(),
        isInlineFixtureActive: vi.fn(() => false),
        loadInlineFixture: vi.fn(),
        readDirectory: vi.fn(),
        readFile: vi.fn(),
        requestDirectoryAccess: vi.fn(),
      } as unknown as ReturnType<typeof useAdapters>['fileSystemAdapter'],
      storageAdapter: {} as unknown as ReturnType<typeof useAdapters>['storageAdapter'],
    });

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerPanel />);

    await user.click(screen.getByRole('button', { name: 'Select Directory' }));

    expect(setDevInlineFixtureEnabledMock).toHaveBeenCalledWith(true);
    expect(showToastMock).toHaveBeenCalledWith({
      description:
        'Local directory picker is not available in this browser. Using built-in mock project instead.',
      title: 'Demo Mode Enabled',
    });
  });

  it('handles user cancelling directory selection', async () => {
    handleRootDirectorySelectMock.mockResolvedValueOnce(null);

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerPanel />);

    await user.click(screen.getByRole('button', { name: 'Select Directory' }));

    // Should not throw or show error when user cancels
    expect(handleDirectorySelectErrorMock).not.toHaveBeenCalled();
  });

  it('handles refresh errors', async () => {
    const error = new Error('Refresh failed');
    const handleRefreshErrorMock = vi.fn();
    const errorShowToast = vi.fn();
    const refreshEvents: Event[] = [];
    const onRefresh = (event: Event): void => {
      refreshEvents.push(event);
    };

    refreshFileExplorerMock.mockRejectedValueOnce(error);

    // Update the mock before rendering
    const { useToastManager } = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(useToastManager).mockReturnValueOnce({
      handleBrowserCompatibilityError: vi.fn(),
      handleDirectorySelectError: vi.fn(),
      handlePartialRefreshError: vi.fn(),
      handleRefreshError: handleRefreshErrorMock,
      showToast: errorShowToast,
      toast: vi.fn(),
    });

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);
    try {
      const user = userEvent.setup();
      renderWithProviders(<FileExplorerPanel />);

      await user.click(screen.getByTestId('refresh-button-small'));

      expect(handleRefreshErrorMock).toHaveBeenCalledOnce();
      expect(handleRefreshErrorMock).toHaveBeenCalledWith(error);
      expect(errorShowToast).not.toHaveBeenCalled();
      expect(refreshEvents).toEqual([]);
    } finally {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);
    }
  });

  it('does not show action buttons when no root directory is selected', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      isLoading: true,
      loadingProgress: { isInitialLoading: true, loadingCount: 1 },
      rootDirectoryHandle: null,
    });

    renderWithProviders(<FileExplorerPanel />);

    // When there's no root directory, neither action buttons nor inline indicator are shown
    // TreeActionButtons is only rendered when rootDirectoryHandle exists
    expect(screen.queryByTestId('refresh-button-small')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inline-scanning-indicator')).not.toBeInTheDocument();
  });

  it('displays toolbar with correct selection count', async () => {
    vi.mocked(useSelectionManager).mockReturnValueOnce({
      effectiveSelection: new Set(['file1', 'file2', 'file3']),
      handleSelectionChange: vi.fn(),
      isQueryMode: false,
      isRulesMode: false,
      selectedCount: 3,
      selectedFilePaths: new Set(['file1', 'file2', 'file3']),
      selectedFilesList: ['file1', 'file2', 'file3'],
      setSelectedFilesFromList: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
    } as unknown as ReturnType<typeof useSelectionManager>);

    renderWithProviders(<FileExplorerPanel />);

    expect(await screen.findByTestId('selection-count')).toHaveTextContent('3');
    expect(await screen.findByTestId('selection-max')).toHaveTextContent('5');
  });

  it('renders correctly when selectedFilesList is empty', async () => {
    vi.mocked(useSelectionManager).mockReturnValueOnce({
      effectiveSelection: new Set<string>(),
      handleSelectionChange: vi.fn(),
      isQueryMode: false,
      isRulesMode: false,
      selectedCount: 0,
      selectedFilePaths: new Set(),
      selectedFilesList: [],
      setSelectedFilesFromList: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
    } as unknown as ReturnType<typeof useSelectionManager>);

    renderWithProviders(<FileExplorerPanel />);

    // Should render with zero selection count
    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
    expect(await screen.findByTestId('selection-count')).toHaveTextContent('0');
  });

  it('displays initial loading state correctly', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      isInitialLoad: true,
      isLoading: true,
      loadingProgress: { isInitialLoading: true, loadingCount: 1 },
    });

    renderWithProviders(<FileExplorerPanel />);

    // Inline scanning indicator is now part of TreeActionButtons
    expect(await screen.findByTestId('inline-scanning-indicator')).toBeInTheDocument();
  });

  it('shows cancelling state when operation is being cancelled', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      cancellable: true,
      isCancelling: true,
      isLoading: true,
      loadingProgress: { isInitialLoading: true, loadingCount: 1 },
    });

    renderWithProviders(<FileExplorerPanel />);

    // Inline scanning indicator is now part of TreeActionButtons
    expect(await screen.findByTestId('inline-scanning-indicator')).toBeInTheDocument();
  });

  it('displays filter error when present', async () => {
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      filterError: 'Invalid filter pattern',
    });

    renderWithProviders(<FileExplorerPanel />);

    // Error should be passed to sidebar component
    expect(FileExplorerSidebarMock).toHaveBeenCalled();
    if (FileExplorerSidebarMock) {
      const sidebarProps = FileExplorerSidebarMock.mock.calls[0]?.[0];
      expect(sidebarProps?.filterError).toEqual(new Error('Invalid filter pattern'));
    }
  });

  it('handles expand all and collapse all', async () => {
    const user = userEvent.setup();
    const expandAllProgressivelyMock = vi.fn();
    const cancelExpandAllMock = vi.fn();
    const collapseAllDirectories = vi.fn();

    const storeState = {
      clearQuickFilter: vi.fn(),
      collapseAllDirectories,
      currentFolderId: 'root',
      excludeFilters: [],
      expandAllDirectories: vi.fn(),
      expandedDirectoryPaths: new Set<string>(),
      folderSummaryThreshold: 5,
      includeFilters: [],
      includeProjectTree: true,
      maxSelectionCount: 5,
      quickFilter: '',
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
        ruleSetJson: null,
      },
      setCurrentFolderId: vi.fn(),
      setExpandedPaths: vi.fn(),
      setFilters: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setMaterializedPaths: vi.fn(),
      setQuickFilter: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      useRegex: false,
      viewFilterPresetId: null,
    };

    const mockStore = Object.assign(
      (selector?: (s: Partial<FileExplorerState>) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      cancelExpandAll: cancelExpandAllMock,
      expandAllProgressively: expandAllProgressivelyMock,
      fileTree: [
        {
          depth: 0,
          handle: {} as any,
          name: 'dir',
          path: '/dir',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'directory',
        },
      ],
    });

    renderWithProviders(<FileExplorerPanel />);

    await user.click(screen.getByTestId('expand-all-button-small'));
    expect(expandAllProgressivelyMock).toHaveBeenCalled();

    await user.click(screen.getByTestId('collapse-all-button-small'));
    expect(cancelExpandAllMock).toHaveBeenCalled(); // Cancel any in-progress expand-all
    expect(collapseAllDirectories).toHaveBeenCalled();
  });

  it('skips store expansion writes when expand-all returns the existing expanded set', async () => {
    const user = userEvent.setup();
    const cancelExpandAllMock = vi.fn();
    const storeState = {
      clearQuickFilter: vi.fn(),
      collapseAllDirectories: vi.fn(),
      currentFolderId: 'root',
      excludeFilters: [],
      expandAllDirectories: vi.fn(),
      expandedDirectoryPaths: new Set<string>(['/dir']),
      folderSummaryThreshold: 5,
      includeFilters: [],
      includeProjectTree: true,
      maxSelectionCount: 5,
      quickFilter: '',
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
        ruleSetJson: null,
      },
      setCurrentFolderId: vi.fn(),
      setExpandedPaths: vi.fn(),
      setFilters: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setMaterializedPaths: vi.fn(),
      setQuickFilter: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      useRegex: false,
      viewFilterPresetId: null,
    };

    const mockStore = Object.assign(
      (selector?: (s: Partial<FileExplorerState>) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    const expandAllProgressivelyMock = vi.fn(
      async (setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void) => {
        setExpandedPaths((previous) => previous);
      }
    );

    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      cancelExpandAll: cancelExpandAllMock,
      expandAllProgressively: expandAllProgressivelyMock,
      fileTree: [
        {
          depth: 0,
          handle: {} as any,
          name: 'dir',
          path: '/dir',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'directory',
        },
      ],
    });

    renderWithProviders(<FileExplorerPanel />);

    await user.click(screen.getByTestId('expand-all-button-small'));

    expect(expandAllProgressivelyMock).toHaveBeenCalled();
    expect(storeState.setExpandedPaths).not.toHaveBeenCalled();
  });

  it('filters the tree correctly with quick filter', async () => {
    const storeState = {
      clearQuickFilter: vi.fn(),
      collapseAllDirectories: vi.fn(),
      currentFolderId: 'root',
      excludeFilters: [],
      expandAllDirectories: vi.fn(),
      folderSummaryThreshold: 5,
      includeFilters: [],
      includeProjectTree: true,
      maxSelectionCount: 5,
      quickFilter: 'foo',
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
        ruleSetJson: null,
      },
      setCurrentFolderId: vi.fn(),
      setFilters: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setMaterializedPaths: vi.fn(),
      setQuickFilter: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      useRegex: false,
      viewFilterPresetId: null,
    };

    const mockStore = Object.assign(
      (selector?: (s: Partial<FileExplorerState>) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      fileTree: [
        {
          depth: 0,
          handle: {} as any,
          name: 'foo.ts',
          path: '/foo.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        {
          depth: 0,
          handle: {} as any,
          name: 'bar.ts',
          path: '/bar.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        {
          children: [
            {
              depth: 1,
              handle: {} as any,
              name: 'foo-in-dir.ts',
              path: '/dir/foo-in-dir.ts',
              rootFolderId: 'root',
              selectionState: 'unchecked',
              type: 'file',
            },
          ],
          depth: 0,
          handle: {} as any,
          name: 'dir',
          path: '/dir',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'directory',
        },
      ],
    });

    renderWithProviders(<FileExplorerPanel />);

    expect(FileExplorerSidebarMock).toHaveBeenCalled();
    const lastCall = FileExplorerSidebarMock?.mock.calls.at(-1);
    const filteredTree = lastCall?.[0]?.quickFilteredTree;

    // Should include foo.ts and the directory (because it contains a foo file)
    expect(filteredTree).toHaveLength(2);
    expect(filteredTree[0].name).toBe('foo.ts');
    expect(filteredTree[1].name).toBe('dir');
    expect(filteredTree[1].children).toHaveLength(1);
  });

  it('collects visible files for action buttons', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      fileTree: [
        {
          depth: 0,
          handle: {} as any,
          isVisible: true,
          name: 'foo.ts',
          path: '/foo.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        {
          depth: 0,
          handle: {} as any,
          isVisible: false,
          name: 'hidden.ts',
          path: '/hidden.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        {
          children: [
            {
              depth: 1,
              handle: {} as any,
              name: 'bar.ts',
              path: '/dir/bar.ts',
              rootFolderId: 'root',
              selectionState: 'unchecked',
              type: 'file',
            },
          ],
          depth: 0,
          handle: {} as any,
          name: 'dir',
          path: '/dir',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'directory',
        },
      ],
    });

    renderWithProviders(<FileExplorerPanel />);

    expect(ActionButtonsMock).toHaveBeenCalled();
    const lastCall = ActionButtonsMock?.mock.calls.at(-1);
    const displayedFiles = lastCall?.[0]?.displayedFiles;

    expect(displayedFiles).toContain('/foo.ts');
    expect(displayedFiles).not.toContain('/hidden.ts');
    expect(displayedFiles).toContain('/dir/bar.ts');
  });

  it('does not clobber a UUID currentFolderId with the handle path when rootIdByPath knows the handle', () => {
    // Storage v5 regression (CRITICAL-1): the panel effect must resolve the
    // handle through rootIdByPath. Pre-fix it called the one-arg
    // getRootFolderId(handle) — always the path — and overwrote the durable
    // UUID identity (wiping the keyed folder state) on every pick/restore.
    const ROOT_UUID = '11111111-2222-3333-4444-555555555555';
    const setCurrentFolderId = vi.fn();
    const hydrateFolderState = vi.fn();
    const storeState = {
      clearQuickFilter: vi.fn(),
      collapseAllDirectories: vi.fn(),
      currentFolderId: ROOT_UUID,
      devInlineFixtureEnabled: false,
      disabledExcludeFilters: new Set<string>(),
      disabledIncludeFilters: new Set<string>(),
      excludeFilters: [],
      expandAllDirectories: vi.fn(),
      folderStates: {
        [ROOT_UUID]: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set<string>(['src']),
          folderSummaryThreshold: 5,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: Date.now(),
          lastActiveTab: 'files' as const,
          maxSelectionCount: 5,
          selectedFilePaths: new Set<string>([`${ROOT_UUID}|@|src/file-0.ts`]),
          selectionModel: {
            explicitPaths: new Set<string>([`${ROOT_UUID}|@|src/file-0.ts`]),
            materializedAt: null,
            materializedPaths: null,
            mode: 'explicit' as const,
            queryDescriptor: null,
            ruleSetJson: null,
          },
          tokenBudget: 100_000,
          useRegex: false,
          viewFilterPresetId: null,
        },
      },
      folderSummaryThreshold: 5,
      hydrateFolderState,
      includeFilters: [],
      includeProjectTree: true,
      isFiltersExpanded: true,
      maxSelectionCount: 5,
      quickFilter: '',
      selectionModel: {
        explicitPaths: new Set<string>([`${ROOT_UUID}|@|src/file-0.ts`]),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
        ruleSetJson: null,
      },
      setCurrentFolderId,
      setDevInlineFixtureEnabled: vi.fn(),
      setFilters: vi.fn(),
      setFiltersExpanded: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setMaterializedPaths: vi.fn(),
      setQuickFilter: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      toggleFilterEnabled: vi.fn(),
      useRegex: false,
      viewFilterPresetId: null,
    };
    const mockStore = Object.assign(
      (selector?: (s: typeof storeState) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(
      mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
    );

    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: {
        _internal: {} as FileSystemDirectoryHandle,
        kind: 'directory',
        name: 'root',
        path: '/root',
        platform: 'web' as const,
      },
      // The handle's path maps to the durable UUID identity.
      rootIdByPath: new Map<string, string>([['/root', ROOT_UUID]]),
    });

    renderWithProviders(<FileExplorerPanel />);

    // The effect resolved the UUID — it must NOT write the path over it.
    expect(setCurrentFolderId).not.toHaveBeenCalledWith('/root');
    expect(setCurrentFolderId).not.toHaveBeenCalled();
    // Folder state for the UUID is rehydrated, not wiped.
    expect(hydrateFolderState).toHaveBeenCalledWith(ROOT_UUID);
  });

  it('syncs current folder ID with root directory handle', async () => {
    const setCurrentFolderId = vi.fn();
    const storeState = {
      clearQuickFilter: vi.fn(),
      collapseAllDirectories: vi.fn(),
      currentFolderId: 'old-root',
      excludeFilters: [],
      expandAllDirectories: vi.fn(),
      folderSummaryThreshold: 5,
      includeFilters: [],
      includeProjectTree: true,
      maxSelectionCount: 5,
      quickFilter: '',
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
        ruleSetJson: null,
      },
      setCurrentFolderId,
      setFilters: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setMaterializedPaths: vi.fn(),
      setQuickFilter: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      useRegex: false,
      viewFilterPresetId: null,
    };

    const mockStore = Object.assign(
      (selector?: (s: Partial<FileExplorerState>) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: {
        _internal: {} as FileSystemDirectoryHandle,
        kind: 'directory',
        name: 'shared-name',
        path: '/new-root',
        platform: 'web' as const,
      },
    });

    renderWithProviders(<FileExplorerPanel />);

    expect(setCurrentFolderId).toHaveBeenCalledWith('/new-root');
  });

  it('renders correctly when inline fixture is enabled', async () => {
    // Inline fixture loading is now handled by setupInlineFixtureSubscription
    // in FileExplorerProvider, not in the panel component. This test verifies
    // the panel renders without errors when devInlineFixtureEnabled is true.
    renderWithProviders(<FileExplorerPanel />);

    // Should render the toolbar area without errors
    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
  });

  describe('collapsible view filters', () => {
    it('renders View Filters toggle button when root directory is selected', async () => {
      renderWithProviders(<FileExplorerPanel />);

      expect(await screen.findByRole('button', { name: /view filters/i })).toBeInTheDocument();
    });

    it('hosts the view-filters toggle on the toolbar next to the bulk selection control', async () => {
      renderWithProviders(<FileExplorerPanel />);

      const toggle = await screen.findByRole('button', { name: /view filters/i });
      expect(screen.getByTestId('file-explorer-toolbar')).toContainElement(toggle);
      expect(toggle).toHaveAttribute('aria-controls', 'view-filters-content');
    });

    it('keeps the quick filter row inside the toggled view-filters block', async () => {
      renderWithProviders(<FileExplorerPanel />);

      await screen.findByRole('button', { name: /view filters/i });
      const collapsible = document.getElementById('view-filters-content');
      expect(collapsible).not.toBeNull();
      expect(collapsible).toContainElement(screen.getByTestId('file-filter-input'));
    });

    it('does not render View Filters toggle when no root directory is selected', async () => {
      vi.mocked(useFileExplorer).mockReturnValue({
        ...fileExplorerReturnValue,
        rootDirectoryHandle: null,
      });

      renderWithProviders(<FileExplorerPanel />);

      expect(screen.queryByRole('button', { name: /view filters/i })).not.toBeInTheDocument();
    });

    it('calls setFiltersExpanded when toggle button is clicked', async () => {
      const setFiltersExpandedMock = vi.fn();
      const storeState = {
        clearQuickFilter: vi.fn(),
        collapseAllDirectories: vi.fn(),
        currentFolderId: 'root',
        disabledExcludeFilters: new Set<string>(),
        disabledIncludeFilters: new Set<string>(),
        excludeFilters: [],
        expandAllDirectories: vi.fn(),
        folderSummaryThreshold: 5,
        includeFilters: [],
        includeProjectTree: true,
        isFiltersExpanded: true,
        maxSelectionCount: 5,
        quickFilter: '',
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit' as const,
          ruleSetJson: null,
        },
        setCurrentFolderId: vi.fn(),
        setFilters: vi.fn(),
        setFiltersExpanded: setFiltersExpandedMock,
        setIncludeProjectTree: vi.fn(),
        setMaterializedPaths: vi.fn(),
        setQuickFilter: vi.fn(),
        setUseRegex: vi.fn(),
        setViewFilterPresetId: vi.fn(),
        toggleFilterEnabled: vi.fn(),
        useRegex: false,
        viewFilterPresetId: null,
      };

      const mockStore = Object.assign(
        (selector?: (s: typeof storeState) => unknown) =>
          typeof selector === 'function' ? selector(storeState) : storeState,
        { getState: () => storeState }
      );
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(
        mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
      );

      const user = userEvent.setup();
      renderWithProviders(<FileExplorerPanel />);

      await user.click(screen.getByRole('button', { name: /view filters/i }));

      expect(setFiltersExpandedMock).toHaveBeenCalledWith(false);
    });

    it('shows expanded content when isFiltersExpanded is true', async () => {
      const storeState = {
        clearQuickFilter: vi.fn(),
        collapseAllDirectories: vi.fn(),
        currentFolderId: 'root',
        disabledExcludeFilters: new Set<string>(),
        disabledIncludeFilters: new Set<string>(),
        excludeFilters: ['node_modules'],
        expandAllDirectories: vi.fn(),
        folderSummaryThreshold: 5,
        includeFilters: ['*.ts'],
        includeProjectTree: true,
        isFiltersExpanded: true,
        maxSelectionCount: 5,
        quickFilter: '',
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit' as const,
          ruleSetJson: null,
        },
        setCurrentFolderId: vi.fn(),
        setFilters: vi.fn(),
        setFiltersExpanded: vi.fn(),
        setIncludeProjectTree: vi.fn(),
        setMaterializedPaths: vi.fn(),
        setQuickFilter: vi.fn(),
        setUseRegex: vi.fn(),
        setViewFilterPresetId: vi.fn(),
        toggleFilterEnabled: vi.fn(),
        useRegex: false,
        viewFilterPresetId: null,
      };

      const mockStore = Object.assign(
        (selector?: (s: typeof storeState) => unknown) =>
          typeof selector === 'function' ? selector(storeState) : storeState,
        { getState: () => storeState }
      );
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(
        mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
      );

      renderWithProviders(<FileExplorerPanel />);

      // Content should be visible (not hidden with max-h-0)
      const collapsibleContent = screen.getByRole('button', { name: /view filters/i });
      expect(collapsibleContent).toHaveAttribute('aria-expanded', 'true');
    });

    it('has collapsed content when isFiltersExpanded is false', async () => {
      const storeState = {
        clearQuickFilter: vi.fn(),
        collapseAllDirectories: vi.fn(),
        currentFolderId: 'root',
        disabledExcludeFilters: new Set<string>(),
        disabledIncludeFilters: new Set<string>(),
        excludeFilters: [],
        expandAllDirectories: vi.fn(),
        folderSummaryThreshold: 5,
        includeFilters: [],
        includeProjectTree: true,
        isFiltersExpanded: false,
        maxSelectionCount: 5,
        quickFilter: '',
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit' as const,
          ruleSetJson: null,
        },
        setCurrentFolderId: vi.fn(),
        setFilters: vi.fn(),
        setFiltersExpanded: vi.fn(),
        setIncludeProjectTree: vi.fn(),
        setMaterializedPaths: vi.fn(),
        setQuickFilter: vi.fn(),
        setUseRegex: vi.fn(),
        setViewFilterPresetId: vi.fn(),
        toggleFilterEnabled: vi.fn(),
        useRegex: false,
        viewFilterPresetId: null,
      };

      const mockStore = Object.assign(
        (selector?: (s: typeof storeState) => unknown) =>
          typeof selector === 'function' ? selector(storeState) : storeState,
        { getState: () => storeState }
      );
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(
        mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
      );

      renderWithProviders(<FileExplorerPanel />);

      // Toggle button should indicate collapsed state
      const toggleButton = screen.getByRole('button', { name: /view filters/i });
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    });

    it('toggles filter chips visibility via the chips toggle button', async () => {
      const setFilterChipsVisibleMock = vi.fn();
      const storeState = {
        clearQuickFilter: vi.fn(),
        collapseAllDirectories: vi.fn(),
        currentFolderId: 'root',
        disabledExcludeFilters: new Set<string>(),
        disabledIncludeFilters: new Set<string>(),
        excludeFilters: ['node_modules'],
        expandAllDirectories: vi.fn(),
        folderSummaryThreshold: 5,
        includeFilters: ['*.ts'],
        includeProjectTree: true,
        isFilterChipsVisible: true,
        isFiltersExpanded: true,
        maxSelectionCount: 5,
        quickFilter: '',
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit' as const,
          ruleSetJson: null,
        },
        setCurrentFolderId: vi.fn(),
        setFilterChipsVisible: setFilterChipsVisibleMock,
        setFilters: vi.fn(),
        setFiltersExpanded: vi.fn(),
        setIncludeProjectTree: vi.fn(),
        setMaterializedPaths: vi.fn(),
        setQuickFilter: vi.fn(),
        setUseRegex: vi.fn(),
        setViewFilterPresetId: vi.fn(),
        toggleFilterEnabled: vi.fn(),
        useRegex: false,
        viewFilterPresetId: null,
      };

      const mockStore = Object.assign(
        (selector?: (s: typeof storeState) => unknown) =>
          typeof selector === 'function' ? selector(storeState) : storeState,
        { getState: () => storeState }
      );
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(
        mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
      );

      const user = userEvent.setup();
      renderWithProviders(<FileExplorerPanel />);

      const chipsToggle = screen.getByTestId('toggle-filter-chips-button');
      expect(chipsToggle).toHaveAttribute('aria-pressed', 'true');
      expect(chipsToggle).toHaveAccessibleName('Hide filter chips');

      await user.click(chipsToggle);

      expect(setFilterChipsVisibleMock).toHaveBeenCalledWith(false);
    });

    it('marks the chips region inert when isFilterChipsVisible is false', async () => {
      const storeState = {
        clearQuickFilter: vi.fn(),
        collapseAllDirectories: vi.fn(),
        currentFolderId: 'root',
        disabledExcludeFilters: new Set<string>(),
        disabledIncludeFilters: new Set<string>(),
        excludeFilters: [],
        expandAllDirectories: vi.fn(),
        folderSummaryThreshold: 5,
        includeFilters: ['*.ts'],
        includeProjectTree: true,
        isFilterChipsVisible: false,
        isFiltersExpanded: true,
        maxSelectionCount: 5,
        quickFilter: '',
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit' as const,
          ruleSetJson: null,
        },
        setCurrentFolderId: vi.fn(),
        setFilterChipsVisible: vi.fn(),
        setFilters: vi.fn(),
        setFiltersExpanded: vi.fn(),
        setIncludeProjectTree: vi.fn(),
        setMaterializedPaths: vi.fn(),
        setQuickFilter: vi.fn(),
        setUseRegex: vi.fn(),
        setViewFilterPresetId: vi.fn(),
        toggleFilterEnabled: vi.fn(),
        useRegex: false,
        viewFilterPresetId: null,
      };

      const mockStore = Object.assign(
        (selector?: (s: typeof storeState) => unknown) =>
          typeof selector === 'function' ? selector(storeState) : storeState,
        { getState: () => storeState }
      );
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(
        mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
      );

      renderWithProviders(<FileExplorerPanel />);

      const chipsToggle = screen.getByTestId('toggle-filter-chips-button');
      expect(chipsToggle).toHaveAttribute('aria-pressed', 'false');
      expect(chipsToggle).toHaveAccessibleName('Show filter chips');
    });
  });

  describe('cross-root recursive selection (Phase 6)', () => {
    it('attributes recursive select to the CLICKED node root, not the focused root', async () => {
      const UUID_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
      const UUID_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
      // Focused root is /root (UUID_A); the clicked node belongs to UUID_B.
      fileExplorerReturnValue.rootIdByPath = new Map([
        ['/root', UUID_A],
        ['/other', UUID_B],
      ]);
      const selectFolderRecursivelyMock = vi.mocked(
        fileExplorerReturnValue.selectFolderRecursively
      );

      renderWithProviders(<FileExplorerPanel />);

      expect(FileExplorerSidebarMock).toHaveBeenCalled();
      const sidebarProps = FileExplorerSidebarMock?.mock.calls.at(-1)?.[0] as {
        onSelectFolderRecursively: (node: unknown) => Promise<unknown>;
      };
      const clickedNode = {
        children: [],
        depth: 0,
        handle: {},
        isVisible: true,
        name: 'sub',
        path: 'sub',
        rootFolderId: UUID_B,
        selectionState: 'unchecked' as const,
        type: 'directory' as const,
      };

      await sidebarProps.onSelectFolderRecursively(clickedNode);

      expect(selectFolderRecursivelyMock).toHaveBeenCalledTimes(1);
      // Second argument is the folderId the selection is attributed to.
      expect(selectFolderRecursivelyMock.mock.calls[0]?.[1]).toBe(UUID_B);
    });
  });
});
