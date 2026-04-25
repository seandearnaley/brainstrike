import type { DirectoryHandle } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useFileSystem } from '../use-file-system-context';
import { FileExplorerTestWrapper } from './test-helpers';

function useExposed() {
  const fs = useFileSystem();
  const store = useFileExplorerStoreContext();
  return { fs, store };
}

describe('useFileSystem context hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('selectRootDirectory success sets handle and toggles loading', async () => {
    const mockHandle: DirectoryHandle = {
      path: 'mock-root',
      name: 'mock-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    let resolveFn: (h: DirectoryHandle) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFn = resolve;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let handle: DirectoryHandle | null = null;
    let promise: Promise<DirectoryHandle | null> | undefined;
    act(() => {
      promise = result.current.fs.selectRootDirectory();
    });
    await waitFor(() => expect(result.current.fs.isAccessLoading).toBe(true));

    act(() => {
      resolveFn(mockHandle);
    });

    await act(async () => {
      await promise;
    });

    handle = result.current.fs.rootDirectoryHandle;

    expect(handle).toEqual(mockHandle);
    expect(result.current.fs.rootDirectoryHandle).toEqual(mockHandle);
    expect(result.current.store.getState().currentFolderId).toBe('mock-root');
    expect(result.current.fs.isAccessLoading).toBe(false);
  });

  it('throws Permission denied when access is denied', async () => {
    const error = new Error('Permission denied');
    error.name = 'SecurityError';
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });
    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Permission denied: Unable to access the selected directory. Please check folder permissions and try again.'
    );
  });

  it('returns null when user cancels directory selection', async () => {
    const error = new Error('User cancelled');
    error.name = 'AbortError';
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    act(() => {
      promise = result.current.fs.selectRootDirectory();
    });
    await waitFor(() => expect(result.current.fs.isAccessLoading).toBe(true));

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await expect(promise).resolves.toBeNull();
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
  });

  it('throws dialog open error for "Unable to open directory selection dialog"', async () => {
    const error = new Error('Unable to open directory selection dialog');
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Could not open the folder selection dialog. Please try again.'
    );
  });

  it('throws dialog open error for "Failed to open directory dialog"', async () => {
    const error = new Error('Failed to open directory dialog');
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Could not open the folder selection dialog. Please try again.'
    );
  });

  it('throws read error when unable to read directory', async () => {
    const error = new Error('Unable to read the selected directory');
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Cannot read the selected directory. Please ensure you have proper access permissions.'
    );
  });

  it('throws access error when directory cannot be accessed', async () => {
    const error = new Error('Cannot access selected directory');
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn(error);
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Cannot access the selected directory. Please ensure you have proper access permissions.'
    );
  });

  it('handles non-Error rejections with a generic message', async () => {
    let rejectFn: (e: unknown) => void = () => {};
    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFn = reject;
        })
    );

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    let promise: Promise<DirectoryHandle | null> | undefined;
    let thrown: unknown;
    act(() => {
      promise = result.current.fs.selectRootDirectory().catch((e) => {
        thrown = e;
        return null;
      });
    });

    expect(result.current.fs.isAccessLoading).toBe(true);

    act(() => {
      rejectFn('something went wrong');
    });

    await act(async () => {
      await promise;
    });

    expect(result.current.fs.isAccessLoading).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'An unexpected error occurred while selecting the directory. Please try again.'
    );
  });

  it('rehydrates persisted folder state when restoring a handle for the already-current folder id', () => {
    const restoredHandle: DirectoryHandle = {
      path: 'restored-root',
      name: 'restored-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    const { result } = renderHook(() => useExposed(), { wrapper: FileExplorerTestWrapper });

    act(() => {
      result.current.store.setState({
        currentFolderId: 'restored-root',
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          mode: 'explicit',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
        folderStates: {
          'restored-root': {
            selectedFilePaths: new Set<string>(['restored-root|@|file-0.ts']),
            selectionModel: {
              mode: 'query',
              explicitPaths: new Set<string>(),
              ruleSetJson: null,
              materializedPaths: new Set<string>(['file-0.ts']),
              materializedAt: new Date().toISOString(),
              queryDescriptor: {
                kind: 'recursive-select-all',
                folderId: 'restored-root',
                rootPath: null,
                coveredDirectoryPaths: [],
                includeFilters: ['*.ts'],
                excludeFilters: [],
                includedPaths: [],
                excludedPaths: [],
                manifestFingerprint: 'fingerprint',
                manifestSnapshotId: 'snapshot-id',
                useRegex: false,
                totalSelectedCount: 600,
              },
            },
            expandedDirectoryPaths: new Set<string>(),
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: true,
            tokenBudget: 100_000,
            folderSummaryThreshold: 5,
            maxSelectionCount: 1000,
            lastActiveTab: 'files',
            lastAccessed: Date.now(),
            viewFilterPresetId: null,
          },
        },
      });
    });

    act(() => {
      result.current.fs.setRootDirectoryHandle(restoredHandle);
    });

    expect(result.current.store.getState().selectionModel.mode).toBe('query');
    expect(result.current.store.getState().selectedFilePaths.size).toBe(1);
  });

  it('rehydrates persisted folder state when selecting the already-current folder id', async () => {
    const restoredHandle: DirectoryHandle = {
      path: 'selected-restored-root',
      name: 'selected-restored-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    vi.spyOn(MockFileSystemAdapter.prototype, 'requestDirectoryAccess').mockResolvedValue(
      restoredHandle
    );

    const isolatedStorageAdapter = new MemoryStorageAdapter();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, {
        children,
        mockStorageAdapter: isolatedStorageAdapter,
      });
    const { result } = renderHook(() => useExposed(), { wrapper });

    act(() => {
      result.current.store.setState({
        currentFolderId: 'selected-restored-root',
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          mode: 'explicit',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
        folderStates: {
          'selected-restored-root': {
            selectedFilePaths: new Set<string>(['selected-restored-root|@|file-0.ts']),
            selectionModel: {
              mode: 'explicit',
              explicitPaths: new Set<string>(['selected-restored-root|@|file-0.ts']),
              ruleSetJson: null,
              materializedPaths: null,
              materializedAt: null,
              queryDescriptor: null,
            },
            expandedDirectoryPaths: new Set<string>(['src']),
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: true,
            tokenBudget: 100_000,
            folderSummaryThreshold: 5,
            maxSelectionCount: 1000,
            lastActiveTab: 'files',
            lastAccessed: Date.now(),
            viewFilterPresetId: null,
          },
        },
      });
    });

    await act(async () => {
      await result.current.fs.selectRootDirectory();
    });

    expect(result.current.store.getState().selectedFilePaths.size).toBe(1);
    expect(result.current.store.getState().expandedDirectoryPaths).toEqual(new Set(['src']));
  });

  it('syncs an auto-restored root handle into the store', async () => {
    const restoredHandle: DirectoryHandle = {
      path: 'restored-root',
      name: 'restored-root',
      kind: 'directory',
      platform: 'web',
    } as DirectoryHandle;

    const adapterWithRestore = Object.assign(new MockFileSystemAdapter(), {
      restoreLastFolder: vi.fn(async () => restoredHandle),
    });

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, {
        children,
        mockFileSystemAdapter: adapterWithRestore,
      });

    const { result } = renderHook(() => useExposed(), { wrapper });

    await waitFor(() => {
      expect(result.current.fs.rootDirectoryHandle).toEqual(restoredHandle);
      expect(result.current.store.getState().rootDirectoryHandle).toEqual(restoredHandle);
      expect(result.current.store.getState().currentFolderId).toBe('restored-root');
    });
  });
});
