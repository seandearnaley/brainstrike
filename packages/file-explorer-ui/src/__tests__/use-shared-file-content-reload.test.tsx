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
import {
  FileExplorerProvider,
  useFileContentLoadAuthority,
  useFileExplorerStoreContext,
} from '../shell/file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(),
}));

interface PendingWorkerRead {
  readonly complete: (content: string) => void;
  readonly fail: (error: Error) => void;
  readonly requests: readonly FileReadRequest[];
}

function createPendingWorker(pendingReads: PendingWorkerRead[]) {
  return vi.fn(
    (
      requests: FileReadRequest[],
      onProgress?: (event: { key: string; loaded: number; total: number }) => void
    ) =>
      new Promise<Record<string, FileContentReadResult>>((resolve, reject) => {
        pendingReads.push({
          complete: (content) => {
            const results: Record<string, FileContentReadResult> = {};
            for (const request of requests) {
              results[request.compositeKey] = { content, status: 'accessible' };
              onProgress?.({ key: request.compositeKey, loaded: 1, total: requests.length });
            }
            resolve(results);
          },
          fail: reject,
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

  it('starts idle reload keys in one batch without waiting for an active key', async () => {
    const adapter = new MockFileSystemAdapter();
    const activeNode = createFileNode({ path: '/active.txt', rootFolderId: 'root-groups' });
    const idleNodeA = createFileNode({ path: '/idle-a.txt', rootFolderId: 'root-groups' });
    const idleNodeB = createFileNode({ path: '/idle-b.txt', rootFolderId: 'root-groups' });
    const activeKey = encodeFileSelection('root-groups', '/active.txt');
    const idleKeyA = encodeFileSelection('root-groups', '/idle-a.txt');
    const idleKeyB = encodeFileSelection('root-groups', '/idle-b.txt');
    const pendingReads: PendingWorkerRead[] = [];
    const worker = createPendingWorker(pendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => useSharedFileContentLoading([activeNode, idleNodeA, idleNodeB]),
      { wrapper }
    );

    let activeLoad: Promise<void> | undefined;
    act(() => {
      activeLoad = result.current.handleFileContentLoading([activeKey]);
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFileContents([activeKey, idleKeyA, idleKeyB]);
    });

    await waitFor(() => expect(pendingReads).toHaveLength(2));
    expect(pendingReads[1]?.requests.map((request) => request.compositeKey)).toEqual([
      idleKeyA,
      idleKeyB,
    ]);

    await act(async () => {
      pendingReads[1]?.complete('idle fresh content');
      pendingReads[0]?.complete('active stale content');
      await activeLoad;
    });
    await waitFor(() => expect(pendingReads).toHaveLength(3));
    expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([activeKey]);

    await act(async () => {
      pendingReads[2]?.complete('active fresh content');
      await reload;
    });
  });

  it('reloads each preceding-read group as soon as that group settles', async () => {
    const adapter = new MockFileSystemAdapter();
    const slowNode = createFileNode({ path: '/slow.txt', rootFolderId: 'root-groups' });
    const fastNode = createFileNode({ path: '/fast.txt', rootFolderId: 'root-groups' });
    const slowKey = encodeFileSelection('root-groups', '/slow.txt');
    const fastKey = encodeFileSelection('root-groups', '/fast.txt');
    const pendingReads: PendingWorkerRead[] = [];
    const worker = createPendingWorker(pendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(() => useSharedFileContentLoading([slowNode, fastNode]), {
      wrapper,
    });

    let slowLoad: Promise<void> | undefined;
    let fastLoad: Promise<void> | undefined;
    act(() => {
      slowLoad = result.current.handleFileContentLoading([slowKey]);
      fastLoad = result.current.handleFileContentLoading([fastKey]);
    });
    await waitFor(() => expect(pendingReads).toHaveLength(2));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFileContents([slowKey, fastKey]);
    });
    await act(async () => {
      pendingReads[1]?.complete('fast stale content');
      await fastLoad;
    });

    await waitFor(() => expect(pendingReads).toHaveLength(3));
    expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([fastKey]);
    expect(slowLoad).toBeDefined();

    await act(async () => {
      pendingReads[2]?.complete('fast fresh content');
      pendingReads[0]?.complete('slow stale content');
      await slowLoad;
    });
    await waitFor(() => expect(pendingReads).toHaveLength(4));
    expect(pendingReads[3]?.requests.map((request) => request.compositeKey)).toEqual([slowKey]);

    await act(async () => {
      pendingReads[3]?.complete('slow fresh content');
      await reload;
    });
  });

  it('retries a rejected preceding group without starving idle keys', async () => {
    const adapter = new MockFileSystemAdapter();
    const rejectedNode = createFileNode({ path: '/rejected.txt', rootFolderId: 'root-errors' });
    const idleNode = createFileNode({ path: '/idle.txt', rootFolderId: 'root-errors' });
    const rejectedKey = encodeFileSelection('root-errors', '/rejected.txt');
    const idleKey = encodeFileSelection('root-errors', '/idle.txt');
    const pendingReads: PendingWorkerRead[] = [];
    const worker = createPendingWorker(pendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => {
        const authority = useFileContentLoadAuthority();
        return { authority, loader: useSharedFileContentLoading([rejectedNode, idleNode]) };
      },
      { wrapper }
    );

    let rejectPreceding: ((error: Error) => void) | undefined;
    const sourcePromise = new Promise<void>((_resolve, reject) => {
      rejectPreceding = reject;
    });
    let trackedPromise: Promise<void>;
    trackedPromise = sourcePromise.finally(() => {
      result.current.authority.releaseActiveLoad([rejectedKey], trackedPromise);
    });
    result.current.authority.trackActiveLoad([rejectedKey], trackedPromise);

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.loader.reloadFileContents([rejectedKey, idleKey]);
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));
    expect(pendingReads[0]?.requests.map((request) => request.compositeKey)).toEqual([idleKey]);

    act(() => {
      rejectPreceding?.(new Error('preceding read failed'));
    });
    await waitFor(() => expect(pendingReads).toHaveLength(2));
    expect(pendingReads[1]?.requests.map((request) => request.compositeKey)).toEqual([rejectedKey]);

    await act(async () => {
      pendingReads[0]?.complete('idle fresh content');
      pendingReads[1]?.complete('rejected fresh content');
      await reload;
    });
  });

  it('keeps a replacement provider cache isolated from an older in-flight read', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/provider.txt', rootFolderId: 'root-provider' });
    const compositeKey = encodeFileSelection('root-provider', '/provider.txt');
    const pendingReads: PendingWorkerRead[] = [];
    const worker = createPendingWorker(pendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    let storage = new MemoryStorageAdapter();
    function ReplaceableWrapper({ children }: { readonly children: ReactNode }) {
      return (
        <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
          <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
        </AdaptersProvider>
      );
    }

    const { rerender, result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        return { loader: useSharedFileContentLoading([fileNode]), store };
      },
      { wrapper: ReplaceableWrapper }
    );

    let oldProviderLoad: Promise<void> | undefined;
    act(() => {
      oldProviderLoad = result.current.loader.handleFileContentLoading([compositeKey]);
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    storage = new MemoryStorageAdapter();
    rerender();
    act(() => {
      result.current.store.getState().setFileContent(compositeKey, 'replacement content');
    });

    await act(async () => {
      pendingReads[0]?.complete('obsolete provider content');
      await oldProviderLoad;
    });

    expect(result.current.store.getState().getFileContent(compositeKey)).toBe(
      'replacement content'
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
