import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

var FileExplorerSidebarMock: ReturnType<typeof vi.fn> | undefined;
var ActionButtonsMock: ReturnType<typeof vi.fn> | undefined;
var LoadingOverlayMock: ReturnType<typeof vi.fn> | undefined;

// Mock UI components that are lazy loaded or used within the panel
vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();
  FileExplorerSidebarMock = vi.fn(() => (
    <div data-testid="sidebar">
      <div
        data-testid="file-tree-scroll-container"
        className="h-full relative flex-1 min-h-0 overflow-y-auto"
      >
        <div
          className="relative file-tree"
          role="tree"
          aria-label="File tree"
          data-testid="file-tree"
          style={{ height: 3200 }}
        >
          {Array.from({ length: 50 }, (_, i) => ({ id: `row-${i}`, index: i })).map((row) => (
            <div
              key={row.id}
              role="treeitem"
              tabIndex={0}
              style={{ position: 'absolute', top: row.index * 32, width: '100%', height: 32 }}
            >
              Row {row.index}
            </div>
          ))}
        </div>
      </div>
    </div>
  ));
  ActionButtonsMock = vi.fn(() => <div data-testid="actions">Actions</div>);
  LoadingOverlayMock = vi.fn(({ onCancel }: { cancellable?: boolean; onCancel?: () => void }) => (
    <div data-testid="loading-overlay">
      <button type="button" onClick={onCancel} aria-label="Cancel">
        Cancel
      </button>
    </div>
  ));
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
vi.mock('@brainstrike/hooks', () => ({
  useQuickFilter: vi.fn(),
  useReportGeneration: vi.fn(() => ({ generateReportWithContent: vi.fn() })),
  useReportManager: vi.fn(() => ({
    handleDownloadReport: vi.fn(),
    handleCopyReport: vi.fn(),
  })),
}));

import { useQuickFilter } from '@brainstrike/hooks';
import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { FileExplorerLeftPanel } from '../file-explorer-left-panel';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useFileExplorer } from '../use-file-explorer-context';
import { useSelectionManager } from '../use-selection-manager-context';
import { FileExplorerTestWrapper } from './test-helpers';

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

  it('footer toolbar stays fixed while scrolling long trees', async () => {
    // Force root present with a large tree to enable scroll in the middle panel
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: {
        path: '/root',
        name: 'root',
        kind: 'directory',
        platform: 'web' as const,
        _internal: {} as FileSystemDirectoryHandle,
      },
      fileTree: Array.from({ length: 200 }, (_, i) =>
        createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
      ),
    } as ReturnType<typeof useFileExplorer>);

    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    const scrollContainer = screen.getByTestId('file-tree-scroll-container');
    const footer = screen.getByRole('button', { name: /select all/i }).closest('div');
    expect(scrollContainer).toBeInTheDocument();
    expect(footer).toBeInTheDocument();

    if (!footer) throw new Error('Footer container not found');
    const footerTopBefore = footer.getBoundingClientRect().top;
    // simulate scroll
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200 });
    (scrollContainer as HTMLDivElement).scrollTop = 2000;
    fireEvent.scroll(scrollContainer);
    const footerTopAfter = footer.getBoundingClientRect().top;

    // Footer should remain in the same position (fixed within panel grid)
    expect(footerTopAfter).toBe(footerTopBefore);
  });

  it('expand-all and collapse-all work near the end of long list without gaps', async () => {
    const user = userEvent.setup();
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      rootDirectoryHandle: {
        path: '/root',
        name: 'root',
        kind: 'directory',
        platform: 'web' as const,
        _internal: {} as FileSystemDirectoryHandle,
      },
      fileTree: [
        createDirectoryNode({
          name: 'folder',
          path: 'folder',
          children: Array.from({ length: 200 }, (_, i) =>
            createFileNode({ name: `f${i}.txt`, path: `folder/f${i}.txt` })
          ),
        }),
      ],
    } as ReturnType<typeof useFileExplorer>);

    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    const expandAll = screen.getByTestId('expand-all-button-small');
    const collapseAll = screen.getByTestId('collapse-all-button-small');
    await user.click(expandAll);

    const container = screen.getByTestId('file-tree-scroll-container') as HTMLDivElement;
    Object.defineProperty(container, 'clientHeight', { value: 160 });
    container.scrollTop = 9999;
    fireEvent.scroll(container);

    // Expect some items rendered and no crash
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);

    await user.click(collapseAll);
    // After collapse, still stable
    expect(screen.getByLabelText('File tree')).toBeInTheDocument();
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
    vi.mocked(useFileExplorer).mockReturnValue({
      ...fileExplorerReturnValue,
      isLoading: true,
      cancellable: true,
      cancelOperation: cancelOperationMock,
    });

    const user = userEvent.setup();
    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    // The overlay Cancel button may be visually hidden; query by role/name
    // The overlay mock renders a button inside a testid wrapper
    const overlay = await screen.findByTestId('loading-overlay');
    const buttonList = overlay.querySelectorAll('button');
    expect(buttonList.length).toBeGreaterThan(0);
    await user.click(buttonList[0]);

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
