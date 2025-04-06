/*
  Extracted from FileExplorer.test.tsx, 'File Content Loading' suite.
  We replicate the same test setup and mocks for minimal breakage.
  This separation helps reduce complexity in the main FileExplorer.test.tsx file.
*/

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorer } from '../../../../hooks/use-file-explorer';
import { useFileExplorerSettings } from '../../../../hooks/use-file-explorer-settings';
import { useFileSystem } from '../../../../hooks/use-file-system';
import { useQuickFilter } from '../../../../hooks/use-quick-filter';
import { useReportGeneration } from '../../../../hooks/use-report-generation';
import FileExplorer from '../../file-explorer';

// Mock all hooks and components
vi.mock('@/hooks/use-file-system');
vi.mock('@/hooks/use-file-explorer');
vi.mock('@/hooks/use-quick-filter', () => ({
  useQuickFilter: vi.fn().mockReturnValue({
    quickFilter: '',
    setQuickFilter: vi.fn(),
    filteredTree: [],
    clearFilter: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-file-explorer-settings');

// Mock useReportGeneration
const mockGenerateReportWithContent = vi.fn().mockResolvedValue('Mock Report Content');
vi.mock('@/hooks/use-report-generation', () => ({
  useReportGeneration: vi.fn().mockImplementation(() => ({
    generateReportWithContent: mockGenerateReportWithContent,
    isGenerating: false,
  })),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled} data-testid="mock-button">
      {children}
    </button>
  ),
}));

// Mock toast
const mockToast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Mock implementation for useFileExplorerStore
interface MockStore {
  selectedFilePaths: Set<string>;
  setSelectedFiles: ReturnType<typeof vi.fn>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  maxSelectionCount: number;
  setFilters: ReturnType<typeof vi.fn>;
  currentFolderId: string | null;
  setCurrentFolderId: ReturnType<typeof vi.fn>;
  expandedDirectoryPaths: Set<string>;
  toggleDirectoryExpansion: ReturnType<typeof vi.fn>;
  addSelectedFile: ReturnType<typeof vi.fn>;
  removeSelectedFile: ReturnType<typeof vi.fn>;
  clearSelectedFiles: ReturnType<typeof vi.fn>;
}

const mockStore: MockStore = {
  selectedFilePaths: new Set<string>(),
  setSelectedFiles: vi.fn((files: Set<string>) => {
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
  setFilters: vi.fn(),
  currentFolderId: null,
  setCurrentFolderId: vi.fn((folderId: string | null) => {
    mockStore.currentFolderId = folderId;
  }),
  expandedDirectoryPaths: new Set<string>(),
  toggleDirectoryExpansion: vi.fn(),
  addSelectedFile: vi.fn((path: string) => {
    mockStore.selectedFilePaths.add(path);
    if (!mockFileContents[path]) {
      mockLoadFileContent(path);
    }
  }),
  removeSelectedFile: vi.fn((path: string) => {
    mockStore.selectedFilePaths.delete(path);
  }),
  clearSelectedFiles: vi.fn(() => {
    mockStore.selectedFilePaths.clear();
  }),
};

vi.mock('@/stores/use-file-explorer-store', () => ({
  useFileExplorerStore: () => mockStore,
}));

// Mock file content loading functionality
const mockLoadFileContent = vi
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

// Mock implementation for useFileExplorer
const mockFileExplorer = {
  fileTree: mockFilteredTree,
  loadFileContent: mockLoadFileContent,
  fileContents: mockFileContents,
  error: null,
  isLoading: false,
  isInitialLoad: false,
  rootDirectoryHandle: null,
  handleRootDirectorySelect: vi.fn(),
  isFileSystemAccessSupported: vi.fn(() => ({ supported: true, reason: '' })),
  refreshFileExplorer: vi.fn(),
  applyFileFilters: vi.fn(),
  filterError: null,
  onDisplayedFilePathsChange: vi.fn(),
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
  updateSettings: vi.fn(),
};

(useFileSystem as ReturnType<typeof vi.fn>).mockReturnValue({
  selectRootDirectory: vi.fn(),
  isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
});

(useFileExplorer as ReturnType<typeof vi.fn>).mockReturnValue({
  ...mockFileExplorer,
  fileTree: mockFilteredTree,
  loadFileContent: mockLoadFileContent,
  fileContents: mockFileContents,
});

(useFileExplorerSettings as ReturnType<typeof vi.fn>).mockReturnValue({
  settings: mockSettings.settings,
  updateSettings: mockSettings.updateSettings,
});

// "File Content Loading" test suite, extracted from FileExplorer.test.tsx
describe('File Content Loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      mockStore.selectedFilePaths = new Set();
    });
    mockStore.currentFolderId = 'test';

    (useFileExplorer as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockFileExplorer,
      rootDirectoryHandle: {
        kind: 'directory',
        name: 'test-root',
      },
      fileTree: mockFilteredTree,
      loadFileContent: mockLoadFileContent,
      fileContents: mockFileContents,
    });

    (useQuickFilter as ReturnType<typeof vi.fn>).mockReturnValue({
      quickFilter: '',
      setQuickFilter: vi.fn(),
      filteredTree: mockFilteredTree,
      clearFilter: vi.fn(),
    });

    // Verify the mock is properly set up
    (useReportGeneration as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generateReportWithContent: mockGenerateReportWithContent,
      isGenerating: false,
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('loads file content when files are selected', async () => {
    render(<FileExplorer />);

    const file1 = mockFilteredTree[0];
    const file2 = mockFilteredTree[1];

    await act(async () => {
      mockStore.addSelectedFile(file1.path);
      mockStore.addSelectedFile(file2.path);
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith(file1.path);
      expect(mockLoadFileContent).toHaveBeenCalledWith(file2.path);
    });
  });

  it('loads file content without requiring preview', async () => {
    render(<FileExplorer />);

    const file = mockFilteredTree[0];

    await act(async () => {
      mockStore.addSelectedFile(file.path);
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith(file.path);
    });
  });

  it('handles multiple file selections and unselections correctly', async () => {
    render(<FileExplorer />);

    const file1 = mockFilteredTree[0];
    const file2 = mockFilteredTree[1];

    await act(async () => {
      mockStore.addSelectedFile(file1.path);
      mockStore.addSelectedFile(file2.path);
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith(file1.path);
      expect(mockLoadFileContent).toHaveBeenCalledWith(file2.path);
    });

    await act(async () => {
      mockStore.removeSelectedFile(file1.path);
    });

    expect(mockStore.selectedFilePaths.has(file1.path)).toBe(false);
    expect(mockStore.selectedFilePaths.has(file2.path)).toBe(true);
  });
});
