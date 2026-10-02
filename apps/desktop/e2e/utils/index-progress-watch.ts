/**
 * Decides when a Workspace Index build has stalled: no change in any progress
 * count for `stallWindowMs`. Kept free of imports so `pnpm test:scripts` can
 * load it directly (Node strips the types) and test the decision without an app.
 */
export interface IndexProgressCounts {
  readonly chunkCount: number;
  readonly chunkedFileCount: number;
  readonly embeddedChunkCount: number;
  readonly fileCount: number;
}

export type IndexProgressVerdict = 'progressing' | 'stalled';

export interface IndexProgressWatch {
  /** Records counts read at `atMs`; `stalled` once they have not changed for the window. */
  observe(counts: IndexProgressCounts, atMs: number): IndexProgressVerdict;
}

function sameCounts(left: IndexProgressCounts, right: IndexProgressCounts): boolean {
  return (
    left.chunkCount === right.chunkCount &&
    left.chunkedFileCount === right.chunkedFileCount &&
    left.embeddedChunkCount === right.embeddedChunkCount &&
    left.fileCount === right.fileCount
  );
}

export function createIndexProgressWatch(options: {
  readonly initial: IndexProgressCounts;
  readonly stallWindowMs: number;
  readonly startedAtMs: number;
}): IndexProgressWatch {
  if (!(Number.isFinite(options.stallWindowMs) && options.stallWindowMs > 0)) {
    throw new Error(`Stall window must be a positive number of ms, got ${options.stallWindowMs}.`);
  }
  let last = options.initial;
  let lastChangeAtMs = options.startedAtMs;
  return {
    observe(counts, atMs) {
      if (!sameCounts(counts, last)) {
        last = counts;
        lastChangeAtMs = atMs;
        return 'progressing';
      }
      return atMs - lastChangeAtMs >= options.stallWindowMs ? 'stalled' : 'progressing';
    },
  };
}
