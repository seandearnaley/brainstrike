import { DEFAULT_EXCLUDE_FILTERS, DEFAULT_INCLUDE_FILTERS } from '@/constants/file-explorer';
import * as useFileExplorerStoreModule from '@/stores/use-file-explorer-store';
import { createDirectoryNode, createFileNode } from '@/test/factories/file-node';
import { act, renderHook } from '@testing-library/react';
import { useFileContentLoading } from '../use-file-content-loading';
import { useFileExplorer } from '../use-file-explorer';
import { useFileFilters } from '../use-file-filters';
import { useFileSystem } from '../use-file-system';
import { useFileTree } from '../use-file-tree';

// Mock dependencies
jest.mock('../use-file-system');
jest.mock('../use-file-tree');
jest.mock('../use-file-filters');
jest.mock('../use-file-content-loading');

// Mock the store module
jest.mock('@/stores/use-file-explorer-store', () => ({
  ...jest.requireActual('@/stores/use-file-explorer-store'),
  useFileExplorerStore: jest.fn(() => ({
    selectedFilePaths: new Set<string>(),
    includeFilters: DEFAULT_INCLUDE_FILTERS,
    excludeFilters: DEFAULT_EXCLUDE_FILTERS,
    useRegex: false,
    settings: {
      maxSelectionCount: 10,
      showProjectTree: true,
      folderSummaryThreshold: 3,
    },
    setMaxSelectionCount: jest.fn(),
    setShowProjectTree: jest.fn(),
    setFolderSummaryThreshold: jest.fn(),
    addSelectedFile: jest.fn(),
    removeSelectedFile: jest.fn(),
    clearSelectedFiles: jest.fn(),
    setSelectedFiles: jest.fn(),
    expandDirectory: jest.fn(),
    collapseDirectory: jest.fn(),
    setExpandedPaths: jest.fn(),
    setIncludeFilters: jest.fn(),
    setExcludeFilters: jest.fn(),
    setUseRegex: jest.fn(),
  })),
}));

describe('useFileExplorer', () => {
  // Mock implementation setup
  const mockSelectRoot = jest.fn();
  const mockApplyFileFilters = jest.fn();
  const mockHandleFileContentLoading = jest.fn();

  // Enhanced mock data using factories
  const mockFileNode = createFileNode({
    name: 'test.txt',
    path: '/test.txt',
  });

  const mockDirectoryNode = createDirectoryNode({
    name: 'testDir',
    path: '/testDir',
    children: [mockFileNode],
  });

  const defaultProps = {
    onDisplayedFilePathsChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up default mock return values
    mockApplyFileFilters.mockReturnValue([]);

    (useFileSystem as jest.Mock).mockReturnValue({
      rootDirectoryHandle: null,
      selectRootDirectory: mockSelectRoot,
      isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
      isAccessLoading: false,
    });

    (useFileTree as jest.Mock).mockReturnValue({
      fileTree: [mockFileNode],
      isLoading: false,
      error: null,
      refreshTree: jest.fn(),
      loadingProgress: null,
    });

    (useFileFilters as jest.Mock).mockReturnValue({
      applyFileFilters: mockApplyFileFilters,
      filterError: null,
    });

    (useFileContentLoading as jest.Mock).mockReturnValue({
      fileContents: {},
      isLoading: false,
      error: null,
      handleFileContentLoading: mockHandleFileContentLoading,
    });
  });

  const renderUseFileExplorerHook = (props = {}) => {
    return renderHook(() => useFileExplorer({ ...defaultProps, ...props }));
  };

  describe('Initialization', () => {
    beforeEach(() => {
      mockApplyFileFilters.mockReturnValue([]);
      (useFileTree as jest.Mock).mockReturnValue({
        fileTree: [],
        isLoading: false,
        error: null,
        refreshTree: jest.fn(),
        loadingProgress: null,
      });
    });

    it('should initialize with empty file tree', () => {
      const { result } = renderUseFileExplorerHook();

      expect(result.current.fileTree).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBeFalsy();
    });

    it('should apply default filters when no filters are provided', () => {
      // Override with non-empty tree for this test
      const mockTree = [mockFileNode];
      const mockFilteredTree = [mockFileNode];
      mockApplyFileFilters.mockReturnValue(mockFilteredTree);

      (useFileTree as jest.Mock).mockReturnValue({
        fileTree: mockTree,
        isLoading: false,
        error: null,
        refreshTree: jest.fn(),
        loadingProgress: null,
      });

      const { result } = renderUseFileExplorerHook();

      expect(mockApplyFileFilters).toHaveBeenCalledWith(
        mockTree,
        DEFAULT_INCLUDE_FILTERS,
        DEFAULT_EXCLUDE_FILTERS,
        false
      );
      expect(result.current.fileTree).toEqual(mockFilteredTree);
    });
  });

  describe('Directory Operations', () => {
    it('should handle root directory selection', async () => {
      const mockHandle = { kind: 'directory' };
      mockSelectRoot.mockResolvedValue(mockHandle);
      const mockFilteredTree = [mockFileNode];
      mockApplyFileFilters.mockReturnValue(mockFilteredTree);

      const { result } = renderUseFileExplorerHook();

      await act(async () => {
        const handle = await result.current.handleRootDirectorySelect();
        expect(handle).toBe(mockHandle);
      });
    });
  });

  describe('File Content Loading', () => {
    beforeEach(() => {
      const mockFilteredTree = [mockFileNode];
      mockApplyFileFilters.mockReturnValue(mockFilteredTree);

      (useFileTree as jest.Mock).mockReturnValue({
        fileTree: [mockFileNode],
        isLoading: false,
        error: null,
        refreshTree: jest.fn(),
        loadingProgress: null,
      });
    });

    it('should load file content', async () => {
      const mockContent = 'test content';
      mockHandleFileContentLoading.mockResolvedValue(mockContent);

      (useFileContentLoading as jest.Mock).mockReturnValue({
        fileContents: { '/test.txt': mockContent },
        isLoading: false,
        error: null,
        handleFileContentLoading: mockHandleFileContentLoading,
      });

      const { result } = renderUseFileExplorerHook();

      await act(async () => {
        await result.current.loadFileContent('/test.txt');
      });

      expect(mockHandleFileContentLoading).toHaveBeenCalledWith(['/test.txt']);
      expect(result.current.fileContents['/test.txt']).toBe(mockContent);
    });
  });

  describe('Filter Operations', () => {
    it('should apply filters correctly', () => {
      const testTree = [mockFileNode, mockDirectoryNode];
      mockApplyFileFilters.mockReturnValue(testTree);

      const { result } = renderUseFileExplorerHook();

      const filteredTree = result.current.applyFileFilters(['*.txt'], ['.git'], true);

      expect(filteredTree).toEqual(testTree);
      expect(mockApplyFileFilters).toHaveBeenCalledWith(
        expect.any(Array),
        ['*.txt'],
        ['.git'],
        true
      );
    });
  });

  describe('Refresh Operations', () => {
    it('should refresh file tree', async () => {
      const mockRefreshTree = jest.fn();
      const mockRootHandle = {} as FileSystemDirectoryHandle;
      const mockFilteredTree = [mockFileNode];
      mockApplyFileFilters.mockReturnValue(mockFilteredTree);

      (useFileSystem as jest.Mock).mockReturnValue({
        rootDirectoryHandle: mockRootHandle,
        selectRootDirectory: mockSelectRoot,
        isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
        isAccessLoading: false,
      });

      (useFileTree as jest.Mock).mockReturnValue({
        fileTree: [],
        isLoading: false,
        error: null,
        refreshTree: mockRefreshTree,
        loadingProgress: null,
      });

      const { result } = renderUseFileExplorerHook();

      await act(async () => {
        await result.current.refreshFileExplorer();
      });

      expect(mockRefreshTree).toHaveBeenCalled();
    });
  });
});
