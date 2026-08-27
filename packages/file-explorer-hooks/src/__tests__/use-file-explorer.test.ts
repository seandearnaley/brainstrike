import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/test-utils';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileContentLoading } from '../use-file-content-loading.js';
import { useFileExplorer } from '../use-file-explorer.js';
import { useFileSystem } from '../use-file-system.js';
import { useFileTree } from '../use-file-tree.js';

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
    _internal: {} as FileSystemDirectoryHandle,
    kind: 'directory',
    name: 'mock-root',
    path: '/mock-root',
    platform: 'web',
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
      addSelectedFile: vi.fn(),
      clearSelectedFiles: vi.fn(),
      collapseAllDirectories: vi.fn(),
      currentFolderId: null,
      excludeFilters: [], // Explicitly for the test
      expandAllDirectories: vi.fn(),
      expandedDirectoryPaths: new Set<string>(),
      folderStates: {},
      folderSummaryThreshold: 5,
      hydrateFolderState: vi.fn(),
      includeFilters: [], // Explicitly for the test
      includeProjectTree: true,
      lastActiveTab: 'files',
      maxSelectionCount: 10,
      removeSelectedFile: vi.fn(),
      selectedFilePaths: new Set<string>(),
      setCurrentFolderId: vi.fn(),
      setExpandedPaths: vi.fn(),
      setFilters: vi.fn(),
      setFolderSummaryThreshold: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setLastActiveTab: vi.fn(),
      setMaxSelectionCount: vi.fn(),
      setSelectedFiles: vi.fn(),
      setUseRegex: vi.fn(),
      toggleDirectoryExpansion: vi.fn(),
      toggleSelectedFile: vi.fn(),
      useRegex: false, // Explicitly for the test
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
      addExternalRootHandle: vi.fn(),
      addRootDirectory: vi.fn().mockResolvedValue(mockRootHandle),
      // Web-shaped adapter: the desktop-only capabilities are absent, not stubbed.
      addRootDirectoryByPath: undefined,
      clearRootDirectory: vi.fn(),
      isAccessLoading: false,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason: '', supported: true }),
      listRecentRoots: undefined,
      recentRootsRevision: 0,
      registerRestoredHandles: vi.fn().mockResolvedValue(undefined),
      removeRootDirectory: vi.fn().mockResolvedValue(null),
      rootDirectoryHandle: mockRootHandle,
      rootDirectoryHandles: [mockRootHandle],
      rootIdByPath: new Map(),
      selectRootDirectory: mockSelectRootDirectory,
      setAccessLoading: vi.fn(),
      setFocusedRoot: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
    });

    vi.mocked(useFileTree).mockReturnValue({
      error: null,
      fileTree: initialFileTree,
      isLoading: false,
      loadingProgress: { loaded: 0, phase: 'loading', total: 0 },
      refreshTree: mockRefreshTree,
    });

    vi.mocked(useFileContentLoading).mockReturnValue({
      clearFileContents: mockClearFileContents,
      error: null,
      fileContents: { [encodeFileSelection(mockRootHandle.path, '/file1.ts')]: 'content1' },
      handleFileContentLoading: mockHandleFileContentLoading,
      isLoading: false,
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
      addExternalRootHandle: vi.fn(),
      addRootDirectory: vi.fn().mockResolvedValue(null),
      addRootDirectoryByPath: undefined,
      clearRootDirectory: vi.fn(),
      isAccessLoading: false,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason: '', supported: true }),
      listRecentRoots: undefined,
      recentRootsRevision: 0,
      registerRestoredHandles: vi.fn().mockResolvedValue(undefined),
      removeRootDirectory: vi.fn().mockResolvedValue(null),
      rootDirectoryHandle: null,
      rootDirectoryHandles: [],
      rootIdByPath: new Map(),
      selectRootDirectory: mockSelectRootDirectory,
      setAccessLoading: vi.fn(),
      setFocusedRoot: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
    });

    const { result } = renderHook(() => useFileExplorer());

    expect(result.current.rootDirectoryHandle).toBeNull();

    await expect(result.current.actions.refreshFileExplorer()).rejects.toBeInstanceOf(Error);
    expect(mockRefreshTree).not.toHaveBeenCalled();
  });
});
