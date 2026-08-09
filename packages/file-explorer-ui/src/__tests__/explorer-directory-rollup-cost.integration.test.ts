/**
 * WALL-CLOCK cost of the synchronous directory rollup (BST-1208).
 *
 * Lives in the INTEGRATION lane, not the unit lane: it measures elapsed time,
 * and elapsed time under a full parallel turbo run is not the same measurement
 * as elapsed time standalone (AGENTS.md — `*.integration.test.*` marks
 * env-sensitive tests, and the root `test:integration` task is uncached so a
 * pass is never replayed from a machine where it would fail live).
 *
 * A directory cell's first `getSnapshot` aggregates its whole enumerated
 * subtree on the spot. `DIRECTORY_ROLLUP_MAX_FILES` caps that at 2000
 * descendants, and this is what justifies deferring that first read off the
 * paint path in `use-file-tree-metadata-source.ts`.
 *
 * It measures the true WORST case, which is subtler than "2000 files": a
 * rollup short-circuits on the first `pending` file, so the expensive shape is
 * a subtree where every file is already counted and the sum runs to completion.
 * 30 directory cells (a full viewport at 32px rows) x 2000 counted files each.
 *
 * The assertion ceiling is deliberately loose — a regression tripwire, not a
 * benchmark gate. The measured number on the dev machine is recorded at the
 * compute site.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { describe, expect, it } from 'vitest';
import { UNENUMERATED_DIRECTORY_SUBTREE } from '../indexing/file-row-metadata-source-registry';
import {
  createFileRowMetadataStore,
  type FileRowDirectorySubtree,
} from '../indexing/file-row-metadata-store';
import { DIRECTORY_ROLLUP_MAX_FILES } from '../tree/use-file-tree-metadata-source';

const ROOT = 'root';
const VIEWPORT_DIRECTORY_ROWS = 30;

function buildWorstCaseStore() {
  const subtrees = new Map<string, FileRowDirectorySubtree>();
  for (let directory = 0; directory < VIEWPORT_DIRECTORY_ROWS; directory += 1) {
    const fileKeys: string[] = [];
    for (let file = 0; file < DIRECTORY_ROLLUP_MAX_FILES; file += 1) {
      fileKeys.push(encodeFileSelection(ROOT, `dir-${directory}/file-${file}.ts`));
    }
    subtrees.set(encodeFileSelection(ROOT, `dir-${directory}`), { fileKeys, isComplete: true });
  }

  return {
    directoryKeys: [...subtrees.keys()],
    store: createFileRowMetadataStore({
      getCachedSize: () => undefined,
      getDirectorySubtree: (compositeKey) =>
        subtrees.get(compositeKey) ?? UNENUMERATED_DIRECTORY_SUBTREE,
      // Every descendant resolves, so no rollup short-circuits.
      getNodeSize: () => 1024,
      getTokenCount: () => 256,
    }),
  };
}

describe('directory rollup cost at the cap', () => {
  it('aggregates a full viewport of capped directories well inside a frame', () => {
    const { directoryKeys, store } = buildWorstCaseStore();

    const started = performance.now();
    for (const compositeKey of directoryKeys) {
      const rollup = store.getDirectorySnapshot(compositeKey);
      // Guard against measuring a short-circuit instead of the real aggregation.
      expect(rollup.status).toBe('complete');
    }
    const elapsedMs = performance.now() - started;

    console.info(
      `[BST-1208] ${VIEWPORT_DIRECTORY_ROWS} directory rollups × ${DIRECTORY_ROLLUP_MAX_FILES} files: ${elapsedMs.toFixed(2)}ms`
    );

    expect(elapsedMs).toBeLessThan(100);
  });
});
