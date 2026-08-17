/**
 * The sorted row order must SETTLE (BST-1209 review, critical finding).
 *
 * Sorting by a metadata field while directory rows are on screen wires three
 * mechanisms into a ring:
 *
 *   sorted order changes → new row-array identity → the metadata source's
 *   structural effect clears its rollup cache and calls `invalidateAll` →
 *   rollups flip complete→partial → the per-root revision bumps → the sort
 *   options memo recomputes → rows rebuild → directories reorder into the
 *   absent group → new row-array identity → …
 *
 * with the queued rollup flush restoring the complete totals one macrotask
 * later and pushing the order back. Left unbroken that is a continuous
 * row-order flicker, once per macrotask, forever.
 *
 * These tests are the guard: with a directory-containing tree sorted by tokens,
 * the order and the rebuild counter must both go quiet within a bounded number
 * of macrotasks and stay quiet.
 */

import { useExplorerSortStateStore } from '@brainstrike/app-state/stores/explorer-sort-state-store';
import type { IFileNode } from '@brainstrike/types';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useExplorerRowMetadata } from '../indexing/file-row-metadata-context';
import { FileRowMetadataProvider } from '../indexing/file-row-metadata-provider';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { ExplorerColumnsProvider } from '../shell/explorer-columns-provider';
import { ExplorerSortProvider } from '../shell/explorer-sort-provider';
import { fileTreeTelemetry } from '../tree/file-tree-telemetry-counters';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

const ROOT = 'root';

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

function file(path: string, size: number): IFileNode {
  return {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: ROOT,
    selectionState: 'unchecked',
    size,
    type: 'file',
  };
}

function directory(path: string, children: IFileNode[]): IFileNode {
  return {
    children,
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'loaded',
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: ROOT,
    selectionState: 'unchecked',
    type: 'directory',
  };
}

/** Two sibling directories plus loose files: the shape that closed the ring. */
const MIXED_TREE: IFileNode[] = [
  directory('/alpha', [file('/alpha/one.ts', 100), file('/alpha/two.ts', 20)]),
  directory('/beta', [file('/beta/three.ts', 5)]),
  file('/notes.txt', 42),
  file('/readme.md', 7),
];

function Harness() {
  const rowMetadata = useExplorerRowMetadata();
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
            fileTree={MIXED_TREE}
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

function rowOrder(): string {
  return screen
    .getAllByRole('row')
    .map((row) => row.getAttribute('data-node-id'))
    .filter((nodeId): nodeId is string => nodeId !== null)
    .join(',');
}

describe('Explorer metadata sort — rebuild settling', () => {
  beforeEach(() => {
    tokensByPath = {
      '/alpha/one.ts': 10,
      '/alpha/two.ts': 5,
      '/beta/three.ts': 3,
      '/notes.txt': 1,
      '/readme.md': 2,
    };
    useExplorerSortStateStore.getState().reset();
  });

  it('settles the row order within a bounded number of macrotasks', async () => {
    useExplorerSortStateStore.getState().setSortState({ direction: 'asc', field: 'tokens' });
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <Harness />
        </FileExplorerTestWrapper>
      );
    });

    // Generous settling budget: the honest cost of a first paint is one
    // deferred rollup flush plus the one re-sort it earns.
    for (let macrotask = 0; macrotask < 4; macrotask += 1) {
      await runMacrotask();
    }

    const settledOrder = rowOrder();
    const rebuildsAtRest = fileTreeTelemetry.treeRowsRebuildCount;
    const observedOrders: string[] = [];
    for (let macrotask = 0; macrotask < 6; macrotask += 1) {
      await runMacrotask();
      observedOrders.push(rowOrder());
    }

    // Order is quiet…
    expect(new Set(observedOrders)).toEqual(new Set([settledOrder]));
    // …and so is the row model: no rebuild happens with nothing changing.
    expect(fileTreeTelemetry.treeRowsRebuildCount).toBe(rebuildsAtRest);
  });

  it('costs a BOUNDED number of rebuilds to reach the settled order', async () => {
    useExplorerSortStateStore.getState().setSortState({ direction: 'asc', field: 'tokens' });
    const rebuildsBefore = fileTreeTelemetry.treeRowsRebuildCount;
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <Harness />
        </FileExplorerTestWrapper>
      );
    });
    for (let macrotask = 0; macrotask < 6; macrotask += 1) {
      await runMacrotask();
    }

    // Measured: 3 — the first build, the seam registration's reconcile, and
    // the deferred rollup flush's single re-sort. One slot of slack, then the
    // ceiling bites; the pre-fix loop was already at 18 here and climbing with
    // every macrotask.
    expect(fileTreeTelemetry.treeRowsRebuildCount - rebuildsBefore).toBeLessThanOrEqual(4);
  });

  it('orders directories by their rollup totals once they settle', async () => {
    useExplorerSortStateStore.getState().setSortState({ direction: 'asc', field: 'tokens' });
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <Harness />
        </FileExplorerTestWrapper>
      );
    });
    for (let macrotask = 0; macrotask < 4; macrotask += 1) {
      await runMacrotask();
    }

    // Directories first (beta=3 before alpha=15), then files by token count.
    expect(rowOrder()).toBe('/beta,/alpha,/notes.txt,/readme.md');
  });
});
