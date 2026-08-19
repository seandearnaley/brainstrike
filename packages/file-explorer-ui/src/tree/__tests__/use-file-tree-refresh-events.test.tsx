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

  it('refreshes authoritative directories sequentially before one reconciliation publication', async () => {
    normalizedTree = createNormalizedFileTreeState([
      directoryNode(`${ROOT_PATH}/src`, 'loaded'),
      directoryNode(`${ROOT_PATH}/test`, 'loaded'),
    ]);
    let releaseFirstRefresh: (() => void) | null = null;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    refreshDirectory.mockImplementation(async (path) => {
      if (path === `${ROOT_PATH}/src`) {
        await firstRefreshGate;
      }
      return { directoryPath: path, entries: [] };
    });
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

    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    expect(refreshDirectory).toHaveBeenLastCalledWith(`${ROOT_PATH}/src`);
    expect(reconcileSelectionWithDirectorySnapshots).not.toHaveBeenCalled();

    act(() => {
      releaseFirstRefresh?.();
    });
    await waitFor(() => {
      expect(refreshDirectory).toHaveBeenCalledTimes(2);
      expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledOnce();
    });
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

  it('continues the serialized event queue after a refresh failure', async () => {
    const srcPath = `${ROOT_PATH}/src`;
    let rejectFirstRefresh: ((error: Error) => void) | null = null;
    const firstRefreshGate = new Promise<never>((_resolve, reject) => {
      rejectFirstRefresh = reject;
    });
    refreshDirectory
      .mockImplementationOnce(async () => firstRefreshGate)
      .mockImplementationOnce(async (path) => ({ directoryPath: path, entries: [] }));
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
    expect(refreshDirectory).toHaveBeenCalledOnce();

    act(() => {
      rejectFirstRefresh?.(new Error('first refresh failed'));
    });
    await waitFor(() => {
      expect(refreshDirectory).toHaveBeenCalledTimes(2);
      expect(reconcileSelectionWithDirectorySnapshots).toHaveBeenCalledOnce();
    });
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
});
