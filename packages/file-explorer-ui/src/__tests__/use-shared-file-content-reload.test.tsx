import { clearPersistentUiStateWithResult } from '@brainstrike/app-state/factory-reset';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { AdaptersProvider, buildInaccessibleContent } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/file-tree-test-fixtures';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type {
  FileContentReadResult,
  FileReadRequest,
} from '@brainstrike/workers/file-content-worker';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFileContentLoadAuthority } from '../file-content-load-authority-context';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';
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
  it('replaces cached open-tab bytes with a terminal missing result when refresh leaves an empty tree', async () => {
    const adapter = new MockFileSystemAdapter();
    const rootId = '33333333-0000-4000-8000-000000000033';
    const compositeKey = encodeFileSelection(rootId, '/workspace/only-open-file.txt');
    const readFileByPath = vi
      .fn<(path: string) => Promise<string>>()
      .mockRejectedValue(new Error('ENOENT: file was deleted'));
    (
      adapter as unknown as {
        readFileByAbsolutePath: (
          absolutePath: string,
          rootPath: string,
          rootId: string
        ) => Promise<string>;
        readFileByPath: typeof readFileByPath;
      }
    ).readFileByPath = readFileByPath;
    (
      adapter as unknown as {
        readFileByAbsolutePath: (
          absolutePath: string,
          rootPath: string,
          rootId: string
        ) => Promise<string>;
      }
    ).readFileByAbsolutePath = (absolutePath) => readFileByPath(absolutePath);
    const worker = vi.fn(
      async (
        requests: FileReadRequest[],
        onProgress?: (event: { key: string; loaded: number; total: number }) => void
      ): Promise<Record<string, FileContentReadResult>> => {
        const request = requests[0];
        if (!request) {
          return {};
        }
        try {
          await readFileByPath(request.path);
          return {
            [request.compositeKey]: { content: 'unexpected content', status: 'accessible' },
          };
        } catch {
          onProgress?.({ key: request.compositeKey, loaded: 1, total: 1 });
          return {
            [request.compositeKey]: {
              message: 'ENOENT: file was deleted',
              status: 'inaccessible',
            },
          };
        }
      }
    );
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        return { loader: useSharedFileContentLoading([]), store };
      },
      { wrapper }
    );
    act(() => {
      result.current.store
        .getState()
        .setActiveRoots([{ displayName: 'workspace', path: '/workspace', rootId }]);
      result.current.store.getState().setFileContent(compositeKey, 'cached before deletion');
    });

    await act(async () => {
      await result.current.loader.reloadFileContents([compositeKey], 'background');
    });

    expect(worker).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          absoluteRootId: rootId,
          absoluteRootPath: '/workspace',
          compositeKey,
          path: '/workspace/only-open-file.txt',
        }),
      ],
      expect.any(Function)
    );
    expect(readFileByPath).toHaveBeenCalledExactlyOnceWith('/workspace/only-open-file.txt');
    expect(result.current.loader.fileContents[compositeKey]).toBe(
      buildInaccessibleContent('ENOENT: file was deleted')
    );
    expect(result.current.loader.loadingFiles.has(compositeKey)).toBe(false);
  });

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
      initialLoad = result.current.handleFileContentLoading([compositeKey], 'background');
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFileContents([compositeKey], 'background');
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
      initialLoad = result.current.first.handleFileContentLoading([compositeKey], 'background');
    });
    await waitFor(() => expect(firstPendingReads).toHaveLength(1));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.second.reloadFileContents([compositeKey], 'background');
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
      await result.current.reloadFileContents([firstKey, secondKey], 'background');
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
      activeLoad = result.current.handleFileContentLoading([activeKey], 'background');
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFileContents([activeKey, idleKeyA, idleKeyB], 'background');
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
      slowLoad = result.current.handleFileContentLoading([slowKey], 'background');
      fastLoad = result.current.handleFileContentLoading([fastKey], 'background');
    });
    await waitFor(() => expect(pendingReads).toHaveLength(2));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFileContents([slowKey, fastKey], 'background');
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
      reload = result.current.loader.reloadFileContents([rejectedKey, idleKey], 'background');
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
      oldProviderLoad = result.current.loader.handleFileContentLoading(
        [compositeKey],
        'background'
      );
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

  it('factory reset invalidates an in-flight read and clears live content state', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/reset.txt', rootFolderId: 'root-reset' });
    const compositeKey = encodeFileSelection('root-reset', '/reset.txt');
    const pendingReads: PendingWorkerRead[] = [];
    const worker = createPendingWorker(pendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        return { loader: useSharedFileContentLoading([fileNode]), store };
      },
      { wrapper }
    );

    let inFlightLoad: Promise<void> | undefined;
    act(() => {
      inFlightLoad = result.current.loader.handleFileContentLoading([compositeKey], 'background');
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));
    act(() => {
      result.current.store.getState().setFileContent(compositeKey, 'cached before reset');
    });

    await act(async () => {
      const resetResult = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
      expect(resetResult.success).toBe(true);
    });
    const loadingImmediatelyAfterReset = new Set(result.current.loader.loadingFiles);
    const contentsImmediatelyAfterReset = result.current.store.getState().fileContents;
    const cacheEntriesImmediatelyAfterReset = result.current.store
      .getState()
      .getFileContentCacheStats().entryCount;

    await act(async () => {
      pendingReads[0]?.complete('obsolete content after reset');
      await Promise.allSettled([inFlightLoad]);
    });

    expect(loadingImmediatelyAfterReset.size).toBe(0);
    expect(contentsImmediatelyAfterReset).toEqual({});
    expect(cacheEntriesImmediatelyAfterReset).toBe(0);
    expect(result.current.store.getState().getFileContent(compositeKey)).toBeUndefined();
  });

  it('factory reset clears projected terminal content errors', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/reset-error.txt', rootFolderId: 'root-reset-error' });
    const compositeKey = encodeFileSelection('root-reset-error', '/reset-error.txt');
    const workerFailure = new Error('read failed before reset');
    const worker = vi.fn().mockRejectedValue(workerFailure);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const retainedErrorOwner = {};
    const { result } = renderHook(
      () => ({
        authority: useFileContentLoadAuthority(),
        loader: useSharedFileContentLoading([fileNode]),
      }),
      { wrapper }
    );
    act(() => {
      result.current.authority.setRetainedErrorKeys(retainedErrorOwner, [compositeKey]);
    });

    await act(async () => {
      await expect(
        result.current.loader.handleFileContentLoading([compositeKey], 'background')
      ).rejects.toBe(workerFailure);
    });
    expect(result.current.loader.fileContentErrors.get(compositeKey)).toBe(workerFailure);

    await act(async () => {
      const resetResult = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
      expect(resetResult.success).toBe(true);
    });

    expect(result.current.loader.fileContentErrors.size).toBe(0);
    expect(result.current.loader.error).toBeNull();
  });

  it('settles preparation per key and prunes an unowned report error after rejection', async () => {
    const adapter = new MockFileSystemAdapter();
    const validNode = createFileNode({ path: '/valid.txt', rootFolderId: 'root-prepare' });
    const validKey = encodeFileSelection('root-prepare', '/valid.txt');
    const malformedKey = 'malformed-selection-key';
    const worker = vi.fn(
      async (
        requests: FileReadRequest[],
        onProgress?: (event: { key: string; loaded: number; total: number }) => void
      ): Promise<Record<string, FileContentReadResult>> => {
        const results: Record<string, FileContentReadResult> = {};
        for (const request of requests) {
          results[request.compositeKey] = {
            content: 'valid sibling content',
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
    const { result } = renderHook(() => useSharedFileContentLoading([validNode]), { wrapper });
    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.handleFileContentLoading([malformedKey, validKey], 'background');
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toBeInstanceOf(Error);
    expect(worker).toHaveBeenCalledOnce();
    expect(worker.mock.calls[0]?.[0].map((request) => request.compositeKey)).toEqual([validKey]);
    expect(result.current.fileContents[validKey]).toBe('valid sibling content');
    expect(result.current.fileContentErrors.size).toBe(0);
    expect(result.current.loadingFiles.size).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('rethrows worker rejection and cleans every loading marker before retry', async () => {
    const adapter = new MockFileSystemAdapter();
    const firstNode = createFileNode({ path: '/first.txt', rootFolderId: 'root-worker-error' });
    const secondNode = createFileNode({ path: '/second.txt', rootFolderId: 'root-worker-error' });
    const firstKey = encodeFileSelection('root-worker-error', '/first.txt');
    const secondKey = encodeFileSelection('root-worker-error', '/second.txt');
    const workerFailure = new Error('worker batch rejected');
    let invocation = 0;
    const worker = vi.fn(
      async (
        requests: FileReadRequest[],
        onProgress?: (event: { key: string; loaded: number; total: number }) => void
      ): Promise<Record<string, FileContentReadResult>> => {
        invocation += 1;
        if (invocation === 1) {
          throw workerFailure;
        }
        const results: Record<string, FileContentReadResult> = {};
        for (const request of requests) {
          results[request.compositeKey] = { content: 'retry content', status: 'accessible' };
          onProgress?.({ key: request.compositeKey, loaded: 1, total: requests.length });
        }
        return results;
      }
    );
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const retainedErrorOwner = {};
    const { result } = renderHook(
      () => ({
        authority: useFileContentLoadAuthority(),
        loader: useSharedFileContentLoading([firstNode, secondNode]),
      }),
      { wrapper }
    );
    act(() => {
      result.current.authority.setRetainedErrorKeys(retainedErrorOwner, [firstKey, secondKey]);
    });
    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.loader.handleFileContentLoading([firstKey, secondKey], 'background');
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toBe(workerFailure);
    expect(result.current.loader.error).toBe(workerFailure);
    expect(result.current.loader.fileContentErrors.get(firstKey)).toBe(workerFailure);
    expect(result.current.loader.fileContentErrors.get(secondKey)).toBe(workerFailure);
    expect(result.current.loader.loadingFiles.size).toBe(0);

    await act(async () => {
      await result.current.loader.handleFileContentLoading([firstKey, secondKey], 'background');
    });
    expect(worker).toHaveBeenCalledTimes(2);
    expect(result.current.loader.fileContentErrors.size).toBe(0);
    expect(result.current.loader.fileContents[firstKey]).toBe('retry content');
    expect(result.current.loader.fileContents[secondKey]).toBe('retry content');
  });

  it('waits for every independent reload group and preserves only the failed key error', async () => {
    const adapter = new MockFileSystemAdapter();
    const nodes = Array.from({ length: 3 }, (_, index) =>
      createFileNode({ path: `/settled-${index}.txt`, rootFolderId: 'root-all-settled' })
    );
    const compositeKeys = nodes.map((node) => encodeFileSelection('root-all-settled', node.path));
    const workerFailure = new Error('first scheduled group failed');
    const pendingReads: PendingWorkerRead[] = [];
    const worker = createPendingWorker(pendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => {
        const authority = useFileContentLoadAuthority();
        return { authority, loader: useSharedFileContentLoading(nodes) };
      },
      { wrapper }
    );
    const retainedErrorOwner = {};
    act(() => {
      result.current.authority.setRetainedErrorKeys(retainedErrorOwner, compositeKeys);
    });

    const resolvePredecessors: Array<() => void> = [];
    for (const compositeKey of compositeKeys) {
      let resolvePredecessor: (() => void) | undefined;
      const predecessor = new Promise<void>((resolve) => {
        resolvePredecessor = resolve;
      });
      let trackedPredecessor: Promise<void>;
      trackedPredecessor = predecessor.finally(() => {
        result.current.authority.releaseActiveLoad([compositeKey], trackedPredecessor);
      });
      result.current.authority.trackActiveLoad([compositeKey], trackedPredecessor);
      resolvePredecessors.push(() => resolvePredecessor?.());
    }

    let reloadSettled = false;
    let observedReload:
      | Promise<
          | { readonly error: unknown; readonly status: 'rejected' }
          | { readonly status: 'fulfilled' }
        >
      | undefined;
    act(() => {
      observedReload = result.current.loader.reloadFileContents(compositeKeys, 'background').then(
        () => {
          reloadSettled = true;
          return { status: 'fulfilled' as const };
        },
        (error: unknown) => {
          reloadSettled = true;
          return { error, status: 'rejected' as const };
        }
      );
      for (const resolvePredecessor of resolvePredecessors) {
        resolvePredecessor();
      }
    });

    // The provider-wide two-lane scheduler starts two groups and retains the
    // third until one lane settles.
    await waitFor(() => expect(pendingReads).toHaveLength(2));
    await act(async () => {
      pendingReads[0]?.fail(workerFailure);
      await Promise.resolve();
    });
    await waitFor(() => expect(pendingReads).toHaveLength(3));

    // A fail-fast aggregate would already have rejected here even though two
    // sibling reads remain active. The public logical reload owns all three.
    expect(reloadSettled).toBe(false);

    await act(async () => {
      pendingReads[1]?.complete('second group succeeded');
      await Promise.resolve();
    });
    expect(reloadSettled).toBe(false);

    let outcome:
      | { readonly error: unknown; readonly status: 'rejected' }
      | { readonly status: 'fulfilled' }
      | undefined;
    await act(async () => {
      pendingReads[2]?.complete('queued group succeeded');
      const reloadToObserve = observedReload;
      if (!reloadToObserve) {
        throw new Error('Expected the reload promise to be observed.');
      }
      outcome = await reloadToObserve;
    });

    expect(outcome).toEqual({ error: workerFailure, status: 'rejected' });
    const { fileContentErrors } = result.current.loader;
    expect(fileContentErrors.get(compositeKeys[0] ?? '')).toBe(workerFailure);
    expect(fileContentErrors.has(compositeKeys[1] ?? '')).toBe(false);
    expect(fileContentErrors.has(compositeKeys[2] ?? '')).toBe(false);
    expect(result.current.loader.loadingFiles.size).toBe(0);
  });

  it('serializes twenty distinct predecessor groups through the provider batch queue', async () => {
    const adapter = new MockFileSystemAdapter();
    const nodes = Array.from({ length: 20 }, (_, index) =>
      createFileNode({ path: `/file-${index}.txt`, rootFolderId: 'root-concurrency' })
    );
    const compositeKeys = nodes.map((node) => encodeFileSelection('root-concurrency', node.path));
    let activeWorkerQueues = 0;
    let peakWorkerQueues = 0;
    const completeWorkerQueues: Array<() => void> = [];
    const worker = vi.fn(
      (
        requests: FileReadRequest[],
        onProgress?: (event: { key: string; loaded: number; total: number }) => void
      ) =>
        new Promise<Record<string, FileContentReadResult>>((resolve) => {
          activeWorkerQueues += 1;
          peakWorkerQueues = Math.max(peakWorkerQueues, activeWorkerQueues);
          completeWorkerQueues.push(() => {
            const results: Record<string, FileContentReadResult> = {};
            for (const request of requests) {
              results[request.compositeKey] = { content: 'fresh content', status: 'accessible' };
              onProgress?.({ key: request.compositeKey, loaded: 1, total: requests.length });
            }
            activeWorkerQueues -= 1;
            resolve(results);
          });
        })
    );
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => {
        const authority = useFileContentLoadAuthority();
        return { authority, loader: useSharedFileContentLoading(nodes) };
      },
      { wrapper }
    );
    const resolvePredecessors: Array<() => void> = [];
    for (const compositeKey of compositeKeys) {
      let resolvePredecessor: (() => void) | undefined;
      const predecessor = new Promise<void>((resolve) => {
        resolvePredecessor = resolve;
      });
      let trackedPredecessor: Promise<void>;
      trackedPredecessor = predecessor.finally(() => {
        result.current.authority.releaseActiveLoad([compositeKey], trackedPredecessor);
      });
      result.current.authority.trackActiveLoad([compositeKey], trackedPredecessor);
      resolvePredecessors.push(() => resolvePredecessor?.());
    }

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.loader.reloadFileContents(compositeKeys, 'background');
    });
    await act(async () => {
      for (const resolvePredecessor of resolvePredecessors) {
        resolvePredecessor();
      }
      await Promise.resolve();
    });

    for (let index = 0; index < compositeKeys.length; index += 1) {
      await waitFor(() => expect(completeWorkerQueues.length).toBeGreaterThan(index));
      await act(async () => {
        completeWorkerQueues[index]?.();
        await Promise.resolve();
      });
      if (index < compositeKeys.length - 1) {
        expect(result.current.loader.isLoading).toBe(true);
      }
    }
    await act(async () => {
      await reload;
    });

    expect(worker).toHaveBeenCalledTimes(20);
    expect(peakWorkerQueues).toBe(2);
  });

  it('resets hook-local loading state when the provider store identity changes', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/identity.txt', rootFolderId: 'root-identity' });
    const compositeKey = encodeFileSelection('root-identity', '/identity.txt');
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

    let oldLoad: Promise<void> | undefined;
    act(() => {
      oldLoad = result.current.loader.handleFileContentLoading([compositeKey], 'background');
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    storage = new MemoryStorageAdapter();
    rerender();
    const loadingImmediatelyAfterReplacement = new Set(result.current.loader.loadingFiles);
    let replacementLoad: Promise<void> | undefined;
    act(() => {
      replacementLoad = result.current.loader.handleFileContentLoading(
        [compositeKey],
        'background'
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const workerCallsAfterReplacement = pendingReads.length;

    await act(async () => {
      pendingReads[1]?.complete('fresh replacement content');
      pendingReads[0]?.complete('obsolete provider content');
      await Promise.allSettled([oldLoad, replacementLoad]);
    });

    expect(loadingImmediatelyAfterReplacement.size).toBe(0);
    expect(workerCallsAfterReplacement).toBe(2);
    expect(result.current.loader.loadingFiles.size).toBe(0);
    expect(result.current.loader.error).toBeNull();
    expect(result.current.store.getState().getFileContent(compositeKey)).toBe(
      'fresh replacement content'
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
      await result.current.handleFileContentLoading([compositeKey], 'background');
    });

    const request = worker.mock.calls[0]?.[0]?.[0];
    expect(request?.handle).toMatchObject({
      rootFolderId: 'selection-root',
      rootId: 'durable-authority-root',
    });
    expect(request?.handle?.rootId).not.toBe(request?.handle?.rootFolderId);
  });
});
