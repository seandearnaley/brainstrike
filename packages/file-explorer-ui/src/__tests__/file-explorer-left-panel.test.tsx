import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act, screen } from '@testing-library/react';
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
    onFilterChange,
    selectedCount,
    maxSelectionCount,
  }: {
    onDirectorySelect: () => void;
    onFilterChange: (include: string[], exclude: string[], useRegex: boolean) => void;
    selectedCount: number;
    maxSelectionCount: number;
  }) => (
    <div data-testid="toolbar">
      Toolbar
      <div>
        <span data-testid="selection-count">{selectedCount}</span>/
        <span data-testid="selection-max">{maxSelectionCount}</span>
      </div>
      <button onClick={onDirectorySelect} type="button">
        Select Directory
      </button>
      <button onClick={() => onFilterChange(['in'], ['ex'], true)} type="button">
        Apply Filters
      </button>
      <button onClick={() => onFilterChange([], [], false)} type="button">
        Clear Filters
      </button>
      <button onClick={() => onFilterChange(['foo'], ['bar', 'baz'], false)} type="button">
        Apply Complex
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
  return {
    ...actual,
    useFileExplorerStoreContext: vi.fn(),
  };
});
vi.mock('../use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(),
}));
vi.mock('../use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(),
}));
vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...actual,
    useAdapters: vi.fn(() => ({ fileSystemAdapter: {}, storageAdapter: {} })),
    useToastManager: vi.fn(() => ({
      toast: vi.fn(),
      showToast: showToastMock,
      handleRefreshError: vi.fn(),
      handleBrowserCompatibilityError: vi.fn(),
      handleDirectorySelectError: handleDirectorySelectErrorMock,
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
let setFiltersMock: ReturnType<typeof vi.fn>;
let applyFileFiltersMock: ReturnType<typeof vi.fn>;
let handleRootDirectorySelectMock: ReturnType<typeof vi.fn>;
let isFileSystemAccessSupportedMock: ReturnType<typeof vi.fn>;
let fileExplorerReturnValue: ReturnType<typeof useFileExplorer>;

describe('FileExplorerLeftPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    setFiltersMock = vi.fn();
    const storeState = {
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      setFilters: setFiltersMock,
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
    } as ReturnType<typeof useFileExplorer>;
    vi.mocked(useFileExplorer).mockReturnValue(fileExplorerReturnValue);

    vi.mocked(useSelectionManager).mockReturnValue({
      // required API surface for selection manager
      selectedFilesList: [],
      setSelectedFilesFromList: vi.fn(),
      selectedFilePaths: new Set<string>(),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
    } as unknown as ReturnType<typeof useSelectionManager>);

    showToastMock = vi.fn();
    handleDirectorySelectErrorMock = vi.fn();
  });

  it('renders toolbar, sidebar and action buttons', async () => {
    renderWithProviders(<FileExplorerLeftPanel />);

    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
    expect(await screen.findByTestId('sidebar')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /select all/i })).toBeInTheDocument();
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

  it('updates filters when filter button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FileExplorerLeftPanel />);

    await user.click(screen.getByRole('button', { name: 'Apply Filters' }));

    // applyFileFilters internally calls setFilters, so we only verify it's called
    expect(applyFileFiltersMock).toHaveBeenCalledWith(['in'], ['ex'], true);
  });

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
    vi.mocked(useFileExplorer).mockReturnValueOnce({
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

  it('propagates filter changes with different values', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FileExplorerLeftPanel />);

    await user.click(screen.getByRole('button', { name: 'Clear Filters' }));
    // applyFileFilters internally calls setFilters
    expect(applyFileFiltersMock).toHaveBeenCalledWith([], [], false);

    await user.click(screen.getByRole('button', { name: 'Apply Complex' }));
    expect(applyFileFiltersMock).toHaveBeenCalledWith(['foo'], ['bar', 'baz'], false);
  });

  it('displays inline scanning indicator when loading', async () => {
    vi.mocked(useFileExplorer).mockReturnValueOnce({
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
    vi.mocked(useFileExplorer).mockReturnValueOnce({
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
      selectedFilesList: ['file1', 'file2', 'file3'],
      setSelectedFilesFromList: vi.fn(),
      selectedFilePaths: new Set(['file1', 'file2', 'file3']),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
    } as unknown as ReturnType<typeof useSelectionManager>);

    renderWithProviders(<FileExplorerLeftPanel />);

    expect(await screen.findByTestId('selection-count')).toHaveTextContent('3');
    expect(await screen.findByTestId('selection-max')).toHaveTextContent('5');
  });

  it('renders without crashing when selectedFilesList is not an array', async () => {
    vi.mocked(useSelectionManager).mockReturnValueOnce({
      selectedFilesList: undefined as unknown as string[],
      setSelectedFilesFromList: undefined as unknown as (files: readonly string[]) => void,
      selectedFilePaths: new Set(),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
    } as unknown as ReturnType<typeof useSelectionManager>);

    renderWithProviders(<FileExplorerLeftPanel />);

    // Should not crash and should render with empty selection
    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
  });

  it('displays initial loading state correctly', async () => {
    vi.mocked(useFileExplorer).mockReturnValueOnce({
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
    vi.mocked(useFileExplorer).mockReturnValueOnce({
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
      setFilters: vi.fn(),
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
      },
      setMaterializedPaths: vi.fn(),
    };

    const mockStore = Object.assign(
      (selector?: (s: any) => unknown) =>
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

  it('filters the tree correctly with quick filter', async () => {
    const storeState = {
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      setFilters: vi.fn(),
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
      },
      setMaterializedPaths: vi.fn(),
    };

    const mockStore = Object.assign(
      (selector?: (s: any) => unknown) =>
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
      setFilters: vi.fn(),
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
      },
      setMaterializedPaths: vi.fn(),
    };

    const mockStore = Object.assign(
      (selector?: (s: any) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: {
        path: '/new-root',
        name: 'new-root',
        kind: 'directory',
        platform: 'web' as const,
        _internal: {} as FileSystemDirectoryHandle,
      },
    });

    renderWithProviders(<FileExplorerLeftPanel />);

    expect(setCurrentFolderId).toHaveBeenCalledWith('new-root');
  });

  it('handles inline fixture toggling', async () => {
    const setDevInlineFixtureEnabled = vi.fn();
    const loadInlineFixture = vi.fn().mockResolvedValue({ name: 'fixture' });
    const clearInlineFixture = vi.fn().mockResolvedValue(undefined);

    const storeState = {
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      setFilters: vi.fn(),
      currentFolderId: 'root',
      setCurrentFolderId: vi.fn(),
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
      devInlineFixtureEnabled: true,
      setDevInlineFixtureEnabled,
      selectionModel: {
        mode: 'explicit' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
      },
      setMaterializedPaths: vi.fn(),
    };

    const mockStore = Object.assign(
      (selector?: (s: any) => unknown) =>
        typeof selector === 'function' ? selector(storeState) : storeState,
      { getState: () => storeState }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    const { useAdapters } = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(useAdapters).mockReturnValue({
      fileSystemAdapter: {
        canLoadInlineFixture: true,
        loadInlineFixture,
        clearInlineFixture,
        isInlineFixtureActive: () => false,
      },
      storageAdapter: {},
    } as any);

    renderWithProviders(<FileExplorerLeftPanel />);

    await act(async () => {
      await Promise.resolve(); // Wait for effect
    });

    expect(loadInlineFixture).toHaveBeenCalled();
  });
});
