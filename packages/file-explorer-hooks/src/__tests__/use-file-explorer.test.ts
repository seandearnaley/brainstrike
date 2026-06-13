import { useFileExplorerStore } from '@brainstrike/file-explorer';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/test-utils';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileContentLoading } from '../use-file-content-loading';
import { useFileExplorer } from '../use-file-explorer';
import { useFileSystem } from '../use-file-system';
import { useFileTree } from '../use-file-tree';

vi.mock('@brainstrike/file-explorer', () => ({ useFileExplorerStore: vi.fn() }));
vi.mock('../use-file-system', () => ({ useFileSystem: vi.fn() }));
vi.mock('../use-file-tree', () => ({ useFileTree: vi.fn() }));
vi.mock('../use-file-content-loading', () => ({ useFileContentLoading: vi.fn() }));

// Define mockApplyFileFilters *before* it's used in the subsequent mock
const mockApplyFileFilters = vi.fn();

vi.mock('@brainstrike/hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/hooks')>();
  return {
    ...original,
    useFileFilters: vi.fn(() => ({
      applyFileFilters: mockApplyFileFilters,
      filterError: null,
    })),
  };
});

const mockSelectRootDirectory = vi.fn();
const mockRefreshTree = vi.fn();
const mockHandleFileContentLoading = vi.fn();
const mockClearFileContents = vi.fn();

describe('useFileExplorer', () => {
  const mockRootHandle: DirectoryHandle = {
    path: '/mock-root',
    name: 'mock-root',
    kind: 'directory',
    platform: 'web',
    _internal: {} as FileSystemDirectoryHandle,
  };
  let initialFileTree: IFileNode[];
  let filteredTree: IFileNode[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyFileFilters.mockClear();

    initialFileTree = [
      createFileNode({ name: 'file1.ts', path: '/file1.ts' }),
      createFileNode({ name: 'file2.js', path: '/file2.js' }),
    ];
    filteredTree = [initialFileTree[0] as IFileNode];
    mockApplyFileFilters.mockReturnValue(filteredTree);

    // Mock useFileExplorerStore to handle individual selector calls (split selector pattern)
    const mockStoreState: Partial<FileExplorerState> = {
      currentFolderId: null,
      folderStates: {},
      selectedFilePaths: new Set<string>(),
      expandedDirectoryPaths: new Set<string>(),
      includeFilters: [], // Explicitly for the test
      excludeFilters: [], // Explicitly for the test
      useRegex: false, // Explicitly for the test
      includeProjectTree: true,
      folderSummaryThreshold: 5,
      maxSelectionCount: 10,
      lastActiveTab: 'files',
      setCurrentFolderId: vi.fn(),
      hydrateFolderState: vi.fn(),
      setSelectedFiles: vi.fn(),
      addSelectedFile: vi.fn(),
      removeSelectedFile: vi.fn(),
      toggleSelectedFile: vi.fn(),
      clearSelectedFiles: vi.fn(),
      setExpandedPaths: vi.fn(),
      toggleDirectoryExpansion: vi.fn(),
      expandAllDirectories: vi.fn(),
      collapseAllDirectories: vi.fn(),
      setFilters: vi.fn(),
      setUseRegex: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setFolderSummaryThreshold: vi.fn(),
      setMaxSelectionCount: vi.fn(),
      setLastActiveTab: vi.fn(),
    };

    // Mock the store function to handle individual selector calls
    vi.mocked(useFileExplorerStore).mockImplementation(
      (selector?: (state: FileExplorerState) => unknown) => {
        if (typeof selector === 'function') {
          return selector(mockStoreState as FileExplorerState);
        }
        return mockStoreState as FileExplorerState;
      }
    );

    mockSelectRootDirectory.mockResolvedValue(mockRootHandle);

    vi.mocked(useFileSystem).mockReturnValue({
      rootDirectoryHandle: mockRootHandle,
      rootDirectoryHandles: [mockRootHandle],
      rootIdByPath: new Map(),
      isAccessLoading: false,
      addRootDirectory: vi.fn().mockResolvedValue(mockRootHandle),
      registerRestoredHandles: vi.fn().mockResolvedValue(undefined),
      removeRootDirectory: vi.fn().mockResolvedValue(null),
      selectRootDirectory: mockSelectRootDirectory,
      setFocusedRoot: vi.fn(),
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      clearRootDirectory: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setAccessLoading: vi.fn(),
    });

    vi.mocked(useFileTree).mockReturnValue({
      fileTree: initialFileTree,
      isLoading: false,
      error: null,
      refreshTree: mockRefreshTree,
      loadingProgress: { loaded: 0, total: 0, phase: 'loading' },
    });

    vi.mocked(useFileContentLoading).mockReturnValue({
      fileContents: { [encodeFileSelection(mockRootHandle.path, '/file1.ts')]: 'content1' },
      isLoading: false,
      error: null,
      handleFileContentLoading: mockHandleFileContentLoading,
      clearFileContents: mockClearFileContents,
    });
  });

  it('should select root directory', async () => {
    const { result } = renderHook(() => useFileExplorer());

    let handle: DirectoryHandle | null = null;
    await act(async () => {
      handle = await result.current.actions.handleRootDirectorySelect();
    });

    expect(mockSelectRootDirectory).toHaveBeenCalledTimes(1);
    expect(handle).toBe(mockRootHandle);
    expect(result.current.rootDirectoryHandle).toBe(mockRootHandle);
  });

  it('should load file content', async () => {
    const { result } = renderHook(() => useFileExplorer());

    await act(async () => {
      await result.current.actions.loadFileContent('/file1.ts');
    });

    const key = encodeFileSelection(mockRootHandle.path, '/file1.ts');
    expect(mockHandleFileContentLoading).toHaveBeenCalledWith([key]);
    expect(result.current.fileContents[key]).toBe('content1');
  });

  it('should apply filters and update displayed files', () => {
    renderHook(() => useFileExplorer());

    expect(mockApplyFileFilters).toHaveBeenCalledWith(initialFileTree, [], [], false);
  });

  it('should refresh file explorer', async () => {
    const { result } = renderHook(() => useFileExplorer());

    await act(async () => {
      await result.current.actions.refreshFileExplorer();
    });

    expect(mockRefreshTree).toHaveBeenCalled();
  });

  it('should throw when refreshing without root directory', async () => {
    vi.mocked(useFileSystem).mockReturnValue({
      rootDirectoryHandle: null,
      rootDirectoryHandles: [],
      rootIdByPath: new Map(),
      isAccessLoading: false,
      addRootDirectory: vi.fn().mockResolvedValue(null),
      registerRestoredHandles: vi.fn().mockResolvedValue(undefined),
      removeRootDirectory: vi.fn().mockResolvedValue(null),
      selectRootDirectory: mockSelectRootDirectory,
      setFocusedRoot: vi.fn(),
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      clearRootDirectory: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setAccessLoading: vi.fn(),
    });

    const { result } = renderHook(() => useFileExplorer());

    expect(result.current.rootDirectoryHandle).toBeNull();

    await expect(result.current.actions.refreshFileExplorer()).rejects.toBeInstanceOf(Error);
    expect(mockRefreshTree).not.toHaveBeenCalled();
  });
});
