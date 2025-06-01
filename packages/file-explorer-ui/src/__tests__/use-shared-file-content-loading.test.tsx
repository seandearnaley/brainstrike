import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection, fileExplorer } from '@brainstrike/utils';
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
