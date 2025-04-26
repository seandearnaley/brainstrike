/*
  Extracted from FileExplorer.test.tsx, 'File Content Loading' suite.
  We replicate the same test setup and mocks for minimal breakage.
  This separation helps reduce complexity in the main FileExplorer.test.tsx file.
*/

import type { FileExplorerState } from '@brainstrike/types'; // Import necessary types
import { act, cleanup, render, waitFor } from '@testing-library/react';
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
vi.mock('@/hooks/use-quick-filter');
vi.mock('@/hooks/use-file-explorer-settings');
vi.mock('@/hooks/use-report-generation');
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...originalModule,
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" onClick={onClick} disabled={disabled} data-testid="mock-button">
        {children}
      </button>
    ),
  };
});

// Mock toast is imported from ui-mocks.ts

// Mock report generation function
const mockGenerateReportWithContent = vi.fn().mockResolvedValue('Mock Report Content');

// Mock implementation for useFileExplorerStore
// Align this mock more closely with FileExplorerState
const mockStore: FileExplorerState = {
  // Data properties (align with FileExplorerData)
  currentFolderId: 'test', // Provide an initial value for tests
  folderStates: {},
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  includeProjectTree: true,
  folderSummaryThreshold: 5,
  maxSelectionCount: 10,
  lastActiveTab: 'files',

  // Action properties (mocked functions)
  setCurrentFolderId: vi.fn((folderId: string | null) => {
    mockStore.currentFolderId = folderId;
  }),
  hydrateFolderState: vi.fn((folderId: string) => {
    // Mock implementation: create or update a folder state
    if (!mockStore.folderStates[folderId]) {
      mockStore.folderStates[folderId] = {
        selectedFilePaths: new Set<string>(),
        expandedDirectoryPaths: new Set<string>(),
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 5,
        maxSelectionCount: 10,
        lastActiveTab: 'files',
        lastAccessed: Date.now(),
      };
    }
    mockStore.folderStates[folderId].lastAccessed = Date.now();
  }),
  setSelectedFiles: vi.fn((files: ReadonlySet<string>) => {
    mockStore.selectedFilePaths = new Set(files);
    // Simulate loading content when selected
    for (const file of files) {
      if (!mockFileContents[file]) {
        mockLoadFileContent(file);
      }
    }
  }),
  addSelectedFile: vi.fn((_folderId: string, path: string) => {
    // Use folderId if needed by implementation, current mock doesn't use it
    mockStore.selectedFilePaths.add(path);
    // Simulate loading content when added
    if (!mockFileContents[path]) {
      mockLoadFileContent(path);
    }
  }),
  removeSelectedFile: vi.fn((_folderId: string, path: string) => {
    // Use folderId if needed
    mockStore.selectedFilePaths.delete(path);
  }),
  toggleSelectedFile: vi.fn((folderId: string, path: string) => {
    if (mockStore.selectedFilePaths.has(path)) {
      mockStore.removeSelectedFile(folderId, path);
    } else {
      mockStore.addSelectedFile(folderId, path);
    }
  }),
  clearSelectedFiles: vi.fn(() => {
    mockStore.selectedFilePaths.clear();
  }),
  setExpandedPaths: vi.fn((paths: ReadonlySet<string>) => {
    mockStore.expandedDirectoryPaths = new Set(paths);
  }),
  toggleDirectoryExpansion: vi.fn((path: string) => {
    const newPaths = new Set(mockStore.expandedDirectoryPaths);
    if (newPaths.has(path)) {
      newPaths.delete(path);
    } else {
      newPaths.add(path);
    }
    mockStore.expandedDirectoryPaths = newPaths;
  }),
  setFilters: vi.fn((include: readonly string[], exclude: readonly string[]) => {
    mockStore.includeFilters = [...include];
    mockStore.excludeFilters = [...exclude];
  }),
  setUseRegex: vi.fn((useRegex: boolean) => {
    mockStore.useRegex = useRegex;
  }),
  setIncludeProjectTree: vi.fn((value: boolean) => {
    mockStore.includeProjectTree = value;
  }),
  setFolderSummaryThreshold: vi.fn((value: number) => {
    mockStore.folderSummaryThreshold = value;
  }),
  setMaxSelectionCount: vi.fn((count: number) => {
    mockStore.maxSelectionCount = count;
  }),
  setLastActiveTab: vi.fn((tab: string) => {
    mockStore.lastActiveTab = tab;
  }),
  // Mock new actions as needed
  expandAllDirectories: vi.fn(),
  collapseAllDirectories: vi.fn(),
};

vi.mock('@/stores/use-file-explorer-store', () => ({
  useFileExplorerStore: vi.fn(() => mockStore), // Ensure the hook returns the updated mock
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
    const folderId = mockStore.currentFolderId;

    if (!file1 || !file2 || !folderId) {
      throw new Error(
        'Test setup error: mockFilteredTree or currentFolderId is missing expected elements.'
      );
    }

    await act(async () => {
      mockStore.addSelectedFile(folderId, file1.path);
      mockStore.addSelectedFile(folderId, file2.path);
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith(file1.path);
      expect(mockLoadFileContent).toHaveBeenCalledWith(file2.path);
    });
  });

  it('loads file content without requiring preview', async () => {
    render(<FileExplorer />);

    const file = mockFilteredTree[0];
    const folderId = mockStore.currentFolderId;

    if (!file || !folderId) {
      throw new Error(
        'Test setup error: mockFilteredTree or currentFolderId is missing expected element.'
      );
    }

    await act(async () => {
      mockStore.addSelectedFile(folderId, file.path);
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith(file.path);
    });
  });

  it('handles multiple file selections and unselections correctly', async () => {
    render(<FileExplorer />);

    const file1 = mockFilteredTree[0];
    const file2 = mockFilteredTree[1];
    const folderId = mockStore.currentFolderId;

    if (!file1 || !file2 || !folderId) {
      throw new Error(
        'Test setup error: mockFilteredTree or currentFolderId is missing expected elements.'
      );
    }

    await act(async () => {
      mockStore.addSelectedFile(folderId, file1.path);
      mockStore.addSelectedFile(folderId, file2.path);
    });

    await waitFor(() => {
      expect(mockLoadFileContent).toHaveBeenCalledWith(file1.path);
      expect(mockLoadFileContent).toHaveBeenCalledWith(file2.path);
    });

    await act(async () => {
      mockStore.removeSelectedFile(folderId, file1.path);
    });

    expect(mockStore.selectedFilePaths.has(file1.path)).toBe(false);
    expect(mockStore.selectedFilePaths.has(file2.path)).toBe(true);
  });
});
