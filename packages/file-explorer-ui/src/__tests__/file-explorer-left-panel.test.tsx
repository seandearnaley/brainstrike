import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// biome-ignore lint/style/noVar: var required for hoisted mock assignment
var FileExplorerSidebarMock: ReturnType<typeof vi.fn> | undefined;
// biome-ignore lint/style/noVar: var required for hoisted mock assignment
var ActionButtonsMock: ReturnType<typeof vi.fn> | undefined;
// biome-ignore lint/style/noVar: var required for hoisted mock assignment
var LoadingOverlayMock: ReturnType<typeof vi.fn> | undefined;

// Mock UI components that are lazy loaded or used within the panel
vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();
  FileExplorerSidebarMock = vi.fn(() => <div data-testid="sidebar">Sidebar</div>);
  ActionButtonsMock = vi.fn(() => <div data-testid="actions">Actions</div>);
  LoadingOverlayMock = vi.fn(
    ({ cancellable, onCancel }: { cancellable?: boolean; onCancel?: () => void }) => (
      <div data-testid="loading-overlay">
        {cancellable && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    )
  );
  return {
    ...actual,
    FileExplorerToolbar: ({
      onDirectorySelect,
      onFilterChange,
    }: {
      onDirectorySelect: () => void;
      onFilterChange: (include: string[], exclude: string[], useRegex: boolean) => void;
    }) => (
      <div data-testid="toolbar">
        Toolbar
        <button type="button" onClick={onDirectorySelect}>
          Select Directory
        </button>
        <button type="button" onClick={() => onFilterChange(['in'], ['ex'], true)}>
          Apply Filters
        </button>
        <button type="button" onClick={() => onFilterChange([], [], false)}>
          Clear Filters
        </button>
        <button type="button" onClick={() => onFilterChange(['foo'], ['bar', 'baz'], false)}>
          Apply Complex
        </button>
      </div>
    ),
    FileExplorerSidebar: FileExplorerSidebarMock,
    FileExplorerErrorBoundary: actual.FileExplorerErrorBoundary,
    LoadingOverlay: LoadingOverlayMock,
    ActionButtons: ActionButtonsMock,
  };
});

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
vi.mock('@brainstrike/hooks/use-quick-filter', () => ({
  useQuickFilter: vi.fn(),
}));
vi.mock('@brainstrike/hooks/use-report-generation', () => ({
  useReportGeneration: vi.fn(() => ({ generateReportWithContent: vi.fn() })),
}));
vi.mock('@brainstrike/hooks/use-report-manager', () => ({
  useReportManager: vi.fn(() => ({
    handleDownloadReport: vi.fn(),
    handleCopyReport: vi.fn(),
  })),
}));

import { FileExplorerLeftPanel } from '../file-explorer-left-panel';
import { FileExplorerTestWrapper } from './test-helpers';

import { useQuickFilter } from '@brainstrike/hooks/use-quick-filter';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useFileExplorer } from '../use-file-explorer-context';
import { useSelectionManager } from '../use-selection-manager-context';

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
      folderSummaryThreshold: 5,
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
    } as const;

    const mockStore = Object.assign(() => storeState, { getState: () => storeState });
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
      loadFileContent: vi.fn(),
      clearFileContents: vi.fn(),
    } as ReturnType<typeof useFileExplorer>;
    vi.mocked(useFileExplorer).mockReturnValue(fileExplorerReturnValue);

    vi.mocked(useSelectionManager).mockReturnValue({
      selectedFilePaths: new Set<string>(),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
    });

    vi.mocked(useQuickFilter).mockReturnValue({
      quickFilter: '',
      setQuickFilter: vi.fn(),
      clearFilter: vi.fn(),
      filteredTree: [],
    });

    showToastMock = vi.fn();
    handleDirectorySelectErrorMock = vi.fn();
  });

  it('renders toolbar, sidebar and action buttons', async () => {
    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
    expect(await screen.findByTestId('sidebar')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /select all/i })).toBeInTheDocument();
  });

  it('triggers refresh and shows toast when refresh button is clicked', async () => {
    const user = userEvent.setup();
    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    // Click the refresh button which is now rendered by FileExplorerLeftPanel itself
    await user.click(screen.getByTestId('refresh-button-small'));

    expect(refreshFileExplorerMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalled();
  });

  it('handles directory selection errors', async () => {
    const user = userEvent.setup();
    const error = new Error('fail');
    handleRootDirectorySelectMock.mockRejectedValueOnce(error);
    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Select Directory' }));

    expect(handleDirectorySelectErrorMock).toHaveBeenCalledWith(error);
  });

  it('updates filters when filter button is clicked', async () => {
    const user = userEvent.setup();
    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Apply Filters' }));

    expect(setFiltersMock).toHaveBeenCalledWith(['in'], ['ex']);
    expect(applyFileFiltersMock).toHaveBeenCalledWith(['in'], ['ex'], true);
  });

  it('displays error boundary when sidebar throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    FileExplorerSidebarMock?.mockImplementation(() => {
      throw new Error('boom');
    });

    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    expect(await screen.findByText('Error')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();

    FileExplorerSidebarMock?.mockImplementation(() => <div data-testid="sidebar">Sidebar</div>);
  });

  it('cancels loading and shows toast via overlay', async () => {
    const cancelOperationMock = vi.fn();
    vi.mocked(useFileExplorer).mockReturnValueOnce({
      ...fileExplorerReturnValue,
      isLoading: true,
      cancellable: true,
      cancelOperation: cancelOperationMock,
    });

    const user = userEvent.setup();
    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    await user.click(screen.getByText('Cancel'));

    expect(cancelOperationMock).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith({
      title: 'Operation Cancelled',
      description: 'The file loading operation has been cancelled.',
      variant: 'default',
    });
  });

  it('propagates filter changes with different values', async () => {
    const user = userEvent.setup();
    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Clear Filters' }));
    expect(setFiltersMock).toHaveBeenCalledWith([], []);
    expect(applyFileFiltersMock).toHaveBeenCalledWith([], [], false);

    await user.click(screen.getByRole('button', { name: 'Apply Complex' }));
    expect(setFiltersMock).toHaveBeenCalledWith(['foo'], ['bar', 'baz']);
    expect(applyFileFiltersMock).toHaveBeenCalledWith(['foo'], ['bar', 'baz'], false);
  });
});
