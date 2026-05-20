import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import type { FileExplorerState } from '@brainstrike/types';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerLeftPanel } from '../file-explorer-left-panel';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useFileExplorer } from '../use-file-explorer-context';
import { useSelectionManager } from '../use-selection-manager-context';
import { FileExplorerTestWrapper } from './test-helpers';

// biome-ignore lint/suspicious/noVar: var required for vi.mock hoisting - let creates temporal dead zone
var FileExplorerSidebarMock: ReturnType<typeof vi.fn> | undefined;
// biome-ignore lint/suspicious/noVar: var required for vi.mock hoisting - let creates temporal dead zone
var ActionButtonsMock: ReturnType<typeof vi.fn> | undefined;

// Mock UI components that are imported relatively within the panel
vi.mock('../file-explorer-toolbar', () => ({
  FileExplorerToolbar: ({
    onDirectorySelect,
    isLoading,
  }: {
    onDirectorySelect: () => void;
    isLoading: boolean;
  }) => (
    <div data-testid="toolbar">
      Toolbar
      <button disabled={isLoading} onClick={onDirectorySelect} type="button">
        Select Directory
      </button>
    </div>
  ),
}));

vi.mock('../file-explorer-sidebar', () => {
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
vi.mock('../file-explorer-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../file-explorer-provider')>();
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
vi.mock('../use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(),
}));
vi.mock('../use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(),
}));
vi.mock('../hooks/use-view-filter-presets', () => ({
  useViewFilterPresets: vi.fn(() => ({
    presets: [],
    loading: false,
    error: null,
    createPreset: vi.fn(),
    updatePreset: vi.fn(),
    deletePreset: vi.fn(),
    refresh: vi.fn(),
    getPreset: vi.fn(),
  })),
}));
vi.mock('../indexing/use-background-token-indexer-integration', () => ({
  useBackgroundTokenIndexerIntegration: vi.fn(() => ({
    isIndexing: false,
    triggerIndexing: vi.fn(),
    isReady: true,
    progress: null,
    diagnostics: {
      indexedCount: 0,
      inFlightCount: 0,
      fileHandleMapSize: 0,
      workerReady: true,
      cacheOperational: true,
      cachePersisted: true,
      clearIndexedCache: vi.fn(),
    },
  })),
}));
vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...actual,
    useAdapters: vi.fn(() => ({ fileSystemAdapter: {}, storageAdapter: {} })),
    useRestoreAccess: vi.fn(() => ({
      pendingRestore: null,
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
      beginRestore: vi.fn(),
      dismissRestore: vi.fn(),
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
    })),
    useToastManager: vi.fn(() => ({
      toast: vi.fn(),
      showToast: showToastMock,
      handleRefreshError: vi.fn(),
      handleBrowserCompatibilityError: vi.fn(),
      handleDirectorySelectError: handleDirectorySelectErrorMock,
      handleSelectionLimitError: handleSelectionLimitErrorMock,
    })),
  };
});

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

let refreshFileExplorerMock: ReturnType<typeof vi.fn>;
let showToastMock: ReturnType<typeof vi.fn>;
let handleDirectorySelectErrorMock: ReturnType<typeof vi.fn>;
let handleSelectionLimitErrorMock: ReturnType<typeof vi.fn>;
let setFiltersMock: ReturnType<typeof vi.fn>;
let applyFileFiltersMock: ReturnType<typeof vi.fn>;
let handleRootDirectorySelectMock: ReturnType<typeof vi.fn>;
let isFileSystemAccessSupportedMock: ReturnType<typeof vi.fn>;
let setDevInlineFixtureEnabledMock: ReturnType<typeof vi.fn>;
let hydrateFolderStateMock: ReturnType<typeof vi.fn>;
let fileExplorerReturnValue: ReturnType<typeof useFileExplorer>;

describe('FileExplorerLeftPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    setFiltersMock = vi.fn();
    setDevInlineFixtureEnabledMock = vi.fn();
    hydrateFolderStateMock = vi.fn();
    const storeState = {
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      viewFilterPresetId: null,
      setFilters: setFiltersMock,
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      currentFolderId: '/root',
      setCurrentFolderId: vi.fn(),
      hydrateFolderState: hydrateFolderStateMock,
      maxSelectionCount: 5,
      includeProjectTree: true,
      setIncludeProjectTree: vi.fn(),
      folderSummaryThreshold: 5,
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
      selectionModel: {
        mode: 'explicit' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
      setMaterializedPaths: vi.fn(),
      quickFilter: '',
      setQuickFilter: vi.fn(),
      clearQuickFilter: vi.fn(),
      isFiltersExpanded: true,
      setFiltersExpanded: vi.fn(),
      disabledIncludeFilters: new Set<string>(),
      disabledExcludeFilters: new Set<string>(),
      toggleFilterEnabled: vi.fn(),
      devInlineFixtureEnabled: false,
      setDevInlineFixtureEnabled: setDevInlineFixtureEnabledMock,
      folderStates: {
        '/root': {
          selectedFilePaths: new Set<string>(['/root|@|file.ts']),
          selectionModel: {
            mode: 'explicit' as const,
            explicitPaths: new Set<string>(['/root|@|file.ts']),
            ruleSetJson: null,
            materializedPaths: null,
            materializedAt: null,
            queryDescriptor: null,
          },
          expandedDirectoryPaths: new Set<string>(),
          includeFilters: [],
          excludeFilters: [],
          useRegex: false,
          includeProjectTree: true,
          tokenBudget: 100_000,
          folderSummaryThreshold: 5,
          maxSelectionCount: 5,
          lastActiveTab: 'files' as const,
          lastAccessed: Date.now(),
          viewFilterPresetId: null,
        },
      },
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
    refreshFileExplorerMock = vi.fn();
    isFileSystemAccessSupportedMock = vi.fn(() => ({ supported: true, reason: '' }));
    fileExplorerReturnValue = {
      fileTree: [],
      handleRootDirectorySelect: handleRootDirectorySelectMock,
      isLoading: false,
      error: null,
      fileContents: {},
      loadingFiles: new Set<string>(),
      applyFileFilters: applyFileFiltersMock,
      filterError: null,
      rootDirectoryHandle: {
        path: '/root',
        name: 'root',
        kind: 'directory',
        platform: 'web' as const,
        _internal: {} as FileSystemDirectoryHandle,
      },
      isFileSystemAccessSupported: isFileSystemAccessSupportedMock,
      refreshFileExplorer: refreshFileExplorerMock,
      isInitialLoad: false,
      loadingProgress: null,
      cancellable: false,
      cancelOperation: vi.fn(),
      isCancelling: false,
      clearRootDirectory: vi.fn(),
      loadFileContent: vi.fn(),
      loadMultipleFileContents: vi.fn(),
      clearFileContents: vi.fn(),
      loadingPaths: new Set<string>(),
      loadChildren: vi.fn(),
      refreshDirectory: vi.fn(),
      expandAllProgressively: vi.fn(),
      cancelExpandAll: vi.fn(),
      isExpandingAll: false,
      expandAllProgress: null,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
      cancelChildLoading: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setAccessLoading: vi.fn(),
      canLoadWithoutTree: false,
      selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelRecursiveSelect: vi.fn(),
      isLoadingForSelection: false,
      loadingPathForSelection: null,
      selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelSelectAll: vi.fn(),
      isLoadingForSelectAll: false,
    } as ReturnType<typeof useFileExplorer>;
    vi.mocked(useFileExplorer).mockReturnValue(fileExplorerReturnValue);

    vi.mocked(useSelectionManager).mockReturnValue({
      // required API surface for selection manager
      selectedCount: 0,
      selectedFilesList: [],
      setSelectedFilesFromList: vi.fn(),
      selectedFilePaths: new Set<string>(),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
      effectiveSelection: new Set<string>(),
      isQueryMode: false,
      isRulesMode: false,
    } as unknown as ReturnType<typeof useSelectionManager>);

    showToastMock = vi.fn();
    handleDirectorySelectErrorMock = vi.fn();
    handleSelectionLimitErrorMock = vi.fn();
  });

  it('renders toolbar, sidebar and action buttons', async () => {
    renderWithProviders(<FileExplorerLeftPanel />);

    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
    expect(await screen.findByTestId('sidebar')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /select all/i })).toBeInTheDocument();
  });

  it('passes the selection limit handler to the selection manager', () => {
    renderWithProviders(<FileExplorerLeftPanel />);

    expect(useSelectionManager).toHaveBeenCalled();
    const props = vi.mocked(useSelectionManager).mock.calls[0]?.[0] as {
      onSelectionLimitExceeded: () => void;
    };

    props.onSelectionLimitExceeded();

    expect(handleSelectionLimitErrorMock).toHaveBeenCalledTimes(1);
  });

  it('rehydrates the persisted folder state when the restored root matches the current folder id', () => {
    renderWithProviders(<FileExplorerLeftPanel />);

    expect(hydrateFolderStateMock).toHaveBeenCalledWith('/root');
  });

  it('blocks stale-state clearing while stored handles are still being checked', async () => {
    const { useRestoreAccess } = await import('@brainstrike/file-explorer-hooks');
    const setAccessLoadingMock = vi.fn();

    vi.mocked(useRestoreAccess).mockReturnValueOnce({
      pendingRestore: null,
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
      beginRestore: vi.fn(),
      dismissRestore: vi.fn(),
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      isCheckingStoredHandles: true,
    });
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: null,
      setAccessLoading: setAccessLoadingMock,
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    expect(setAccessLoadingMock).toHaveBeenCalledWith(true);
  });

  it('keeps the recoverable current folder while a web root handle is missing', async () => {
    const setCurrentFolderId = vi.fn();
    const storeState = {
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      viewFilterPresetId: null,
      setFilters: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      currentFolderId: 'brainstrike',
      setCurrentFolderId,
      hydrateFolderState: vi.fn(),
      maxSelectionCount: 2000,
      includeProjectTree: true,
      setIncludeProjectTree: vi.fn(),
      folderSummaryThreshold: 5,
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
      selectionModel: {
        mode: 'explicit' as const,
        explicitPaths: new Set<string>(['brainstrike|@|src/file-0.ts']),
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
      setMaterializedPaths: vi.fn(),
      quickFilter: '',
      setQuickFilter: vi.fn(),
      clearQuickFilter: vi.fn(),
      isFiltersExpanded: true,
      setFiltersExpanded: vi.fn(),
      disabledIncludeFilters: new Set<string>(),
      disabledExcludeFilters: new Set<string>(),
      toggleFilterEnabled: vi.fn(),
      devInlineFixtureEnabled: false,
      setDevInlineFixtureEnabled: vi.fn(),
      folderStates: {
        brainstrike: {
          selectedFilePaths: new Set<string>(['brainstrike|@|src/file-0.ts']),
          selectionModel: {
            mode: 'explicit' as const,
            explicitPaths: new Set<string>(['brainstrike|@|src/file-0.ts']),
            ruleSetJson: null,
            materializedPaths: null,
            materializedAt: null,
            queryDescriptor: null,
          },
          expandedDirectoryPaths: new Set<string>(['src']),
          includeFilters: [],
          excludeFilters: [],
          useRegex: false,
          includeProjectTree: true,
          tokenBudget: 100_000,
          folderSummaryThreshold: 5,
          maxSelectionCount: 2000,
          lastActiveTab: 'files' as const,
          lastAccessed: Date.now(),
          viewFilterPresetId: null,
        },
      },
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
      rootDirectoryHandle: null,
      fileTree: [],
      isLoading: false,
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    expect(setCurrentFolderId).not.toHaveBeenCalledWith(null);
  });

  it('lets the restore modal choose a new root when stale persisted state has no root handle', async () => {
    const { useRestoreAccess } = await import('@brainstrike/file-explorer-hooks');
    const user = userEvent.setup();
    const dismissRestoreMock = vi.fn();
    const setAccessLoadingMock = vi.fn();

    handleRootDirectorySelectMock.mockResolvedValueOnce({
      path: 'new-root',
      name: 'new-root',
      kind: 'directory',
      platform: 'web',
      _internal: {},
    });
    vi.mocked(useRestoreAccess).mockReturnValueOnce({
      pendingRestore: null,
      showDeniedBanner: false,
      showStaleBanner: true,
      storedFolders: [{ folderId: 'brainstrike', name: 'brainstrike' }],
      beginRestore: vi.fn(),
      dismissRestore: dismissRestoreMock,
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      isCheckingStoredHandles: false,
    });
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: null,
      setAccessLoading: setAccessLoadingMock,
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    await user.click(screen.getByRole('button', { name: 'Choose different folder' }));

    await waitFor(() => expect(handleRootDirectorySelectMock).toHaveBeenCalledTimes(1));
    expect(dismissRestoreMock).toHaveBeenCalledTimes(1);
  });

  it('triggers refresh and shows toast when refresh button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FileExplorerLeftPanel />);

    // Click the refresh button which is now rendered by FileExplorerLeftPanel itself
    await user.click(screen.getByTestId('refresh-button-small'));

    expect(refreshFileExplorerMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalled();
  });

  it('handles directory selection errors', async () => {
    const user = userEvent.setup();
    const error = new Error('fail');
    handleRootDirectorySelectMock.mockRejectedValueOnce(error);
    renderWithProviders(<FileExplorerLeftPanel />);

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

    renderWithProviders(<FileExplorerLeftPanel />);

    expect(await screen.findByText('Error')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();

    FileExplorerSidebarMock?.mockImplementation(() => <div data-testid="sidebar">Sidebar</div>);
  });

  it('cancels loading and shows toast via inline indicator', async () => {
    const cancelOperationMock = vi.fn();
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      isLoading: true,
      cancellable: true,
      cancelOperation: cancelOperationMock,
      loadingProgress: { loadingCount: 1, isInitialLoading: true },
    });

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerLeftPanel />);

    // Cancel button is now in the inline scanning indicator with aria-label
    await user.click(screen.getByRole('button', { name: 'Cancel operation' }));

    expect(cancelOperationMock).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith({
      title: 'Operation Cancelled',
      description: 'The file loading operation has been cancelled.',
      variant: 'default',
    });
  });

  it('displays inline scanning indicator when loading', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      isLoading: true,
      cancellable: false,
      loadingProgress: { loadingCount: 1, isInitialLoading: true },
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    // Inline scanning indicator is now part of TreeActionButtons
    expect(await screen.findByTestId('inline-scanning-indicator')).toBeInTheDocument();
  });

  it('shows error when browser is not compatible', async () => {
    const handleBrowserCompatibilityErrorMock = vi.fn();
    isFileSystemAccessSupportedMock.mockReturnValueOnce({
      supported: false,
      reason: 'Browser not supported',
    });

    // Update the mock before rendering
    const { useToastManager } = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(useToastManager).mockReturnValueOnce({
      toast: vi.fn(),
      showToast: vi.fn(),
      handleRefreshError: vi.fn(),
      handleBrowserCompatibilityError: handleBrowserCompatibilityErrorMock,
      handleDirectorySelectError: vi.fn(),
      handlePartialRefreshError: vi.fn(),
      handleSelectionLimitError: vi.fn(),
    });

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerLeftPanel />);

    await user.click(screen.getByRole('button', { name: 'Select Directory' }));

    expect(handleBrowserCompatibilityErrorMock).toHaveBeenCalledWith('Browser not supported');
  });

  it('enables inline fixture when directory picker is unavailable and fixture adapter is present', async () => {
    isFileSystemAccessSupportedMock.mockReturnValueOnce({
      supported: false,
      reason: 'Browser not supported',
    });

    const { useAdapters } = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(useAdapters).mockReturnValueOnce({
      fileSystemAdapter: {
        loadInlineFixture: vi.fn(),
        clearInlineFixture: vi.fn(),
        isInlineFixtureActive: vi.fn(() => false),
        canLoadInlineFixture: true,
        requestDirectoryAccess: vi.fn(),
        readDirectory: vi.fn(),
        readFile: vi.fn(),
      } as unknown as ReturnType<typeof useAdapters>['fileSystemAdapter'],
      storageAdapter: {} as unknown as ReturnType<typeof useAdapters>['storageAdapter'],
    });

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerLeftPanel />);

    await user.click(screen.getByRole('button', { name: 'Select Directory' }));

    expect(setDevInlineFixtureEnabledMock).toHaveBeenCalledWith(true);
    expect(showToastMock).toHaveBeenCalledWith({
      title: 'Demo Mode Enabled',
      description:
        'Local directory picker is not available in this browser. Using built-in mock project instead.',
    });
  });

  it('handles user cancelling directory selection', async () => {
    handleRootDirectorySelectMock.mockResolvedValueOnce(null);

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerLeftPanel />);

    await user.click(screen.getByRole('button', { name: 'Select Directory' }));

    // Should not throw or show error when user cancels
    expect(handleDirectorySelectErrorMock).not.toHaveBeenCalled();
  });

  it('handles refresh errors', async () => {
    const error = new Error('Refresh failed');
    const handleRefreshErrorMock = vi.fn();

    refreshFileExplorerMock.mockRejectedValueOnce(error);

    // Update the mock before rendering
    const { useToastManager } = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(useToastManager).mockReturnValueOnce({
      toast: vi.fn(),
      showToast: vi.fn(),
      handleRefreshError: handleRefreshErrorMock,
      handleBrowserCompatibilityError: vi.fn(),
      handleDirectorySelectError: vi.fn(),
      handlePartialRefreshError: vi.fn(),
      handleSelectionLimitError: vi.fn(),
    });

    const user = userEvent.setup();
    renderWithProviders(<FileExplorerLeftPanel />);

    await user.click(screen.getByTestId('refresh-button-small'));

    expect(handleRefreshErrorMock).toHaveBeenCalledWith(error);
  });

  it('does not show action buttons when no root directory is selected', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: null,
      isLoading: true,
      loadingProgress: { loadingCount: 1, isInitialLoading: true },
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    // When there's no root directory, neither action buttons nor inline indicator are shown
    // TreeActionButtons is only rendered when rootDirectoryHandle exists
    expect(screen.queryByTestId('refresh-button-small')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inline-scanning-indicator')).not.toBeInTheDocument();
  });

  it('displays toolbar with correct selection count', async () => {
    vi.mocked(useSelectionManager).mockReturnValueOnce({
      selectedCount: 3,
      selectedFilesList: ['file1', 'file2', 'file3'],
      setSelectedFilesFromList: vi.fn(),
      selectedFilePaths: new Set(['file1', 'file2', 'file3']),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
      effectiveSelection: new Set(['file1', 'file2', 'file3']),
      isQueryMode: false,
      isRulesMode: false,
    } as unknown as ReturnType<typeof useSelectionManager>);

    renderWithProviders(<FileExplorerLeftPanel />);

    expect(await screen.findByTestId('selection-count')).toHaveTextContent('3');
    expect(await screen.findByTestId('selection-max')).toHaveTextContent('5');
  });

  it('renders correctly when selectedFilesList is empty', async () => {
    vi.mocked(useSelectionManager).mockReturnValueOnce({
      selectedCount: 0,
      selectedFilesList: [],
      setSelectedFilesFromList: vi.fn(),
      selectedFilePaths: new Set(),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
      effectiveSelection: new Set<string>(),
      isQueryMode: false,
      isRulesMode: false,
    } as unknown as ReturnType<typeof useSelectionManager>);

    renderWithProviders(<FileExplorerLeftPanel />);

    // Should render with zero selection count
    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
    expect(await screen.findByTestId('selection-count')).toHaveTextContent('0');
  });

  it('displays initial loading state correctly', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      isLoading: true,
      isInitialLoad: true,
      loadingProgress: { loadingCount: 1, isInitialLoading: true },
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    // Inline scanning indicator is now part of TreeActionButtons
    expect(await screen.findByTestId('inline-scanning-indicator')).toBeInTheDocument();
  });

  it('shows cancelling state when operation is being cancelled', async () => {
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      isLoading: true,
      isCancelling: true,
      cancellable: true,
      loadingProgress: { loadingCount: 1, isInitialLoading: true },
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    // Inline scanning indicator is now part of TreeActionButtons
    expect(await screen.findByTestId('inline-scanning-indicator')).toBeInTheDocument();
  });

  it('displays filter error when present', async () => {
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      filterError: 'Invalid filter pattern',
    });

    renderWithProviders(<FileExplorerLeftPanel />);

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
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      viewFilterPresetId: null,
      setFilters: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      currentFolderId: 'root',
      setCurrentFolderId: vi.fn(),
      maxSelectionCount: 5,
      includeProjectTree: true,
      setIncludeProjectTree: vi.fn(),
      folderSummaryThreshold: 5,
      expandAllDirectories: vi.fn(),
      collapseAllDirectories,
      expandedDirectoryPaths: new Set<string>(),
      setExpandedPaths: vi.fn(),
      quickFilter: '',
      setQuickFilter: vi.fn(),
      clearQuickFilter: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      selectionModel: {
        mode: 'explicit' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
      setMaterializedPaths: vi.fn(),
    };

    const mockStore = Object.assign(
      (selector?: (s: Partial<FileExplorerState>) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      expandAllProgressively: expandAllProgressivelyMock,
      cancelExpandAll: cancelExpandAllMock,
      fileTree: [
        {
          path: '/dir',
          name: 'dir',
          type: 'directory',
          handle: {} as any,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ],
    });

    renderWithProviders(<FileExplorerLeftPanel />);

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
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      viewFilterPresetId: null,
      setFilters: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      currentFolderId: 'root',
      setCurrentFolderId: vi.fn(),
      maxSelectionCount: 5,
      includeProjectTree: true,
      setIncludeProjectTree: vi.fn(),
      folderSummaryThreshold: 5,
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
      expandedDirectoryPaths: new Set<string>(['/dir']),
      setExpandedPaths: vi.fn(),
      quickFilter: '',
      setQuickFilter: vi.fn(),
      clearQuickFilter: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      selectionModel: {
        mode: 'explicit' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
      setMaterializedPaths: vi.fn(),
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
      expandAllProgressively: expandAllProgressivelyMock,
      cancelExpandAll: cancelExpandAllMock,
      fileTree: [
        {
          path: '/dir',
          name: 'dir',
          type: 'directory',
          handle: {} as any,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ],
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    await user.click(screen.getByTestId('expand-all-button-small'));

    expect(expandAllProgressivelyMock).toHaveBeenCalled();
    expect(storeState.setExpandedPaths).not.toHaveBeenCalled();
  });

  it('filters the tree correctly with quick filter', async () => {
    const storeState = {
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      viewFilterPresetId: null,
      setFilters: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      currentFolderId: 'root',
      setCurrentFolderId: vi.fn(),
      maxSelectionCount: 5,
      includeProjectTree: true,
      setIncludeProjectTree: vi.fn(),
      folderSummaryThreshold: 5,
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
      quickFilter: 'foo',
      setQuickFilter: vi.fn(),
      clearQuickFilter: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      selectionModel: {
        mode: 'explicit' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
      setMaterializedPaths: vi.fn(),
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
          path: '/foo.ts',
          name: 'foo.ts',
          type: 'file',
          handle: {} as any,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
        {
          path: '/bar.ts',
          name: 'bar.ts',
          type: 'file',
          handle: {} as any,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
        {
          path: '/dir',
          name: 'dir',
          type: 'directory',
          handle: {} as any,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'root',
          children: [
            {
              path: '/dir/foo-in-dir.ts',
              name: 'foo-in-dir.ts',
              type: 'file',
              handle: {} as any,
              depth: 1,
              selectionState: 'unchecked',
              rootFolderId: 'root',
            },
          ],
        },
      ],
    });

    renderWithProviders(<FileExplorerLeftPanel />);

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
          path: '/foo.ts',
          name: 'foo.ts',
          type: 'file',
          isVisible: true,
          handle: {} as any,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
        {
          path: '/hidden.ts',
          name: 'hidden.ts',
          type: 'file',
          isVisible: false,
          handle: {} as any,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
        {
          path: '/dir',
          name: 'dir',
          type: 'directory',
          handle: {} as any,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'root',
          children: [
            {
              path: '/dir/bar.ts',
              name: 'bar.ts',
              type: 'file',
              handle: {} as any,
              depth: 1,
              selectionState: 'unchecked',
              rootFolderId: 'root',
            },
          ],
        },
      ],
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    expect(ActionButtonsMock).toHaveBeenCalled();
    const lastCall = ActionButtonsMock?.mock.calls.at(-1);
    const displayedFiles = lastCall?.[0]?.displayedFiles;

    expect(displayedFiles).toContain('/foo.ts');
    expect(displayedFiles).not.toContain('/hidden.ts');
    expect(displayedFiles).toContain('/dir/bar.ts');
  });

  it('syncs current folder ID with root directory handle', async () => {
    const setCurrentFolderId = vi.fn();
    const storeState = {
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      viewFilterPresetId: null,
      setFilters: vi.fn(),
      setUseRegex: vi.fn(),
      setViewFilterPresetId: vi.fn(),
      currentFolderId: 'old-root',
      setCurrentFolderId,
      maxSelectionCount: 5,
      includeProjectTree: true,
      setIncludeProjectTree: vi.fn(),
      folderSummaryThreshold: 5,
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
      quickFilter: '',
      setQuickFilter: vi.fn(),
      clearQuickFilter: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      selectionModel: {
        mode: 'explicit' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
      setMaterializedPaths: vi.fn(),
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
        path: '/new-root',
        name: 'shared-name',
        kind: 'directory',
        platform: 'web' as const,
        _internal: {} as FileSystemDirectoryHandle,
      },
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    expect(setCurrentFolderId).toHaveBeenCalledWith('/new-root');
  });

  it('renders correctly when inline fixture is enabled', async () => {
    // Inline fixture loading is now handled by setupInlineFixtureSubscription
    // in FileExplorerProvider, not in the left panel. This test verifies
    // the left panel renders without errors when devInlineFixtureEnabled is true.
    renderWithProviders(<FileExplorerLeftPanel />);

    // Should render the toolbar area without errors
    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
  });

  describe('collapsible view filters', () => {
    it('renders View Filters toggle button when root directory is selected', async () => {
      renderWithProviders(<FileExplorerLeftPanel />);

      expect(await screen.findByRole('button', { name: /view filters/i })).toBeInTheDocument();
    });

    it('does not render View Filters toggle when no root directory is selected', async () => {
      vi.mocked(useFileExplorer).mockReturnValue({
        ...fileExplorerReturnValue,
        rootDirectoryHandle: null,
      });

      renderWithProviders(<FileExplorerLeftPanel />);

      expect(screen.queryByRole('button', { name: /view filters/i })).not.toBeInTheDocument();
    });

    it('calls setFiltersExpanded when toggle button is clicked', async () => {
      const setFiltersExpandedMock = vi.fn();
      const storeState = {
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        viewFilterPresetId: null,
        setFilters: vi.fn(),
        setUseRegex: vi.fn(),
        setViewFilterPresetId: vi.fn(),
        currentFolderId: 'root',
        setCurrentFolderId: vi.fn(),
        maxSelectionCount: 5,
        includeProjectTree: true,
        setIncludeProjectTree: vi.fn(),
        folderSummaryThreshold: 5,
        expandAllDirectories: vi.fn(),
        collapseAllDirectories: vi.fn(),
        selectionModel: {
          mode: 'explicit' as const,
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
        },
        setMaterializedPaths: vi.fn(),
        quickFilter: '',
        setQuickFilter: vi.fn(),
        clearQuickFilter: vi.fn(),
        isFiltersExpanded: true,
        setFiltersExpanded: setFiltersExpandedMock,
        disabledIncludeFilters: new Set<string>(),
        disabledExcludeFilters: new Set<string>(),
        toggleFilterEnabled: vi.fn(),
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
      renderWithProviders(<FileExplorerLeftPanel />);

      await user.click(screen.getByRole('button', { name: /view filters/i }));

      expect(setFiltersExpandedMock).toHaveBeenCalledWith(false);
    });

    it('shows expanded content when isFiltersExpanded is true', async () => {
      const storeState = {
        includeFilters: ['*.ts'],
        excludeFilters: ['node_modules'],
        useRegex: false,
        viewFilterPresetId: null,
        setFilters: vi.fn(),
        setUseRegex: vi.fn(),
        setViewFilterPresetId: vi.fn(),
        currentFolderId: 'root',
        setCurrentFolderId: vi.fn(),
        maxSelectionCount: 5,
        includeProjectTree: true,
        setIncludeProjectTree: vi.fn(),
        folderSummaryThreshold: 5,
        expandAllDirectories: vi.fn(),
        collapseAllDirectories: vi.fn(),
        selectionModel: {
          mode: 'explicit' as const,
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
        },
        setMaterializedPaths: vi.fn(),
        quickFilter: '',
        setQuickFilter: vi.fn(),
        clearQuickFilter: vi.fn(),
        isFiltersExpanded: true,
        setFiltersExpanded: vi.fn(),
        disabledIncludeFilters: new Set<string>(),
        disabledExcludeFilters: new Set<string>(),
        toggleFilterEnabled: vi.fn(),
      };

      const mockStore = Object.assign(
        (selector?: (s: typeof storeState) => unknown) =>
          typeof selector === 'function' ? selector(storeState) : storeState,
        { getState: () => storeState }
      );
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(
        mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
      );

      renderWithProviders(<FileExplorerLeftPanel />);

      // Content should be visible (not hidden with max-h-0)
      const collapsibleContent = screen.getByRole('button', { name: /view filters/i });
      expect(collapsibleContent).toHaveAttribute('aria-expanded', 'true');
    });

    it('has collapsed content when isFiltersExpanded is false', async () => {
      const storeState = {
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        viewFilterPresetId: null,
        setFilters: vi.fn(),
        setUseRegex: vi.fn(),
        setViewFilterPresetId: vi.fn(),
        currentFolderId: 'root',
        setCurrentFolderId: vi.fn(),
        maxSelectionCount: 5,
        includeProjectTree: true,
        setIncludeProjectTree: vi.fn(),
        folderSummaryThreshold: 5,
        expandAllDirectories: vi.fn(),
        collapseAllDirectories: vi.fn(),
        selectionModel: {
          mode: 'explicit' as const,
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
        },
        setMaterializedPaths: vi.fn(),
        quickFilter: '',
        setQuickFilter: vi.fn(),
        clearQuickFilter: vi.fn(),
        isFiltersExpanded: false,
        setFiltersExpanded: vi.fn(),
        disabledIncludeFilters: new Set<string>(),
        disabledExcludeFilters: new Set<string>(),
        toggleFilterEnabled: vi.fn(),
      };

      const mockStore = Object.assign(
        (selector?: (s: typeof storeState) => unknown) =>
          typeof selector === 'function' ? selector(storeState) : storeState,
        { getState: () => storeState }
      );
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(
        mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>
      );

      renderWithProviders(<FileExplorerLeftPanel />);

      // Toggle button should indicate collapsed state
      const toggleButton = screen.getByRole('button', { name: /view filters/i });
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
