import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks for internal context hooks
vi.mock('../file-explorer-provider', () => ({
  useFileExplorerStoreContext: vi.fn(),
}));
vi.mock('../use-file-system-context', () => ({
  useFileSystem: vi.fn(),
}));
vi.mock('../use-file-tree-context', () => ({
  useFileTree: vi.fn(),
}));
vi.mock('../use-shared-file-content-loading', () => ({
  useSharedFileContentLoading: vi.fn(),
}));

// Mocks for external hooks used inside the context hook
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useFileContentLoading: vi.fn(),
  useFileExplorer: vi.fn(),
  useAdapters: vi.fn(),
}));

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

import {
  useAdapters,
  useFileExplorer as useCoreFileExplorer,
  useFileContentLoading,
} from '@brainstrike/file-explorer-hooks';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useFileExplorer } from '../use-file-explorer-context';
import { useFileSystem } from '../use-file-system-context';
import { useFileTree } from '../use-file-tree-context';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

describe('useFileExplorer (context)', () => {
  const mockSelectRootDirectory = vi.fn();
  const mockRefreshTree = vi.fn();
  const mockHandleFileContentLoading = vi.fn();
  const mockClearFileContents = vi.fn();

  const rootHandle: DirectoryHandle = {
    path: '/root',
    name: 'root',
    kind: 'directory',
    platform: 'web',
    _internal: {} as FileSystemDirectoryHandle,
  };

  let initialFileTree: IFileNode[];
  let filteredTree: IFileNode[];
  let onDisplayedFilePathsChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    initialFileTree = [
      createFileNode({ name: 'file1.ts', path: '/file1.ts' }),
      createFileNode({ name: 'file2.js', path: '/file2.js' }),
    ];
    filteredTree = [initialFileTree[0] as IFileNode];
    mockApplyFileFilters.mockReturnValue(filteredTree);

    const storeState: FileExplorerState = {
      currentFolderId: null,
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
      folderAccessOrder: [],
      fileContents: {},
      setCurrentFolderId: vi.fn(),
      hydrateFolderState: vi.fn(),
      setSelectedFiles: vi.fn(),
      addSelectedFile: vi.fn(),
      removeSelectedFile: vi.fn(),
      toggleSelectedFile: vi.fn(),
      clearSelectedFiles: vi.fn(),
      addMultipleSelectedFiles: vi.fn(),
      removeMultipleSelectedFiles: vi.fn(),
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
      setFileContent: vi.fn(),
      clearFileContents: vi.fn(),
      clearAllFileContents: vi.fn(),
    };
    const mockStore = vi.fn(() => storeState) as unknown as ReturnType<
      typeof useFileExplorerStoreContext
    >;
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore);

    vi.mocked(useFileSystem).mockReturnValue({
      rootDirectoryHandle: rootHandle,
      isAccessLoading: false,
      selectRootDirectory: mockSelectRootDirectory,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
    });

    vi.mocked(useFileTree).mockReturnValue({
      fileTree: initialFileTree,
      isLoading: false,
      error: null,
      refreshTree: mockRefreshTree,
      loadingProgress: { loaded: 0, total: 0, phase: 'loading' },
      cancellable: false,
      cancelOperation: vi.fn(),
      isCancelling: false,
    });

    vi.mocked(useFileContentLoading).mockReturnValue({
      fileContents: { '/file1.ts': 'content' },
      isLoading: false,
      error: null,
      handleFileContentLoading: mockHandleFileContentLoading,
      clearFileContents: mockClearFileContents,
    });

    vi.mocked(useSharedFileContentLoading).mockReturnValue({
      fileContents: { '/file1.ts': 'content' },
      isLoading: false,
      error: null,
      loadingFiles: new Set<string>(),
      handleFileContentLoading: mockHandleFileContentLoading,
    });

    const coreReturn = {
      isLoading: false,
      rootDirectoryHandle: rootHandle,
      error: null,
      filterError: null,
    } as unknown as ReturnType<typeof useCoreFileExplorer>;
    vi.mocked(useCoreFileExplorer).mockReturnValue(coreReturn);

    vi.mocked(useAdapters).mockReturnValue({
      fileSystemAdapter: {
        readFile: vi.fn(),
        readDirectory: vi.fn(),
      } as Partial<FileSystemAdapter> as FileSystemAdapter,
      storageAdapter: {} as StorageAdapter,
    });

    onDisplayedFilePathsChange = vi.fn();
  });

  it('returns values combined from context hooks', () => {
    const { result } = renderHook(() => useFileExplorer({ onDisplayedFilePathsChange }));

    expect(result.current.fileTree).toBe(filteredTree);
    expect(result.current.rootDirectoryHandle).toBe(rootHandle);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fileContents['/file1.ts']).toBe('content');
    expect(mockApplyFileFilters).toHaveBeenCalledWith(initialFileTree, [], [], false);
    expect(onDisplayedFilePathsChange).toHaveBeenCalledWith(new Set(['/file1.ts']));

    act(() => {
      result.current.handleRootDirectorySelect();
      result.current.loadFileContent('/file1.ts');
    });

    expect(mockSelectRootDirectory).toHaveBeenCalled();
    expect(mockHandleFileContentLoading).toHaveBeenCalledWith(['/file1.ts']);
  });

  it('applyFileFilters updates the filtered tree', () => {
    const { result } = renderHook(() => useFileExplorer({ onDisplayedFilePathsChange }));

    const newFiltered = [initialFileTree[1] as IFileNode];
    mockApplyFileFilters.mockReturnValueOnce(newFiltered);

    act(() => {
      const returned = result.current.applyFileFilters(['*.js'], [], false);
      expect(returned).toBe(newFiltered);
    });

    expect(result.current.fileTree).toBe(newFiltered);
  });

  it('refreshFileExplorer throws when no root directory is selected', async () => {
    vi.mocked(useFileSystem).mockReturnValue({
      rootDirectoryHandle: null,
      isAccessLoading: false,
      selectRootDirectory: mockSelectRootDirectory,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
    });

    const { result } = renderHook(() => useFileExplorer({ onDisplayedFilePathsChange }));

    expect(result.current.rootDirectoryHandle).toBeNull();
    await expect(result.current.refreshFileExplorer()).rejects.toBeInstanceOf(Error);
    expect(mockRefreshTree).not.toHaveBeenCalled();
  });
});
