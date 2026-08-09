/**
 * How many FULL projection rebuild+sorts does one structural change cost, on a
 * projection big enough for the answer to matter? (whole-branch review F4.)
 *
 * `explorer-sort-rebuild-loop.test.tsx` pins that the order SETTLES and that
 * mounting a 5-node tree costs ≤4 rebuilds. It cannot answer this: the loop
 * guard is about termination, and 5 nodes hide the cost of the passes that do
 * happen. With a metadata sort active every rebuild re-sorts the whole
 * projection, so the multiplier is what turns a 10k-row expand/collapse from
 * one sort into three.
 *
 * Integration lane on purpose: this mounts ~10k real rows and reports
 * wall-clock, which is CPU-contention sensitive under a full parallel turbo
 * run. The ASSERTIONS are on the rebuild COUNT (deterministic); the timings are
 * reported for the record.
 */
import { useExplorerSortStateStore } from '@brainstrike/app-state/stores/explorer-sort-state-store';
import type { IFileNode } from '@brainstrike/types';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useExplorerRowMetadata } from '../indexing/file-row-metadata-context';
import { FileRowMetadataProvider } from '../indexing/file-row-metadata-provider';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { ExplorerColumnsProvider } from '../shell/explorer-columns-provider';
import { ExplorerSortProvider } from '../shell/explorer-sort-provider';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import OptimizedFileTree, { fileTreeTelemetry } from '../tree/optimized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

/**
 * TRUE projection builds, not commits. `fileTreeTelemetry.treeRowsRebuildCount`
 * increments in an effect, so React coalescing two renders into one commit
 * reports 1 where the memo — and therefore the whole sort — ran twice. The
 * thing that costs is the memo.
 */
let projectionBuildCount = 0;

vi.mock('../tree/optimized-file-tree-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tree/optimized-file-tree-model')>();
  return {
    ...actual,
    buildFileTreeRows: (
      ...args: Parameters<typeof actual.buildFileTreeRows>
    ): ReturnType<typeof actual.buildFileTreeRows> => {
      projectionBuildCount += 1;
      return actual.buildFileTreeRows(...args);
    },
  };
});

const ROOT = 'root';
const DIRECTORY_COUNT = 100;
const FILES_PER_DIRECTORY = 100;
const TOTAL_ROWS = DIRECTORY_COUNT * (FILES_PER_DIRECTORY + 1);

let tokensByPath: Record<string, number>;

vi.mock('../indexing/token-cache-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../indexing/token-cache-context')>();
  return {
    ...actual,
    useOptionalTokenCacheContext: (): TokenCacheContextValue =>
      ({
        cacheVersion: 1,
        getFileSize: () => undefined,
        getTokenCount: (_folderId: string, path: string) => tokensByPath[path] ?? null,
        isOperational: true,
      }) as unknown as TokenCacheContextValue,
  };
});

function buildLargeTree(): { expanded: Set<string>; tree: IFileNode[] } {
  const expanded = new Set<string>();
  const tree: IFileNode[] = [];
  tokensByPath = {};
  for (let directoryIndex = 0; directoryIndex < DIRECTORY_COUNT; directoryIndex += 1) {
    const directoryPath = `/dir-${directoryIndex.toString().padStart(3, '0')}`;
    expanded.add(directoryPath);
    const children: IFileNode[] = [];
    for (let fileIndex = 0; fileIndex < FILES_PER_DIRECTORY; fileIndex += 1) {
      const path = `${directoryPath}/file-${fileIndex.toString().padStart(3, '0')}.ts`;
      tokensByPath[path] = (directoryIndex * 31 + fileIndex * 7) % 997;
      children.push({
        depth: 1,
        handle: {} as FileSystemFileHandle,
        isVisible: true,
        name: path.split('/').at(-1) ?? path,
        path,
        rootFolderId: ROOT,
        selectionState: 'unchecked',
        size: fileIndex * 13,
        type: 'file',
      });
    }
    tree.push({
      children,
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: directoryPath.slice(1),
      path: directoryPath,
      rootFolderId: ROOT,
      selectionState: 'unchecked',
      type: 'directory',
    });
  }
  return { expanded, tree };
}

const { expanded: EXPANDED, tree: LARGE_TREE } = buildLargeTree();

let capturedStore: { getFolderRevision: (folderId: string) => number } | null = null;
let explorerStore: ReturnType<typeof useFileExplorerStoreContext> | null = null;

function Harness() {
  const rowMetadata = useExplorerRowMetadata();
  capturedStore = rowMetadata.contextValue.store;
  explorerStore = useFileExplorerStoreContext();
  return (
    <ExplorerSortProvider>
      <FileRowMetadataProvider value={rowMetadata.contextValue}>
        <ExplorerColumnsProvider
          value={{
            areMetadataColumnsSuppressed: false,
            columnWidths: { size: 76, tokens: 76, type: 72 },
            visibleMetadataColumnIds: ['type', 'tokens', 'size'],
          }}
        >
          <OptimizedFileTree
            fileTree={LARGE_TREE}
            folderId={ROOT}
            loadingFiles={new Set()}
            showColumnHeader={true}
          />
        </ExplorerColumnsProvider>
      </FileRowMetadataProvider>
    </ExplorerSortProvider>
  );
}

async function runMacrotask(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function settle(): Promise<void> {
  for (let macrotask = 0; macrotask < 6; macrotask += 1) {
    await runMacrotask();
  }
}

describe('Explorer metadata sort — structural-change cost at 10k rows', () => {
  beforeEach(() => {
    useExplorerSortStateStore.getState().reset();
  });

  it('costs a BOUNDED number of full rebuild+sorts per structural change', async () => {
    useExplorerSortStateStore.getState().setSortState({ direction: 'desc', field: 'tokens' });

    // Expansion is workspace state, not a prop — driving it any other way does
    // not produce a structural change at all.
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <Harness />
        </FileExplorerTestWrapper>
      );
    });
    const mountStartedAt = performance.now();
    await act(async () => {
      explorerStore?.getState().setExpandedPaths(new Set(EXPANDED));
    });
    await settle();
    const mountMs = performance.now() - mountStartedAt;
    const rebuildsAfterMount = fileTreeTelemetry.treeRowsRebuildCount;
    const buildsAfterMount = projectionBuildCount;
    const revisionAfterMount = capturedStore?.getFolderRevision(ROOT) ?? -1;

    // COLLAPSE one directory — a real structural change: the row set shrinks by
    // 100 rows and the structure revision moves.
    const collapsed = new Set(EXPANDED);
    collapsed.delete('/dir-000');
    const collapseStartedAt = performance.now();
    await act(async () => {
      explorerStore?.getState().setExpandedPaths(collapsed);
    });
    await settle();
    const collapseMs = performance.now() - collapseStartedAt;
    const collapseRebuilds = fileTreeTelemetry.treeRowsRebuildCount - rebuildsAfterMount;
    const collapseBuilds = projectionBuildCount - buildsAfterMount;
    const revisionAfterCollapse = capturedStore?.getFolderRevision(ROOT) ?? -1;
    // Sanity: the folder-revision channel MUST be live, or this test would be
    // measuring a tree that never subscribed to metadata at all.
    expect(revisionAfterCollapse).toBeGreaterThan(revisionAfterMount);

    // …and EXPAND it again.
    const expandStartedAt = performance.now();
    await act(async () => {
      explorerStore?.getState().setExpandedPaths(new Set(EXPANDED));
    });
    await settle();
    const expandMs = performance.now() - expandStartedAt;
    const expandRebuilds =
      fileTreeTelemetry.treeRowsRebuildCount - rebuildsAfterMount - collapseRebuilds;
    const expandBuilds = projectionBuildCount - buildsAfterMount - collapseBuilds;

    // Quiet afterwards: the ring stays closed at this size too.
    const rebuildsAtRest = fileTreeTelemetry.treeRowsRebuildCount;
    await settle();
    expect(fileTreeTelemetry.treeRowsRebuildCount).toBe(rebuildsAtRest);

    // MEASURED on this 10,100-row projection (dev machine, integration lane):
    //
    //   before F4: collapse 3 builds, expand 3 builds  (mount 5)
    //   after  F4: collapse 2 builds, expand 2 builds  (mount 5)
    //
    // The COUNT is the signal; the wall-clock in the console line swings 2-3x
    // with CPU contention on this machine and is reported, never asserted.
    //
    // The removed pass is the deferred rollup flush's: it used to bump the
    // per-root sort revision unconditionally, and a collapse/expand re-resolves
    // the SAME totals, so the whole projection was re-sorted for nothing. The
    // two that remain are honest — the structural rebuild itself, and the
    // seam's `invalidateAll` reconciliation, whose per-root bump cannot be
    // narrowed to observed changes (the comparator reads file values the store
    // deliberately does not cache; see `subscribeFolder`). Removing THAT one
    // needs a different design, not a cheaper condition.
    expect(collapseBuilds).toBeLessThanOrEqual(2);
    expect(expandBuilds).toBeLessThanOrEqual(2);

    console.info(
      `BST-1209 structural-cost telemetry: rows=${TOTAL_ROWS} mountMs=${mountMs.toFixed(1)} mountBuilds=${buildsAfterMount} mountCommits=${rebuildsAfterMount} collapseMs=${collapseMs.toFixed(1)} collapseBuilds=${collapseBuilds} collapseCommits=${collapseRebuilds} expandMs=${expandMs.toFixed(1)} expandBuilds=${expandBuilds} expandCommits=${expandRebuilds}`
    );
  });
});
