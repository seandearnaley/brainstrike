import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import type {
  FileContentReadResult,
  FileReadRequest,
} from '@brainstrike/workers/file-content-worker';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(),
}));

interface PendingWorkerRead {
  readonly complete: (content: string) => void;
  readonly requests: readonly FileReadRequest[];
}

function createPendingWorker(pendingReads: PendingWorkerRead[]) {
  return vi.fn(
    (
      requests: FileReadRequest[],
      onProgress?: (event: { key: string; loaded: number; total: number }) => void
    ) =>
      new Promise<Record<string, FileContentReadResult>>((resolve) => {
        pendingReads.push({
          complete: (content) => {
            const results: Record<string, FileContentReadResult> = {};
            for (const request of requests) {
              results[request.compositeKey] = { content, status: 'accessible' };
              onProgress?.({ key: request.compositeKey, loaded: 1, total: requests.length });
            }
            resolve(results);
          },
          requests,
        });
      })
  );
}

function createWrapper(adapter: MockFileSystemAdapter) {
  const storage = new MemoryStorageAdapter();
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  };
}

describe('useSharedFileContentLoading reload ordering', () => {
  it('never republishes an older in-flight result after a refresh invalidation', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/file.txt', rootFolderId: 'root-a' });
    const compositeKey = encodeFileSelection('root-a', '/file.txt');
    const pendingReads: PendingWorkerRead[] = [];
    const worker = createPendingWorker(pendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        return { store, ...useSharedFileContentLoading([fileNode]) };
      },
      { wrapper }
    );

    let initialLoad: Promise<void> | undefined;
    act(() => {
      initialLoad = result.current.handleFileContentLoading([compositeKey]);
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFileContents([compositeKey]);
    });

    await act(async () => {
      pendingReads[0]?.complete('stale content');
      await initialLoad;
    });
    await waitFor(() => expect(pendingReads).toHaveLength(2));
    expect(result.current.fileContents[compositeKey]).toBeUndefined();

    await act(async () => {
      pendingReads[1]?.complete('fresh content');
      await reload;
    });

    expect(result.current.fileContents[compositeKey]).toBe('fresh content');
    expect(worker).toHaveBeenCalledTimes(2);
  });

  it('shares stale-read authority between two loaders in one provider', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/shared.txt', rootFolderId: 'root-shared' });
    const compositeKey = encodeFileSelection('root-shared', '/shared.txt');
    const firstPendingReads: PendingWorkerRead[] = [];
    const secondPendingReads: PendingWorkerRead[] = [];
    const firstWorker = createPendingWorker(firstPendingReads);
    const secondWorker = createPendingWorker(secondPendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker)
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(secondWorker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => ({
        first: useSharedFileContentLoading([fileNode]),
        second: useSharedFileContentLoading([fileNode]),
      }),
      { wrapper }
    );

    let initialLoad: Promise<void> | undefined;
    act(() => {
      initialLoad = result.current.first.handleFileContentLoading([compositeKey]);
    });
    await waitFor(() => expect(firstPendingReads).toHaveLength(1));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.second.reloadFileContents([compositeKey]);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(secondWorker).not.toHaveBeenCalled();

    await act(async () => {
      firstPendingReads[0]?.complete('stale cross-loader content');
      await initialLoad;
    });
    await waitFor(() => expect(secondPendingReads).toHaveLength(1));
    expect(result.current.second.fileContents[compositeKey]).toBeUndefined();

    await act(async () => {
      secondPendingReads[0]?.complete('fresh cross-loader content');
      await reload;
    });
    expect(result.current.second.fileContents[compositeKey]).toBe('fresh cross-loader content');
  });

  it('submits multiple ready reload keys through one worker batch', async () => {
    const adapter = new MockFileSystemAdapter();
    const firstNode = createFileNode({ path: '/first.txt', rootFolderId: 'root-batch' });
    const secondNode = createFileNode({ path: '/second.txt', rootFolderId: 'root-batch' });
    const firstKey = encodeFileSelection('root-batch', '/first.txt');
    const secondKey = encodeFileSelection('root-batch', '/second.txt');
    const worker = vi.fn(
      async (
        requests: FileReadRequest[],
        onProgress?: (event: { key: string; loaded: number; total: number }) => void
      ): Promise<Record<string, FileContentReadResult>> => {
        const results: Record<string, FileContentReadResult> = {};
        for (const request of requests) {
          results[request.compositeKey] = {
            content: `fresh:${request.compositeKey}`,
            status: 'accessible',
          };
          onProgress?.({ key: request.compositeKey, loaded: 1, total: requests.length });
        }
        return results;
      }
    );
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useSharedFileContentLoading([firstNode, secondNode]), {
      wrapper,
    });

    await act(async () => {
      await result.current.reloadFileContents([firstKey, secondKey]);
    });

    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith(
      [
        expect.objectContaining({ compositeKey: firstKey }),
        expect.objectContaining({ compositeKey: secondKey }),
      ],
      expect.any(Function)
    );
  });

  it('forwards the nested file handle rootId as read authority', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/nested/file.txt', rootFolderId: 'selection-root' });
    Object.assign(fileNode.handle as object, { rootId: 'durable-authority-root' });
    const compositeKey = encodeFileSelection('selection-root', '/nested/file.txt');
    const worker = vi.fn(
      async (
        requests: FileReadRequest[],
        onProgress?: (event: { key: string; loaded: number; total: number }) => void
      ): Promise<Record<string, FileContentReadResult>> => {
        const request = requests[0];
        if (!request) {
          return {};
        }
        onProgress?.({ key: request.compositeKey, loaded: 1, total: 1 });
        return { [request.compositeKey]: { content: 'nested content', status: 'accessible' } };
      }
    );
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useSharedFileContentLoading([fileNode]), { wrapper });
    await act(async () => {
      await result.current.handleFileContentLoading([compositeKey]);
    });

    const request = worker.mock.calls[0]?.[0]?.[0];
    expect(request?.handle).toMatchObject({
      rootFolderId: 'selection-root',
      rootId: 'durable-authority-root',
    });
    expect(request?.handle?.rootId).not.toBe(request?.handle?.rootFolderId);
  });
});
