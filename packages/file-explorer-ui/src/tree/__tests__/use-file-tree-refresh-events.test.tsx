/**
 * The per-provider bridge from FILE_EXPLORER_REFRESH_EVENT to the lazy tree:
 * watcher incremental events refresh only the LOADED parent directories of
 * structural changes in THIS provider's root; manual full events refresh the
 * whole tree (every provider — forest roots included). See the hook's JSDoc
 * for the filtering contract.
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

function dispatchRefresh(detail: Parameters<typeof createFileExplorerRefreshEvent>[0]): void {
  act(() => {
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
    };
  });

  it('refreshes the whole tree on a manual full refresh (forest roots included)', () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

  it('skips the manual full refresh when the dispatcher already refreshed this root', () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    dispatchRefresh({
      refreshedRootIds: [ROOT_ID],
      roots: [],
      scope: 'full',
      source: 'manual',
    });
    expect(refreshTree).not.toHaveBeenCalled();

    dispatchRefresh({
      refreshedRootIds: ['some-other-root'],
      roots: [],
      scope: 'full',
      source: 'manual',
    });
    expect(refreshTree).toHaveBeenCalledOnce();
  });

  it('refreshes only the loaded parent directory of watcher changes, deduped', () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    dispatchRefresh({
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

  it('skips changes whose parent directory is not loaded in the tree', () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    dispatchRefresh({
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

  it('refreshes the tree root when a root-level entry appears or disappears', () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    dispatchRefresh({
      roots: [
        {
          changes: [{ kind: 'file', path: `${ROOT_PATH}/new-root-file.ts`, type: 'added' }],
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

  it('ignores watcher changes that belong to a different root', () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    dispatchRefresh({
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

  it('ignores pure content modifications (no structural change)', () => {
    renderHook(() => useFileTreeRefreshEvents(params));

    dispatchRefresh({
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

  it('does nothing without a mounted root', () => {
    renderHook(() => useFileTreeRefreshEvents({ ...params, rootId: null, rootPath: null }));

    dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('stops listening after unmount', () => {
    const { unmount } = renderHook(() => useFileTreeRefreshEvents(params));
    unmount();

    dispatchRefresh({ roots: [], scope: 'full', source: 'manual' });

    expect(refreshTree).not.toHaveBeenCalled();
  });

  it('matches windows-style separators when deriving the parent directory', () => {
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

    dispatchRefresh({
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
