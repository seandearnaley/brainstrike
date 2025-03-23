import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FileExplorer from '../../file-explorer';

jest.mock('@/hooks/use-file-system');
jest.mock('@/hooks/use-file-explorer');
jest.mock('@/hooks/use-quick-filter');
jest.mock('@/hooks/use-file-explorer-settings');
jest.mock('@/hooks/use-report-generation');
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

// Mock ErrorBoundary component
jest.mock('@/components/custom/error-boundary', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-error-boundary">{children}</div>
  ),
}));

// Mock FileExplorerMainPanel to avoid Object.entries(undefined) error
jest.mock('@/components/custom/file-explorer-main-panel', () => ({
  FileExplorerMainPanel: () => <div data-testid="mock-main-panel">Main Panel</div>,
}));

// Mock store for useFileExplorerStore
interface MockStore {
  selectedFilePaths: Set<string>;
  setSelectedFiles: jest.Mock;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  maxSelectionCount: number;
  setFilters: jest.Mock;
  currentFolderId: string | null;
  setCurrentFolderId: jest.Mock;
  expandedDirectoryPaths: Set<string>;
  toggleDirectoryExpansion: jest.Mock;
  addSelectedFile: jest.Mock;
  removeSelectedFile: jest.Mock;
  clearSelectedFiles: jest.Mock;
}

const mockStore: MockStore = {
  selectedFilePaths: new Set<string>(),
  setSelectedFiles: jest.fn(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  maxSelectionCount: 10,
  setFilters: jest.fn(),
  currentFolderId: null,
  setCurrentFolderId: jest.fn(),
  expandedDirectoryPaths: new Set<string>(),
  toggleDirectoryExpansion: jest.fn(),
  addSelectedFile: jest.fn(),
  removeSelectedFile: jest.fn(),
  clearSelectedFiles: jest.fn(),
};

// Set up mocks
jest.mock('@/stores/use-file-explorer-store', () => ({
  useFileExplorerStore: jest.fn(() => mockStore),
}));

// Mock implementations
jest.mocked(require('@/hooks/use-file-system').useFileSystem).mockReturnValue({
  selectRootDirectory: jest.fn(),
  isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
});

jest.mocked(require('@/hooks/use-file-explorer').useFileExplorer).mockReturnValue({
  fileTree: [],
  loadFileContent: jest.fn(),
  fileContents: {},
  error: null,
  isLoading: false,
  isInitialLoad: false,
  rootDirectoryHandle: null,
  handleRootDirectorySelect: jest.fn(),
  isFileSystemAccessSupported: jest.fn(() => ({ supported: true, reason: '' })),
  refreshFileExplorer: jest.fn(),
  applyFileFilters: jest.fn(),
  filterError: null,
  onDisplayedFilePathsChange: jest.fn(),
});

jest.mocked(require('@/hooks/use-quick-filter').useQuickFilter).mockReturnValue({
  quickFilter: '',
  setQuickFilter: jest.fn(),
  filteredTree: [],
  clearFilter: jest.fn(),
});

jest.mocked(require('@/hooks/use-file-explorer-settings').useFileExplorerSettings).mockReturnValue({
  settings: {
    maxSelectionCount: 10,
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 3,
  },
  updateSettings: jest.fn(),
});

jest.mocked(require('@/hooks/use-report-generation').useReportGeneration).mockReturnValue({
  generateReportWithContent: jest.fn().mockResolvedValue('Mock Report Content'),
  isGenerating: false,
});

describe('Empty States', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should show initial empty state', async () => {
    (require('@/hooks/use-file-explorer').useFileExplorer as jest.Mock).mockReturnValue({
      ...require('@/hooks/use-file-explorer').useFileExplorer,
      fileTree: [],
      rootDirectoryHandle: null,
    });

    await act(async () => {
      render(<FileExplorer />);
    });

    await waitFor(() => {
      expect(screen.getByText('No files to display')).toBeInTheDocument();
    });
  });

  it('should show no matches message when filter returns empty results', async () => {
    // Force a valid directory handle with a name
    (require('@/hooks/use-file-explorer').useFileExplorer as jest.Mock).mockReturnValue({
      ...require('@/hooks/use-file-explorer').useFileExplorer,
      rootDirectoryHandle: {
        kind: 'directory',
        name: 'TestRoot',
      } as unknown as FileSystemDirectoryHandle,
      // Provide a non-empty fileTree so it's not considered "No files to display"
      fileTree: [
        {
          path: 'dummy.ts',
          type: 'file',
          handle: {},
          name: 'dummy.ts',
          isVisible: true,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'TestRoot',
        },
      ],
    });

    // Return an empty filteredTree so we see 'No matching files found'
    (require('@/hooks/use-quick-filter').useQuickFilter as jest.Mock).mockReturnValue({
      ...require('@/hooks/use-quick-filter').useQuickFilter,
      filteredTree: [],
    });

    await act(async () => {
      render(<FileExplorer />);
    });

    await waitFor(() => {
      expect(screen.getByText('No matching files found')).toBeInTheDocument();
    });
  });
});
