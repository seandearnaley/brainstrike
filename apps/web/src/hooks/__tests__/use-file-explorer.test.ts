import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { useFileSystem } from '@brainstrike/file-explorer-hooks';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileNode } from '../../test/factories/file-node';
import { useFileContentLoading } from '../use-file-content-loading';
import { useFileExplorer } from '../use-file-explorer';
import { useFileTree } from '../use-file-tree';

vi.mock('@brainstrike/file-explorer', () => ({ useFileExplorerStore: vi.fn() }));
vi.mock('@brainstrike/file-explorer-hooks', () => ({ useFileSystem: vi.fn() }));
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
  const mockRootHandle = {} as FileSystemDirectoryHandle;
  let initialFileTree: IFileNode[];
  let filteredTree: IFileNode[];
  let onDisplayedFilePathsChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyFileFilters.mockClear();

    initialFileTree = [
      createFileNode({ name: 'file1.ts', path: '/file1.ts' }),
      createFileNode({ name: 'file2.js', path: '/file2.js' }),
    ];
    filteredTree = [initialFileTree[0] as IFileNode];
    mockApplyFileFilters.mockReturnValue(filteredTree);

    vi.mocked(useFileExplorerStore).mockReturnValue({
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
    } as unknown as FileExplorerState);

    mockSelectRootDirectory.mockResolvedValue(mockRootHandle);

    vi.mocked(useFileSystem).mockReturnValue({
      rootDirectoryHandle: mockRootHandle,
      isAccessLoading: false,
      selectRootDirectory: mockSelectRootDirectory,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
    } as ReturnType<typeof useFileSystem>);

    vi.mocked(useFileTree).mockReturnValue({
      fileTree: initialFileTree,
      isLoading: false,
      error: null,
      refreshTree: mockRefreshTree,
      loadingProgress: { loaded: 0, total: 0, phase: 'loading' },
    });

    vi.mocked(useFileContentLoading).mockReturnValue({
      fileContents: { '/file1.ts': 'content1' },
      isLoading: false,
      error: null,
      handleFileContentLoading: mockHandleFileContentLoading,
      clearFileContents: mockClearFileContents,
    });

    onDisplayedFilePathsChange = vi.fn();
  });

  it('should select root directory', async () => {
    const { result } = renderHook(() => useFileExplorer({ onDisplayedFilePathsChange }));

    let handle: FileSystemDirectoryHandle | null = null;
    await act(async () => {
      handle = await result.current.handleRootDirectorySelect();
    });

    expect(mockSelectRootDirectory).toHaveBeenCalledTimes(1);
    expect(handle).toBe(mockRootHandle);
    expect(result.current.rootDirectoryHandle).toBe(mockRootHandle);
  });

  it('should load file content', async () => {
    const { result } = renderHook(() => useFileExplorer({ onDisplayedFilePathsChange }));

    await act(async () => {
      await result.current.loadFileContent('/file1.ts');
    });

    expect(mockHandleFileContentLoading).toHaveBeenCalledWith(['/file1.ts']);
    expect(result.current.fileContents['/file1.ts']).toBe('content1');
  });

  it('should apply filters and update displayed files', () => {
    renderHook(() => useFileExplorer({ onDisplayedFilePathsChange }));

    expect(mockApplyFileFilters).toHaveBeenCalledWith(initialFileTree, [], [], false);

    expect(onDisplayedFilePathsChange).toHaveBeenCalledWith(new Set(['/file1.ts']));
  });

  it('should refresh file explorer', async () => {
    const { result } = renderHook(() => useFileExplorer({ onDisplayedFilePathsChange }));

    await act(async () => {
      await result.current.refreshFileExplorer();
    });

    expect(mockRefreshTree).toHaveBeenCalled();
  });

  it('should throw when refreshing without root directory', async () => {
    vi.mocked(useFileSystem).mockReturnValue({
      rootDirectoryHandle: null,
      isAccessLoading: false,
      selectRootDirectory: mockSelectRootDirectory,
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
    } as ReturnType<typeof useFileSystem>);

    const { result } = renderHook(() => useFileExplorer({ onDisplayedFilePathsChange }));

    expect(result.current.rootDirectoryHandle).toBeNull();

    await expect(result.current.refreshFileExplorer()).rejects.toBeInstanceOf(Error);
    expect(mockRefreshTree).not.toHaveBeenCalled();
  });
});
