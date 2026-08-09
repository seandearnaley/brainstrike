/**
 * Short-circuit BEHAVIOUR of the directory rollup (BST-1208).
 *
 * The wall-clock measurement that motivates deferring the first rollup read
 * lives in `explorer-directory-rollup-cost.integration.test.ts` —
 * timing-sensitive assertions belong in the uncached integration lane, not
 * here (AGENTS.md). What stays is the pure-logic property that makes the
 * `DIRECTORY_ROLLUP_MAX_FILES` cap affordable in the first place: a rollup
 * stops at the first file it cannot account for, so a mid-index tree never
 * pays for the whole subtree.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { describe, expect, it } from 'vitest';
import { createFileRowMetadataStore } from '../indexing/file-row-metadata-store';
import { DIRECTORY_ROLLUP_MAX_FILES } from '../tree/use-file-tree-metadata-source';

const ROOT = 'root';

describe('directory rollup short-circuit', () => {
  it('stops at the first uncounted file instead of summing the whole subtree', () => {
    const fileKeys = Array.from({ length: DIRECTORY_ROLLUP_MAX_FILES }, (_unused, index) =>
      encodeFileSelection(ROOT, `dir/file-${index}.ts`)
    );
    let readFiles = 0;
    const store = createFileRowMetadataStore({
      getCachedSize: () => undefined,
      getDirectorySubtree: () => ({ fileKeys, isComplete: true }),
      getNodeSize: () => 1024,
      getTokenCount: () => {
        readFiles += 1;
        return;
      },
    });

    expect(store.getDirectorySnapshot(encodeFileSelection(ROOT, 'dir')).status).toBe('partial');
    // The very first pending file ends the aggregation; the other 1999 are
    // never touched. That is what bounds the cost during an index run.
    expect(readFiles).toBe(1);
  });
});
