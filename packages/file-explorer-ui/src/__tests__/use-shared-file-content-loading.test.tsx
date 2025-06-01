import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection, fileContent, fileExplorer } from '@brainstrike/utils';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

function useTestHook(fileTree: IFileNode[]) {
  const store = useFileExplorerStoreContext();
  const loading = useSharedFileContentLoading(fileTree);
  return { store, ...loading };
}

function createWrapper(adapter: MockFileSystemAdapter) {
  const storage = new MemoryStorageAdapter();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  };
}

describe('useSharedFileContentLoading - caching', () => {
  it('reuses cached nodes on subsequent loads', async () => {
    const adapter = new MockFileSystemAdapter();
    const readSpy = vi.spyOn(adapter, 'readFile').mockResolvedValue('content');

    const fileNode = createFileNode({ path: '/file.txt', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/file.txt');
    const findSpy = vi.spyOn(fileExplorer, 'findNodeByPath').mockReturnValue(fileNode);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy.mock.calls[0]?.[0]._internal).toBe(fileNode.handle);

    act(() => {
      result.current.store.getState().clearFileContents([compositeKey]);
    });
    rerender();
    findSpy.mockClear();

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(readSpy.mock.calls[1]?.[0]._internal).toBe(fileNode.handle);
  });

  it('refreshes cache when file tree changes', async () => {
    const adapter = new MockFileSystemAdapter();
    const readSpy = vi.spyOn(adapter, 'readFile').mockResolvedValue('content');

    const fileNode1 = createFileNode({ path: '/file.txt', rootFolderId: 'root1' });
    const fileNode2 = createFileNode({ path: '/file.txt', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/file.txt');
    const findSpy = vi
      .spyOn(fileExplorer, 'findNodeByPath')
      .mockReturnValueOnce(fileNode1)
      .mockReturnValueOnce(fileNode2);

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(
      ({ tree }: { tree: IFileNode[] }) => useTestHook(tree),
      { wrapper, initialProps: { tree: [fileNode1] } }
    );

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    act(() => {
      result.current.store.getState().clearFileContents([compositeKey]);
    });

    rerender({ tree: [fileNode2] });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(readSpy.mock.calls[1]?.[0]._internal).toBe(fileNode2.handle);
  });
});

describe('useSharedFileContentLoading - error handling and loading state', () => {
  it('records per-file error and keeps global error null when readFile throws', async () => {
    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readFile').mockRejectedValue(new Error('boom'));

    const fileNode = createFileNode({ path: '/error.txt', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/error.txt');

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toBe('Error accessing file');
    expect(result.current.error).toBeNull();
  });

  it('handles binary files based on extension', async () => {
    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readFile').mockResolvedValue('binary');
    vi.spyOn(fileContent, 'isBinaryExtension').mockReturnValue(true);

    const fileNode = createFileNode({ path: '/image.png', rootFolderId: 'root1' });
    const compositeKey = encodeFileSelection('root1', '/image.png');

    const wrapper = createWrapper(adapter);
    const { result, rerender } = renderHook(() => useTestHook([fileNode]), { wrapper });

    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
      rerender();
    });

    expect(result.current.fileContents[compositeKey]).toBe('Binary file - preview not available');
  });

  it('updates loadingFiles for concurrent loads', async () => {
    const adapter = new MockFileSystemAdapter();
    const resolvers: Array<() => void> = [];
    vi.spyOn(adapter, 'readFile').mockImplementation(
      () => new Promise<string>((resolve) => resolvers.push(() => resolve('done')))
    );

    const fileNode1 = createFileNode({ path: '/one.txt', rootFolderId: 'root1' });
    const fileNode2 = createFileNode({ path: '/two.txt', rootFolderId: 'root1' });
    const key1 = encodeFileSelection('root1', '/one.txt');
    const key2 = encodeFileSelection('root1', '/two.txt');

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useTestHook([fileNode1, fileNode2]), { wrapper });

    act(() => {
      result.current.handleFileContentLoading([key1, key2]);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loadingFiles.has(key1)).toBe(true);
    expect(result.current.loadingFiles.has(key2)).toBe(true);

    // Resolve first file
    resolvers.shift()?.();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loadingFiles.has(key1)).toBe(false);
    expect(result.current.loadingFiles.has(key2)).toBe(true);

    // Resolve second file
    resolvers.shift()?.();
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loadingFiles.size).toBe(0);
  });
});
