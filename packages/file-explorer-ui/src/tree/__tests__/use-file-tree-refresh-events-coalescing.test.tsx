import type { IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileExplorerRefreshEvent } from '../../shell/file-explorer-refresh-event';
import { createNormalizedFileTreeState } from '../../utils/normalized-file-tree';
import {
  type UseFileTreeRefreshEventsParams,
  useFileTreeRefreshEvents,
} from '../use-file-tree-refresh-events';
import type { FileTreeDirectorySnapshot, FileTreeRefreshResult } from '../use-lazy-file-tree';

const ROOT_PATH = '/workspace';
const ROOT_ID = 'root-uuid-1';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function directoryNode(path: string): IFileNode {
  return {
    children: [],
    depth: path.split('/').length - 2,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'loaded',
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: ROOT_ID,
    selectionState: 'unchecked',
    type: 'directory',
  };
}

async function dispatchRefresh(
  detail: Parameters<typeof createFileExplorerRefreshEvent>[0]
): Promise<void> {
  await act(async () => {
    window.dispatchEvent(createFileExplorerRefreshEvent(detail));
  });
}

describe('useFileTreeRefreshEvents full-refresh coalescing', () => {
  let reconcileSelectionWithDirectorySnapshots: ReturnType<
    typeof vi.fn<(snapshots: readonly FileTreeDirectorySnapshot[]) => void>
  >;
  let refreshDirectory: ReturnType<
    typeof vi.fn<(path: string) => Promise<FileTreeDirectorySnapshot | null>>
  >;
  let refreshTree: ReturnType<typeof vi.fn<() => Promise<FileTreeRefreshResult>>>;
  let params: UseFileTreeRefreshEventsParams;

  beforeEach(() => {
    const normalizedTree = createNormalizedFileTreeState([directoryNode(`${ROOT_PATH}/src`)]);
    reconcileSelectionWithDirectorySnapshots =
      vi.fn<(snapshots: readonly FileTreeDirectorySnapshot[]) => void>();
    refreshDirectory = vi
      .fn<(path: string) => Promise<FileTreeDirectorySnapshot | null>>()
      .mockImplementation(async (path) => ({ directoryPath: path, entries: [] }));
    refreshTree = vi
      .fn<() => Promise<FileTreeRefreshResult>>()
      .mockResolvedValue({ status: 'completed' });
    params = {
      getNormalizedTree: () => normalizedTree,
      getSelectionAncestorDirectories: () => [],
      getSelectionProjectionRevision: () => 0,
      reconcileSelectionWithDirectorySnapshots,
      refreshDirectory,
      refreshTree,
      rootId: ROOT_ID,
      rootPath: ROOT_PATH,
      skipManualFullEvents: false,
    };
  });

  it('coalesces a full-refresh burst into one trailing physical refresh with truthful joined outcomes', async () => {
    const activeRefresh = createDeferred<FileTreeRefreshResult>();
    refreshTree
      .mockImplementationOnce(() => activeRefresh.promise)
      .mockResolvedValue({ status: 'cancelled' });
    const { result } = renderHook(() => useFileTreeRefreshEvents(params));

    let activeOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({ status: 'cancelled' });
    act(() => {
      activeOutcome = result.current();
    });
    await waitFor(() => expect(refreshTree).toHaveBeenCalledOnce());

    await dispatchRefresh({
      roots: [{ changes: [], rootId: ROOT_ID, rootPath: ROOT_PATH }],
      scope: 'full',
      source: 'watcher',
    });
    let firstJoinedOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({
      status: 'cancelled',
    });
    let secondJoinedOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({
      status: 'cancelled',
    });
    act(() => {
      firstJoinedOutcome = result.current();
      secondJoinedOutcome = result.current();
    });
    await dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).toHaveBeenCalledOnce();
    activeRefresh.resolve({ status: 'completed' });

    const outcomes = await act(async () =>
      Promise.all([activeOutcome, firstJoinedOutcome, secondJoinedOutcome])
    );
    await waitFor(() => expect(refreshTree).toHaveBeenCalledTimes(2));
    expect(outcomes).toEqual([
      { status: 'completed' },
      { status: 'cancelled' },
      { status: 'cancelled' },
    ]);
  });

  it('does not coalesce full refreshes across an incremental mutation boundary', async () => {
    const activeRefresh = createDeferred<FileTreeRefreshResult>();
    refreshTree
      .mockImplementationOnce(() => activeRefresh.promise)
      .mockResolvedValue({ status: 'completed' });
    const { result } = renderHook(() => useFileTreeRefreshEvents(params));

    let activeOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({ status: 'cancelled' });
    act(() => {
      activeOutcome = result.current();
    });
    await waitFor(() => expect(refreshTree).toHaveBeenCalledOnce());
    await dispatchRefresh({
      roots: [{ changes: [], rootId: ROOT_ID, rootPath: ROOT_PATH }],
      scope: 'full',
      source: 'watcher',
    });
    await dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: `${ROOT_PATH}/src/changed.ts`, type: 'removed' }],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });
    let postMutationOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({
      status: 'cancelled',
    });
    act(() => {
      postMutationOutcome = result.current();
    });

    activeRefresh.resolve({ status: 'completed' });
    await act(async () => {
      await Promise.all([activeOutcome, postMutationOutcome]);
    });
    await waitFor(() => {
      expect(refreshTree).toHaveBeenCalledTimes(3);
      expect(refreshDirectory).toHaveBeenCalledExactlyOnceWith(`${ROOT_PATH}/src`);
    });

    const firstTrailingFullOrder = refreshTree.mock.invocationCallOrder[1] ?? Number.NaN;
    const incrementalOrder = refreshDirectory.mock.invocationCallOrder[0] ?? Number.NaN;
    const postMutationFullOrder = refreshTree.mock.invocationCallOrder[2] ?? Number.NaN;
    expect(firstTrailingFullOrder).toBeLessThan(incrementalOrder);
    expect(incrementalOrder).toBeLessThan(postMutationFullOrder);
  });

  it('settles active and trailing direct full callers as cancelled after provider cleanup', async () => {
    const activeRefresh = createDeferred<FileTreeRefreshResult>();
    refreshTree.mockImplementationOnce(() => activeRefresh.promise);
    const { result, unmount } = renderHook(() => useFileTreeRefreshEvents(params));

    let activeOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({ status: 'completed' });
    act(() => {
      activeOutcome = result.current();
    });
    await waitFor(() => expect(refreshTree).toHaveBeenCalledOnce());
    let trailingOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({ status: 'completed' });
    act(() => {
      trailingOutcome = result.current();
    });

    unmount();
    activeRefresh.resolve({ status: 'completed' });
    const outcomes = await act(async () => Promise.all([activeOutcome, trailingOutcome]));

    expect(outcomes).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(refreshTree).toHaveBeenCalledOnce();
    expect(reconcileSelectionWithDirectorySnapshots).not.toHaveBeenCalled();
  });

  it('retires coalesced work for an old durable root before refreshing a same-path replacement', async () => {
    const activeRefresh = createDeferred<FileTreeRefreshResult>();
    refreshTree.mockImplementationOnce(() => activeRefresh.promise);
    const replacementRefresh = vi
      .fn<() => Promise<FileTreeRefreshResult>>()
      .mockResolvedValue({ status: 'completed' });
    const { result, rerender } = renderHook(
      ({ currentParams }: { currentParams: UseFileTreeRefreshEventsParams }) =>
        useFileTreeRefreshEvents(currentParams),
      { initialProps: { currentParams: params } }
    );

    let activeOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({ status: 'completed' });
    act(() => {
      activeOutcome = result.current();
    });
    await waitFor(() => expect(refreshTree).toHaveBeenCalledOnce());
    let oldRootTrailingOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({
      status: 'completed',
    });
    act(() => {
      oldRootTrailingOutcome = result.current();
    });

    rerender({
      currentParams: {
        ...params,
        refreshTree: replacementRefresh,
        rootId: 'root-uuid-2',
      },
    });
    let replacementOutcome: Promise<FileTreeRefreshResult> = Promise.resolve({
      status: 'cancelled',
    });
    act(() => {
      replacementOutcome = result.current();
    });

    activeRefresh.resolve({ status: 'completed' });
    const outcomes = await act(async () =>
      Promise.all([activeOutcome, oldRootTrailingOutcome, replacementOutcome])
    );

    expect(outcomes).toEqual([
      { status: 'cancelled' },
      { status: 'cancelled' },
      { status: 'completed' },
    ]);
    expect(refreshTree).toHaveBeenCalledOnce();
    expect(replacementRefresh).toHaveBeenCalledOnce();
  });
});
