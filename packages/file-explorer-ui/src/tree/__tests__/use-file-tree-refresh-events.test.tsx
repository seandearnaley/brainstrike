/**
 * The per-provider bridge from FILE_EXPLORER_REFRESH_EVENT to the lazy tree:
 * watcher incremental events refresh only the LOADED parent directories of
 * structural changes in THIS provider's root (root reload awaited before any
 * per-directory refresh); manual full events refresh every provider EXCEPT
 * the panel's direct refresh authority (skipManualFullEvents). See the hook's
 * JSDoc for the filtering contract.
 */
import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileExplorerRefreshEvent } from '../../shell/file-explorer-refresh-event';
import type { NormalizedFileTreeState } from '../../utils/normalized-file-tree';
import { createNormalizedFileTreeState } from '../../utils/normalized-file-tree';
import {
  type UseFileTreeRefreshEventsParams,
  useFileTreeRefreshEvents,
} from '../use-file-tree-refresh-events';
import type { FileTreeRefreshResult } from '../use-lazy-file-tree';

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
  let refreshDirectory: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
  let refreshTree: ReturnType<typeof vi.fn<() => Promise<FileTreeRefreshResult>>>;
  let params: UseFileTreeRefreshEventsParams;

  beforeEach(() => {
    normalizedTree = buildNormalizedTree();
    refreshDirectory = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);
    refreshTree = vi
      .fn<() => Promise<FileTreeRefreshResult>>()
      .mockResolvedValue({ status: 'completed' });
    params = {
      getNormalizedTree: () => normalizedTree,
      refreshDirectory,
      refreshTree,
      rootId: ROOT_ID,
      rootPath: ROOT_PATH,
      skipManualFullEvents: false,
    };
  });

  it('refreshes the whole tree on a manual full refresh (forest sections)', async () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    await dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

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
