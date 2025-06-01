import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Mock UI components that are lazy loaded or used within the panel
vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();
  return {
    ...actual,
    FileExplorerToolbar: () => <div data-testid="toolbar">Toolbar</div>,
    FileExplorerSidebar: () => <div data-testid="sidebar">Sidebar</div>,
    FileExplorerErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LoadingOverlay: () => null,
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
vi.mock('../unified-file-explorer-context', () => ({
  useUnifiedFileExplorer: vi.fn(),
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
      showToast: vi.fn(),
      handleRefreshError: vi.fn(),
      handleBrowserCompatibilityError: vi.fn(),
      handleDirectorySelectError: vi.fn(),
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

import { FileExplorerLeftPanel } from '../file-explorer-left-panel';
import { FileExplorerTestWrapper } from './test-helpers';

import { useQuickFilter } from '@brainstrike/hooks';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useUnifiedFileExplorer } from '../unified-file-explorer-context';
import { useSelectionManager } from '../use-selection-manager-context';

describe('FileExplorerLeftPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const storeState = {
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      setFilters: vi.fn(),
      currentFolderId: 'root',
      setCurrentFolderId: vi.fn(),
      maxSelectionCount: 5,
      includeProjectTree: true,
      folderSummaryThreshold: 5,
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
    } as const;

    const mockStore = Object.assign(() => storeState, { getState: () => storeState });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    vi.mocked(useUnifiedFileExplorer).mockReturnValue({
      fileTree: [],
      handleRootDirectorySelect: vi.fn(),
      isLoading: false,
      error: null,
      fileContents: {},
      loadingFiles: new Set<string>(),
      applyFileFilters: vi.fn(),
      filterError: null,
      rootDirectoryHandle: { name: 'root', kind: 'directory' } as FileSystemDirectoryHandle,
      isFileSystemAccessSupported: vi.fn(() => ({ supported: true, reason: '' })),
      refreshFileExplorer: vi.fn(),
      isInitialLoad: false,
      loadingProgress: null,
      cancellable: false,
      cancelOperation: vi.fn(),
      isCancelling: false,
    } as any);

    vi.mocked(useSelectionManager).mockReturnValue({
      selectedFilePaths: new Set<string>(),
      handleSelectionChange: vi.fn(),
    } as any);

    vi.mocked(useQuickFilter).mockReturnValue({
      quickFilter: '',
      setQuickFilter: vi.fn(),
      clearFilter: vi.fn(),
      filteredTree: [],
    });
  });

  it('renders toolbar, sidebar and action buttons', async () => {
    render(<FileExplorerLeftPanel />, { wrapper: FileExplorerTestWrapper });

    expect(await screen.findByTestId('toolbar')).toBeInTheDocument();
    expect(await screen.findByTestId('sidebar')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /select all/i })).toBeInTheDocument();
  });
});
