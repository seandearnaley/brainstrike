/**
 * Cost of the synchronous directory rollup (BST-1208).
 *
 * Asserts WORK, not elapsed time. A wall-clock ceiling here was a false-red
 * generator: the integration lane gates a required check, CI runners vary by
 * an order of magnitude, and a loaded runner measured 155ms against a 100ms
 * ceiling on work that had not changed. What actually regresses is the
 * ALGORITHM — a rollup that re-walks, re-reads or loses its cap — and that is
 * machine-independent, so the tripwire counts descendant reads and merely
 * LOGS the elapsed time for whoever is profiling.
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

  const reads = { size: 0, tokens: 0 };
  return {
    directoryKeys: [...subtrees.keys()],
    reads,
    store: createFileRowMetadataStore({
      getCachedSize: () => undefined,
      getDirectorySubtree: (compositeKey) =>
        subtrees.get(compositeKey) ?? UNENUMERATED_DIRECTORY_SUBTREE,
      // Every descendant resolves, so no rollup short-circuits.
      getNodeSize: () => {
        reads.size += 1;
        return 1024;
      },
      getTokenCount: () => {
        reads.tokens += 1;
        return 256;
      },
    }),
  };
}

describe('directory rollup cost at the cap', () => {
  it('reads every capped descendant exactly once per directory rollup', () => {
    const { directoryKeys, reads, store } = buildWorstCaseStore();

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

    // One pass over each directory's descendants, no more: the number a
    // re-walk, a lost cap or a per-ancestor recompute would blow past.
    const expectedDescendantReads = VIEWPORT_DIRECTORY_ROWS * DIRECTORY_ROLLUP_MAX_FILES;
    expect(reads.tokens).toBe(expectedDescendantReads);
    expect(reads.size).toBe(expectedDescendantReads);
  });
});
