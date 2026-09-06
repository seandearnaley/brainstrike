/**
 * The per-provider bridge from FILE_EXPLORER_REFRESH_EVENT to the lazy tree:
 * watcher incremental events refresh only the LOADED parent directories of
 * structural changes in THIS provider's root (root reload awaited before any
 * per-directory refresh); manual full events refresh every provider EXCEPT
 * the panel's direct refresh authority (skipManualFullEvents). See the hook's
 * JSDoc for the filtering contract.
 */
import type { IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileExplorerRefreshEvent } from '../../shell/file-explorer-refresh-event';
import type { NormalizedFileTreeState } from '../../utils/normalized-file-tree';
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

function directoryNode(path: string, loadState: 'loaded' | 'unloaded'): IFileNode {
  return {
    children: [],
    depth: path.split('/').length - 2,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: ROOT_ID,
    selectionState: 'unchecked',
    type: 'directory',
  };
}

function fileNode(path: string): IFileNode {
  return {
    depth: path.split('/').length - 2,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: ROOT_ID,
    selectionState: 'unchecked',
    type: 'file',
  };
}

function buildNormalizedTree(): NormalizedFileTreeState {
  return createNormalizedFileTreeState([
    directoryNode(`${ROOT_PATH}/src`, 'loaded'),
    directoryNode(`${ROOT_PATH}/docs`, 'unloaded'),
  ]);
}

async function dispatchRefresh(
  detail: Parameters<typeof createFileExplorerRefreshEvent>[0]
): Promise<void> {
  await act(async () => {
    window.dispatchEvent(createFileExplorerRefreshEvent(detail));
  });
}

describe('useFileTreeRefreshEvents', () => {
  let normalizedTree: NormalizedFileTreeState;
  let reconcileSelectionWithDirectorySnapshots: ReturnType<
    typeof vi.fn<(snapshots: readonly FileTreeDirectorySnapshot[]) => void>
  >;
  let refreshDirectory: ReturnType<
    typeof vi.fn<(path: string) => Promise<FileTreeDirectorySnapshot | null>>
  >;
  let refreshTree: ReturnType<typeof vi.fn<() => Promise<FileTreeRefreshResult>>>;
  let getSelectionAncestorDirectories: ReturnType<typeof vi.fn<() => readonly string[]>>;
  let params: UseFileTreeRefreshEventsParams;

  beforeEach(() => {
    normalizedTree = buildNormalizedTree();
    reconcileSelectionWithDirectorySnapshots =
      vi.fn<(snapshots: readonly FileTreeDirectorySnapshot[]) => void>();
    refreshDirectory = vi
      .fn<(path: string) => Promise<FileTreeDirectorySnapshot | null>>()
      .mockImplementation(async (path) => ({ directoryPath: path, entries: [] }));
    refreshTree = vi
      .fn<() => Promise<FileTreeRefreshResult>>()
      .mockResolvedValue({ status: 'completed' });
    getSelectionAncestorDirectories = vi.fn<() => readonly string[]>().mockReturnValue([]);
    params = {
      getNormalizedTree: () => normalizedTree,
      getSelectionAncestorDirectories,
      getSelectionProjectionRevision: () => 0,
      reconcileSelectionWithDirectorySnapshots,
      refreshDirectory,
      refreshTree,
      rootId: ROOT_ID,
      rootPath: ROOT_PATH,
      skipManualFullEvents: false,
    } as UseFileTreeRefreshEventsParams;
  });

  it('refreshes the whole tree on a manual full refresh (forest sections)', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ['manual', { roots: [], scope: 'full' as const, source: 'manual' as const }],
    [
      'watcher',
      {
        roots: [{ changes: [], rootId: ROOT_ID, rootPath: ROOT_PATH }],
        scope: 'full' as const,
        source: 'watcher' as const,
      },
    ],
  ])(
    'revalidates selected nested ancestors after a shallow %s full root refresh',
    async (_label, detail) => {
      const srcPath = `${ROOT_PATH}/src`;
      const nestedPath = `${srcPath}/nested`;
      getSelectionAncestorDirectories.mockReturnValue([srcPath, nestedPath]);
      refreshTree.mockImplementation(async () => {
        normalizedTree = createNormalizedFileTreeState([directoryNode(srcPath, 'unloaded')]);
        return { status: 'completed' };
      });
      refreshDirectory.mockImplementation(async (path) => {
        if (path === srcPath) {
          const nested = directoryNode(nestedPath, 'unloaded');
          normalizedTree = createNormalizedFileTreeState([
            { ...directoryNode(srcPath, 'loaded'), children: [nested] },
          ]);
          return { directoryPath: srcPath, entries: [nested] };
        }
        if (path === nestedPath) {
          normalizedTree = createNormalizedFileTreeState([
            {
              ...directoryNode(srcPath, 'loaded'),
              children: [{ ...directoryNode(nestedPath, 'loaded'), children: [] }],
            },
          ]);
          return { directoryPath: nestedPath, entries: [] };
        }
        throw new Error(`Unexpected refresh path: ${path}`);
      });
      renderHook(() => useFileTreeRefreshEvents(params));

      await dispatchRefresh(detail);

      await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(2));
      expect(refreshDirectory.mock.calls.map(([path]) => path)).toEqual([srcPath, nestedPath]);
      expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ directoryPath: srcPath }),
        expect.objectContaining({ directoryPath: nestedPath }),
      ]);
    }
  );

  it('ignores manual full refreshes as the panel refresh authority (outer provider)', async () => {
    renderHook(() => useFileTreeRefreshEvents({ ...params, skipManualFullEvents: true }));

    await dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('refreshes only the loaded parent directory of watcher changes, deduped', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            { kind: 'file', path: `${ROOT_PATH}/src/new-a.ts`, type: 'added' },
            { kind: 'file', path: `${ROOT_PATH}/src/new-b.ts`, type: 'added' },
            { kind: 'directory', path: `${ROOT_PATH}/src/lib`, type: 'removed' },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).toHaveBeenCalledExactlyOnceWith(`${ROOT_PATH}/src`);
    expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledOnce();
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('publishes all refreshed directory snapshots as one reconciliation batch', async () => {
    normalizedTree = createNormalizedFileTreeState([
      directoryNode(`${ROOT_PATH}/src`, 'loaded'),
      directoryNode(`${ROOT_PATH}/test`, 'loaded'),
    ]);
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            { kind: 'file', path: `${ROOT_PATH}/src/gone.ts`, type: 'removed' },
            { kind: 'file', path: `${ROOT_PATH}/test/gone.test.ts`, type: 'removed' },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledExactlyOnceWith([
      { directoryPath: `${ROOT_PATH}/src`, entries: [] },
      { directoryPath: `${ROOT_PATH}/test`, entries: [] },
    ]);
  });

  it('waits for shallower authoritative reads before refreshing descendants', async () => {
    const srcPath = `${ROOT_PATH}/src`;
    const nestedPath = `${srcPath}/nested`;
    const nestedNode = directoryNode(nestedPath, 'loaded');
    normalizedTree = createNormalizedFileTreeState([
      { ...directoryNode(srcPath, 'loaded'), children: [nestedNode] },
    ]);
    let releaseFirstRefresh: (() => void) | null = null;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    refreshDirectory.mockImplementation(async (path) => {
      if (path === srcPath) {
        await firstRefreshGate;
      }
      return { directoryPath: path, entries: [] };
    });
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            { kind: 'file', path: `${srcPath}/gone.ts`, type: 'removed' },
            { kind: 'file', path: `${nestedPath}/gone.test.ts`, type: 'removed' },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    expect(refreshDirectory).toHaveBeenLastCalledWith(srcPath);
    expect(reconcileSelectionWithDirectorySnapshots).not.toHaveBeenCalled();

    act(() => {
      releaseFirstRefresh?.();
    });
    await waitFor(() => {
      expect(refreshDirectory).toHaveBeenCalledTimes(2);
      expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledOnce();
    });
    expect(refreshDirectory.mock.calls.map(([path]) => path)).toEqual([srcPath, nestedPath]);
  });

  it('bounds same-depth refresh concurrency while completing every path parent-first', async () => {
    const shallowPaths = Array.from({ length: 6 }, (_, index) => `${ROOT_PATH}/dir-${index}`);
    const deepPath = `${shallowPaths[0]}/nested`;
    const deepNode = directoryNode(deepPath, 'loaded');
    normalizedTree = createNormalizedFileTreeState([
      { ...directoryNode(shallowPaths[0] ?? '', 'loaded'), children: [deepNode] },
      ...shallowPaths.slice(1).map((path) => directoryNode(path, 'loaded')),
    ]);
    getSelectionAncestorDirectories.mockReturnValue([...shallowPaths, deepPath]);
    const firstFiveGates = shallowPaths.slice(0, 5).map(() => createDeferred<void>());
    let activeShallowReads = 0;
    let maxActiveShallowReads = 0;
    refreshDirectory.mockImplementation(async (path) => {
      if (shallowPaths.includes(path)) {
        activeShallowReads += 1;
        maxActiveShallowReads = Math.max(maxActiveShallowReads, activeShallowReads);
        const firstWaveIndex = shallowPaths.slice(0, 5).indexOf(path);
        if (firstWaveIndex >= 0) {
          await firstFiveGates[firstWaveIndex]?.promise;
        }
        activeShallowReads -= 1;
      }
      return { directoryPath: path, entries: [] };
    });
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(5));

    firstFiveGates[1]?.resolve();
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(6));

    expect(refreshDirectory.mock.calls[5]?.[0]).toBe(shallowPaths[5]);
    expect(refreshDirectory).not.toHaveBeenCalledWith(deepPath);
    expect(maxActiveShallowReads).toBe(5);

    for (const gate of firstFiveGates) {
      gate.resolve();
    }
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(7));

    expect(refreshDirectory.mock.calls.at(-1)?.[0]).toBe(deepPath);
    expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledOnce();
  });

  it('does not reconcile snapshots after the selection projection changes during their read', async () => {
    const srcPath = `${ROOT_PATH}/src`;
    let selectionProjectionRevision = 4;
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    refreshDirectory.mockImplementation(async (path) => {
      await refreshGate;
      return { directoryPath: path, entries: [] };
    });
    renderHook(() =>
      useFileTreeRefreshEvents({
        ...params,
        getSelectionProjectionRevision: () => selectionProjectionRevision,
      } as UseFileTreeRefreshEventsParams)
    );

    await dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: `${srcPath}/gone.ts`, type: 'removed' }],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    selectionProjectionRevision += 1;
    act(() => {
      releaseRefresh?.();
    });
    await act(async () => Promise.resolve());

    expect(reconcileSelectionWithDirectorySnapshots).not.toHaveBeenCalled();
  });

  it('does not turn an omitted-only Git freshness marker into tree I/O', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [],
          filteredChangeBoundaries: ['packages/app/dist'],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('skips changes whose parent directory is not loaded in the tree', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            { kind: 'file', path: `${ROOT_PATH}/docs/readme.md`, type: 'added' },
            { kind: 'file', path: `${ROOT_PATH}/unknown/deep/file.ts`, type: 'added' },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('refreshes an exact changed parent when an unloaded directory contains selected descendants', async () => {
    const docsPath = `${ROOT_PATH}/docs`;
    getSelectionAncestorDirectories.mockReturnValue([docsPath]);
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            { kind: 'file', path: `${docsPath}/selected-gone.md`, type: 'removed' },
            { kind: 'file', path: `${ROOT_PATH}/unknown/unselected.ts`, type: 'removed' },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).toHaveBeenCalledExactlyOnceWith(docsPath);
    expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledExactlyOnceWith([
      { directoryPath: docsPath, entries: [] },
    ]);
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('resolves a mixed-separator selected parent to its exact normalized-tree key', async () => {
    const windowsRoot = String.raw`C:\workspace`;
    const selectedParent = 'C:/workspace/src';
    normalizedTree = createNormalizedFileTreeState([
      { ...directoryNode(selectedParent, 'unloaded'), path: selectedParent },
    ]);
    getSelectionAncestorDirectories.mockReturnValue([selectedParent]);
    renderHook(() => useFileTreeRefreshEvents({ ...params, rootPath: windowsRoot }));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            {
              kind: 'file',
              path: String.raw`C:\workspace\src\selected-gone.ts`,
              type: 'removed',
            },
          ],
          rootId: ROOT_ID,
          rootPath: windowsRoot,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).toHaveBeenCalledExactlyOnceWith(selectedParent);
    expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledOnce();
  });

  it('refreshes the tree root when a root-level entry appears or disappears', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            { kind: 'file', path: `${ROOT_PATH}/new-root-file.ts`, type: 'added' },
            // A change reported for the root itself is also a root refresh.
            { kind: 'directory', path: ROOT_PATH, type: 'added' },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

  it('awaits the root reload before re-enumerating changed directories', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            { kind: 'file', path: `${ROOT_PATH}/root-file.ts`, type: 'added' },
            { kind: 'file', path: `${ROOT_PATH}/src/new.ts`, type: 'added' },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(refreshDirectory).toHaveBeenCalledExactlyOnceWith(`${ROOT_PATH}/src`);
    const treeOrder = refreshTree.mock.invocationCallOrder[0] ?? Number.NaN;
    const directoryOrder = refreshDirectory.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(treeOrder).toBeLessThan(directoryOrder);
  });

  it('force-refreshes a surviving directory after a mixed root and nested incremental batch', async () => {
    const srcPath = `${ROOT_PATH}/src`;
    normalizedTree = createNormalizedFileTreeState([directoryNode(srcPath, 'loaded')]);
    refreshTree.mockImplementation(async () => {
      // A real shallow root replacement retains src but resets it to unloaded.
      normalizedTree = createNormalizedFileTreeState([directoryNode(srcPath, 'unloaded')]);
      return { status: 'completed' };
    });
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [
            { kind: 'file', path: `${ROOT_PATH}/root-file.ts`, type: 'added' },
            { kind: 'file', path: `${srcPath}/nested-file.ts`, type: 'removed' },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledExactlyOnceWith(srcPath));
    expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledOnce();
  });

  it.each([
    ['removed', []],
    ['retyped as a file', [fileNode(`${ROOT_PATH}/src`)]],
  ])(
    'skips a mixed-batch directory that the root refresh proves was %s',
    async (_label, refreshedRootEntries) => {
      const srcPath = `${ROOT_PATH}/src`;
      normalizedTree = createNormalizedFileTreeState([directoryNode(srcPath, 'loaded')]);
      refreshTree.mockImplementation(async () => {
        normalizedTree = createNormalizedFileTreeState(refreshedRootEntries);
        return { status: 'completed' };
      });
      renderHook(() => useFileTreeRefreshEvents(params));

      await dispatchRefresh({
        roots: [
          {
            changes: [
              { kind: 'file', path: `${ROOT_PATH}/root-file.ts`, type: 'added' },
              { kind: 'file', path: `${srcPath}/nested-file.ts`, type: 'removed' },
            ],
            rootId: ROOT_ID,
            rootPath: ROOT_PATH,
          },
        ],
        scope: 'incremental',
        source: 'watcher',
      });

      await waitFor(() => expect(refreshTree).toHaveBeenCalledOnce());
      await act(async () => Promise.resolve());
      expect(refreshDirectory).not.toHaveBeenCalled();
      expect(reconcileSelectionWithDirectorySnapshots).not.toHaveBeenCalled();
    }
  );

  it('serializes separate watcher events for the same directory without dropping either event', async () => {
    const srcPath = `${ROOT_PATH}/src`;
    let releaseFirstRefresh: (() => void) | null = null;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    refreshDirectory.mockImplementation(async (path) => {
      if (refreshDirectory.mock.calls.length === 1) {
        await firstRefreshGate;
      }
      return { directoryPath: path, entries: [] };
    });
    renderHook(() => useFileTreeRefreshEvents(params));
    const eventDetail = {
      roots: [
        {
          changes: [
            { kind: 'file' as const, path: `${srcPath}/changed.ts`, type: 'removed' as const },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental' as const,
      source: 'watcher' as const,
    };

    await dispatchRefresh(eventDetail);
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    await dispatchRefresh(eventDetail);

    // The second event must queue behind the first instead of joining or
    // racing the same in-flight directory load.
    expect(refreshDirectory).toHaveBeenCalledOnce();

    act(() => {
      releaseFirstRefresh?.();
    });
    await waitFor(() => {
      expect(refreshDirectory).toHaveBeenCalledTimes(2);
      expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledTimes(2);
    });
  });

  it('retires queued and post-await watcher work when the provider unmounts', async () => {
    const srcPath = `${ROOT_PATH}/src`;
    let releaseFirstRefresh: (() => void) | null = null;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    refreshDirectory.mockImplementation(async (path) => {
      if (refreshDirectory.mock.calls.length === 1) {
        await firstRefreshGate;
      }
      return { directoryPath: path, entries: [] };
    });
    const { unmount } = renderHook(() => useFileTreeRefreshEvents(params));
    const eventDetail = {
      roots: [
        {
          changes: [
            { kind: 'file' as const, path: `${srcPath}/changed.ts`, type: 'removed' as const },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental' as const,
      source: 'watcher' as const,
    };

    await dispatchRefresh(eventDetail);
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    await dispatchRefresh(eventDetail);
    expect(refreshDirectory).toHaveBeenCalledOnce();

    unmount();
    await act(async () => {
      releaseFirstRefresh?.();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    expect(refreshDirectory).toHaveBeenCalledOnce();
    expect(reconcileSelectionWithDirectorySnapshots).not.toHaveBeenCalled();
  });

  it('drains started peers before advancing the serialized queue after a refresh failure', async () => {
    const srcPath = `${ROOT_PATH}/src`;
    const testPath = `${ROOT_PATH}/test`;
    normalizedTree = createNormalizedFileTreeState([
      directoryNode(srcPath, 'loaded'),
      directoryNode(testPath, 'loaded'),
    ]);
    const heldPeer = createDeferred<void>();
    let rejectFailingPeer: ((error: Error) => void) | null = null;
    const failingPeer = new Promise<never>((_resolve, reject) => {
      rejectFailingPeer = reject;
    });
    let srcReadCount = 0;
    refreshDirectory.mockImplementation(async (path) => {
      if (path === srcPath) {
        srcReadCount += 1;
        if (srcReadCount === 1) {
          await heldPeer.promise;
        }
        return { directoryPath: path, entries: [] };
      }
      if (path === testPath) {
        return failingPeer;
      }
      throw new Error(`Unexpected refresh path: ${path}`);
    });
    renderHook(() => useFileTreeRefreshEvents(params));
    const firstEventDetail = {
      roots: [
        {
          changes: [
            { kind: 'file' as const, path: `${srcPath}/changed.ts`, type: 'removed' as const },
            {
              kind: 'file' as const,
              path: `${testPath}/changed.test.ts`,
              type: 'removed' as const,
            },
          ],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental' as const,
      source: 'watcher' as const,
    };
    const secondEventDetail = {
      roots: [
        {
          changes: [{ kind: 'file' as const, path: `${srcPath}/later.ts`, type: 'added' as const }],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental' as const,
      source: 'watcher' as const,
    };

    await dispatchRefresh(firstEventDetail);
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(2));
    await dispatchRefresh(secondEventDetail);
    expect(refreshDirectory).toHaveBeenCalledTimes(2);

    act(() => {
      rejectFailingPeer?.(new Error('first refresh failed'));
    });
    await act(async () => Promise.resolve());

    // The second event stays queued while the first event's already-started
    // src read is still live, and no unstarted work is assigned after failure.
    expect(refreshDirectory).toHaveBeenCalledTimes(2);

    heldPeer.resolve();
    await waitFor(() => {
      expect(refreshDirectory).toHaveBeenCalledTimes(3);
      expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledOnce();
    });
    expect(refreshDirectory.mock.calls[2]?.[0]).toBe(srcPath);
  });

  it('ignores watcher changes that belong to a different root', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: '/elsewhere/src/a.ts', type: 'added' }],
          rootId: 'other-root',
          rootPath: '/elsewhere',
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('never path-matches across durable root ids (same-named web roots)', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    // Same rootPath, different durable id — a sibling web root sharing a name.
    await dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: `${ROOT_PATH}/src/a.ts`, type: 'added' }],
          rootId: 'root-uuid-2',
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('path-matches only for legacy roots without a durable id', async () => {
    renderHook(() => useFileTreeRefreshEvents({ ...params, rootId: null }));

    await dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: `${ROOT_PATH}/src/a.ts`, type: 'added' }],
          rootId: 'watcher-side-id',
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).toHaveBeenCalledExactlyOnceWith(`${ROOT_PATH}/src`);
  });

  it('fully re-enumerates the root on a watcher OVERFLOW (full) event for a named root', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [{ changes: [], rootId: ROOT_ID, rootPath: ROOT_PATH }],
      scope: 'full',
      source: 'watcher',
    });

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

  it('reacts to a watcher OVERFLOW even as the panel refresh authority (unlike manual/full)', async () => {
    // skipManualFullEvents suppresses manual/full (button refreshes directly),
    // but an overflow is dispatched with no direct refresh — the authority
    // provider MUST react or a single-root workspace never reloads.
    renderHook(() => useFileTreeRefreshEvents({ ...params, skipManualFullEvents: true }));

    await dispatchRefresh({
      roots: [{ changes: [], rootId: ROOT_ID, rootPath: ROOT_PATH }],
      scope: 'full',
      source: 'watcher',
    });

    expect(refreshTree).toHaveBeenCalledOnce();
  });

  it('ignores a watcher OVERFLOW that names only a different root', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [{ changes: [], rootId: 'other-root', rootPath: '/elsewhere' }],
      scope: 'full',
      source: 'watcher',
    });

    expect(refreshTree).not.toHaveBeenCalled();
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

  it('ignores pure content modifications (no structural change)', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: `${ROOT_PATH}/src/existing.ts`, type: 'modified' }],
          rootId: ROOT_ID,
          rootPath: ROOT_PATH,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('does nothing without a mounted root', async () => {
    renderHook(() => useFileTreeRefreshEvents({ ...params, rootId: null, rootPath: null }));

    await dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('stops listening after unmount', async () => {
    const { unmount } = renderHook(() => useFileTreeRefreshEvents(params));
    unmount();

    await dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('matches windows-style separators when deriving the parent directory', async () => {
    const winRoot = String.raw`C:\workspace`;
    const winTree = createNormalizedFileTreeState([
      {
        ...directoryNode('placeholder', 'loaded'),
        name: 'src',
        path: String.raw`C:\workspace\src`,
      },
    ]);
    renderHook(() =>
      useFileTreeRefreshEvents({
        ...params,
        getNormalizedTree: () => winTree,
        rootPath: winRoot,
      })
    );

    await dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: String.raw`C:\workspace\src\new.ts`, type: 'added' }],
          rootId: ROOT_ID,
          rootPath: winRoot,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshDirectory).toHaveBeenCalledExactlyOnceWith(String.raw`C:\workspace\src`);
  });

  it('treats a child of a Windows drive root as a root-level structural change', async () => {
    const driveRoot = 'C:\\';
    renderHook(() =>
      useFileTreeRefreshEvents({
        ...params,
        getNormalizedTree: () => createNormalizedFileTreeState([]),
        rootPath: driveRoot,
      })
    );

    await dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: `${driveRoot}new.ts`, type: 'added' }],
          rootId: ROOT_ID,
          rootPath: driveRoot,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(refreshDirectory).not.toHaveBeenCalled();
  });
});
