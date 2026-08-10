/**
 * The deferred rollup cache must be BOUNDED by what is still projected
 * (whole-branch review F3).
 *
 * `createDeferredRollupController` memoizes one enumerated subtree per
 * directory path. Nothing ever removed an entry: one expand-all put every
 * directory in the repo in the map, and `refreshAll` — which runs on every
 * structural change, every quick-filter keystroke and every lazy child load —
 * then re-resolved all of them, forever, however few rows were on screen.
 *
 * The bound is liveness, not capacity: every read of this cache arrives through
 * the store (a cell or the sort comparator misses `getDirectorySnapshot`, or
 * the store's own reconciliation re-reads the rollups it still holds), so
 * "nothing asked for this path since the last refresh" means "no row is showing
 * it". Those entries are swept.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { describe, expect, it, vi } from 'vitest';
import type { FileRowMetadataStore } from '../indexing/file-row-metadata-store';
import {
  createDeferredRollupController,
  type DeferredRollupController,
} from '../tree/use-file-tree-metadata-source';

const FOLDER = 'root';

interface Harness {
  controller: DeferredRollupController;
  /** Composite keys handed to the store by the last flush. */
  invalidateDirectories: ReturnType<typeof vi.fn>;
  /** Directory paths the flush actually re-resolved. */
  resolvedPaths: () => string[];
}

function createHarness(): Harness {
  const invalidateDirectories = vi.fn();
  const store = { invalidateDirectories } as unknown as FileRowMetadataStore;
  const controller = createDeferredRollupController({
    resolvedRef: {
      current: {
        displayNodeByPath: new Map(),
        params: {
          fileTree: [],
          filteredPathSet: null,
          folderId: FOLDER,
          normalizedTreeContext: null,
          rowStructureRevision: 1,
          visibleAggregates: null,
        },
      },
    },
    storeRef: { current: store },
  });
  return {
    controller,
    invalidateDirectories,
    resolvedPaths: () => {
      const keys: string[] = [];
      for (const call of invalidateDirectories.mock.calls) {
        for (const key of call[0] as readonly string[]) {
          keys.push(key);
        }
      }
      return keys;
    },
  };
}

function directoryPaths(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `/dir-${index}`);
}

async function macrotask(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('deferred rollup cache bound', () => {
  it('drops entries nothing has read since the previous refresh', async () => {
    const { controller, invalidateDirectories, resolvedPaths } = createHarness();
    const expanded = directoryPaths(50);

    // Expand-all: every directory is read once and resolves a macrotask later.
    for (const path of expanded) {
      controller.read(path);
    }
    await macrotask();
    expect(resolvedPaths()).toHaveLength(50);

    // One full structural cycle with everything still on screen: the store
    // re-reads every rollup it holds, so the whole set stays live.
    for (const path of expanded) {
      controller.read(path);
    }
    invalidateDirectories.mockClear();
    controller.refreshAll();
    await macrotask();
    expect(resolvedPaths()).toHaveLength(50);

    // Now collapse. The store only re-reads the three rows still projected,
    // and this refresh is what must let the other 47 go.
    const stillProjected = expanded.slice(0, 3);
    for (const path of stillProjected) {
      controller.read(path);
    }
    invalidateDirectories.mockClear();
    controller.refreshAll();
    await macrotask();

    // High-water mark was 50; the refresh must not still be paying for it.
    expect(resolvedPaths().sort()).toEqual(
      stillProjected.map((path) => encodeFileSelection(FOLDER, path)).sort()
    );

    // …and it must STAY dropped: a later refresh cannot resurrect them.
    for (const path of stillProjected) {
      controller.read(path);
    }
    invalidateDirectories.mockClear();
    controller.refreshAll();
    await macrotask();
    expect(resolvedPaths()).toHaveLength(3);
  });

  it('keeps re-resolving the paths that are still read', async () => {
    const { controller, invalidateDirectories, resolvedPaths } = createHarness();
    controller.read('/kept');
    await macrotask();
    controller.read('/kept');
    invalidateDirectories.mockClear();

    controller.refreshAll();
    await macrotask();

    expect(resolvedPaths()).toEqual([encodeFileSelection(FOLDER, '/kept')]);
  });

  it('keeps everything when nothing was read between two refreshes', async () => {
    const { controller, invalidateDirectories, resolvedPaths } = createHarness();
    controller.read('/a');
    controller.read('/b');
    await macrotask();
    controller.read('/a');
    controller.read('/b');

    // Two structural changes in one macrotask, before anything painted: an
    // empty mark set is "no evidence", not "nothing is live".
    controller.refreshAll();
    invalidateDirectories.mockClear();
    controller.refreshAll();
    await macrotask();

    expect(resolvedPaths().sort()).toEqual(
      [encodeFileSelection(FOLDER, '/a'), encodeFileSelection(FOLDER, '/b')].sort()
    );
  });
});
