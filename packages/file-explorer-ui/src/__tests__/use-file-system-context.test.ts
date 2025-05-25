import type { DirectoryHandle } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
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

    await promise;

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
});
