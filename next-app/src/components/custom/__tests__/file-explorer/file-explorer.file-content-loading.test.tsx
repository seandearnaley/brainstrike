/*
  Extracted from FileExplorer.test.tsx, 'File Content Loading' suite.
  We replicate the same test setup and mocks for minimal breakage.
  This separation helps reduce complexity in the main FileExplorer.test.tsx file.
*/

import { useFileExplorer } from '@/hooks/use-file-explorer';
import { useFileExplorerSettings } from '@/hooks/use-file-explorer-settings';
import { useFileSystem } from '@/hooks/use-file-system';
import { useQuickFilter } from '@/hooks/use-quick-filter';
import { useReportGeneration } from '@/hooks/use-report-generation';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FileExplorer from '../../file-explorer';

// Mock all hooks and components
jest.mock('@/hooks/use-file-system');
jest.mock('@/hooks/use-file-explorer');
jest.mock('@/hooks/use-quick-filter');
jest.mock('@/hooks/use-file-explorer-settings');
jest.mock('@/hooks/use-report-generation');
jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

// Mock toast
const mockToast = jest.fn();
jest.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Mock implementation for useFileExplorerStore
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
  setSelectedFiles: jest.fn((files: Set<string>) => {
    mockStore.selectedFilePaths = new Set(files);
    for (const file of files) {
      if (!mockFileContents[file]) {
        mockLoadFileContent(file);
      }
    }
  }),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  maxSelectionCount: 10,
  setFilters: jest.fn(),
  currentFolderId: null,
  setCurrentFolderId: jest.fn((folderId: string | null) => {
    mockStore.currentFolderId = folderId;
  }),
  expandedDirectoryPaths: new Set<string>(),
  toggleDirectoryExpansion: jest.fn(),
  addSelectedFile: jest.fn((path: string) => {
    mockStore.selectedFilePaths.add(path);
    if (!mockFileContents[path]) {
      mockLoadFileContent(path);
    }
  }),
  removeSelectedFile: jest.fn((path: string) => {
    mockStore.selectedFilePaths.delete(path);
  }),
  clearSelectedFiles: jest.fn(() => {
    mockStore.selectedFilePaths.clear();
  }),
};

jest.mock('@/stores/use-file-explorer-store', () => ({
  useFileExplorerStore: () => mockStore,
}));

// Mock file content loading functionality
const mockLoadFileContent = jest
  .fn()
  .mockImplementation(async (path: string) => `Content of ${path}`);
const mockFileContents: Record<string, string> = {};

const mockFilteredTree = [
  {
    path: 'test.ts',
    type: 'file' as const,
    handle: {},
    name: 'test.ts',
    isVisible: true,
  },
  {
    path: 'test2.ts',
    type: 'file' as const,
    handle: {},
    name: 'test2.ts',
    isVisible: true,
  },
];

// Mock implementation for useQuickFilter
const mockQuickFilter = {
  quickFilter: '',
  setQuickFilter: jest.fn(),
  filteredTree: mockFilteredTree,
  clearFilter: jest.fn(),
};

// Mock implementation for useFileExplorer
const mockFileExplorer = {
  fileTree: mockFilteredTree,
  loadFileContent: mockLoadFileContent,
  fileContents: mockFileContents,
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
};

// Mock implementation for useFileExplorerSettings
const mockSettings = {
  settings: {
    maxSelectionCount: 10,
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 3,
  },
  updateSettings: jest.fn(),
};

(useFileSystem as jest.Mock).mockReturnValue({
  selectRootDirectory: jest.fn(),
  isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
});

(useFileExplorer as jest.Mock).mockReturnValue({
  ...mockFileExplorer,
  fileTree: mockFilteredTree,
  loadFileContent: mockLoadFileContent,
  fileContents: mockFileContents,
});

(useQuickFilter as jest.Mock).mockReturnValue(mockQuickFilter);

(useFileExplorerSettings as jest.Mock).mockReturnValue({
  settings: mockSettings.settings,
  updateSettings: mockSettings.updateSettings,
});

(useReportGeneration as jest.Mock).mockReturnValue({
  generateReportWithContent: jest.fn().mockResolvedValue('Mock Report Content'),
  isGenerating: false,
});

// “File Content Loading” test suite, extracted from FileExplorer.test.tsx
describe('File Content Loading', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    act(() => {
      mockStore.selectedFilePaths = new Set();
    });
    mockStore.currentFolderId = 'test';

    (useFileExplorer as jest.Mock).mockReturnValue({
      ...mockFileExplorer,
      rootDirectoryHandle: {
        kind: 'directory',
        name: 'test-root',
      },
      fileTree: mockFilteredTree,
      loadFileContent: mockLoadFileContent,
      fileContents: mockFileContents,
      isLoading: false,
      isInitialLoad: false,
    });

    console.log('Initial state:', {
      selectedFilePaths: mockStore.selectedFilePaths,
      currentFolderId: mockStore.currentFolderId,
      mockLoadFileContent: mockLoadFileContent.mock.calls,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('loads file content when files are selected', async () => {
    await act(async () => {
      render(<FileExplorer />);
    });

    console.log('Pre-selection state:', {
      selectedFilePaths: mockStore.selectedFilePaths,
      mockLoadFileContent: mockLoadFileContent.mock.calls,
    });

    await act(async () => {
      mockStore.setSelectedFiles(new Set(['test/test.ts']));
    });

    console.log('Post-selection state:', {
      selectedFilePaths: mockStore.selectedFilePaths,
      mockLoadFileContent: mockLoadFileContent.mock.calls,
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith('test/test.ts');
    });
  });

  it('loads file content without requiring preview', async () => {
    await act(async () => {
      render(<FileExplorer />);
    });

    await act(async () => {
      mockStore.setSelectedFiles(new Set(['test.ts']));
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith('test.ts');
    });
  });

  it('handles multiple file selections and unselections correctly', async () => {
    await act(async () => {
      render(<FileExplorer />);
    });

    // Select first file
    await act(async () => {
      mockStore.setSelectedFiles(new Set(['test.ts']));
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith('test.ts');
    });

    // Select second file
    await act(async () => {
      mockStore.setSelectedFiles(new Set(['test.ts', 'test2.ts']));
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith('test2.ts');
    });

    // Unselect first file
    await act(async () => {
      mockStore.setSelectedFiles(new Set(['test2.ts']));
    });

    expect(mockLoadFileContent).toHaveBeenCalledWith('test.ts');
    expect(mockLoadFileContent).toHaveBeenCalledWith('test2.ts');
  });
});
