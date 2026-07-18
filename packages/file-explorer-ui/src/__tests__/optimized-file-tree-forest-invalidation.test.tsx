/**
 * Forest expansion invalidation scoping (#1734 perf follow-up).
 *
 * expandedDirectoryPaths is workspace-global; without root scoping, ANY
 * membership change (expanding one directory in one root) rebuilt the tree
 * rows of EVERY forest section. This test pins the scoped behavior: an
 * expansion toggle inside root A rebuilds only root A's rows.
 */
import type { IFileNode } from '@brainstrike/types';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import OptimizedFileTree, {
  fileTreeTelemetry,
  resetFileTreeTelemetry,
} from '../tree/optimized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

type FileExplorerStore = ReturnType<typeof useFileExplorerStoreContext>;

function StoreHandleBridge({ onStoreReady }: { onStoreReady: (store: FileExplorerStore) => void }) {
  const store = useFileExplorerStoreContext();
  useEffect(() => {
    onStoreReady(store);
  }, [onStoreReady, store]);
  return null;
}

function createFileNode(path: string, rootFolderId: string): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name,
    path,
    rootFolderId,
    selectionState: 'unchecked',
    type: 'file',
  };
}

function createRootTree(rootPath: string, rootFolderId: string): IFileNode[] {
  return [
    {
      children: [
        createFileNode(`${rootPath}/src/a.ts`, rootFolderId),
        createFileNode(`${rootPath}/src/b.ts`, rootFolderId),
      ],
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: 'src',
      path: `${rootPath}/src`,
      rootFolderId,
      selectionState: 'unchecked',
      type: 'directory',
    },
    createFileNode(`${rootPath}/readme.md`, rootFolderId),
  ];
}

describe('forest expansion invalidation scoping', () => {
  it('rebuilds only the affected root section when a directory expands', async () => {
    let fileExplorerStore: FileExplorerStore | null = null;
    const treeA = createRootTree('/workspace/alpha', 'rootA');
    const treeB = createRootTree('/workspace/beta', 'rootB');

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <StoreHandleBridge
            onStoreReady={(store) => {
              fileExplorerStore = store;
            }}
          />
          <OptimizedFileTree fileTree={treeA} folderId="rootA" loadingFiles={new Set()} />
          <OptimizedFileTree fileTree={treeB} folderId="rootB" loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      );
    });

    expect(fileExplorerStore).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded above
    const store = fileExplorerStore!;

    await act(async () => {
      store.getState().setActiveRoots([
        { displayName: 'alpha', path: '/workspace/alpha', rootId: 'rootA' },
        { displayName: 'beta', path: '/workspace/beta', rootId: 'rootB' },
      ]);
      await Promise.resolve();
    });

    resetFileTreeTelemetry();

    await act(async () => {
      store.getState().toggleDirectoryExpansion('/workspace/alpha/src');
      await Promise.resolve();
    });

    // Only root A's section rebuilds its rows; root B's scoped expansion
    // membership is unchanged, so its rows must not rebuild.
    expect(fileTreeTelemetry.treeRowsRebuildCount).toBe(1);
  });
});
