// @vitest-environment node
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { DEFAULT_MAX_FILE_SIZE } from '@brainstrike/file-system';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createFileRowMetadataStore,
  type FileRowDirectorySubtree,
  type FileRowMetadata,
  type FileRowMetadataSources,
} from '../indexing/file-row-metadata-store';

const ROOT = 'root-id';
/** `getDirectorySubtree` is total: anything unknown answers "not enumerated". */
const UNKNOWN_SUBTREE: FileRowDirectorySubtree = {
  fileKeys: [],
  incompleteReason: 'not-enumerated',
  isComplete: false,
};
const OVER_MAX_FILE_SIZE = DEFAULT_MAX_FILE_SIZE + 1;

function key(path: string): string {
  return encodeFileSelection(ROOT, path);
}

interface SourceFixture {
  cachedSizes?: Record<string, number>;
  nodeSizes?: Record<string, number>;
  subtrees?: Record<string, FileRowDirectorySubtree>;
  tokens?: Record<string, number>;
}

function sources({
  cachedSizes = {},
  nodeSizes = {},
  subtrees = {},
  tokens = {},
}: SourceFixture = {}): FileRowMetadataSources {
  return {
    getCachedSize: (compositeKey) => cachedSizes[compositeKey],
    getDirectorySubtree: (compositeKey) => subtrees[compositeKey] ?? UNKNOWN_SUBTREE,
    getNodeSize: (compositeKey) => nodeSizes[compositeKey],
    getTokenCount: (compositeKey) => tokens[compositeKey],
  };
}

describe('createFileRowMetadataStore file snapshots', () => {
  it('requires every excluded token state to carry its retirement reason', () => {
    expectTypeOf({ tokens: 'excluded' as const, type: 'ts' }).not.toMatchTypeOf<FileRowMetadata>();
    expectTypeOf({
      exclusionReason: 'binary' as const,
      tokens: 'excluded' as const,
      type: 'png',
    }).toMatchTypeOf<FileRowMetadata>();
  });

  it('reports the counted token total, node size, and derived type', () => {
    const store = createFileRowMetadataStore(
      sources({
        nodeSizes: { [key('src/a.ts')]: 1024 },
        tokens: { [key('src/a.ts')]: 42 },
      })
    );

    expect(store.getSnapshot(key('src/a.ts'))).toEqual({ size: 1024, tokens: 42, type: 'ts' });
  });

  it('falls back to the token-cache file size only when the node has none', () => {
    const store = createFileRowMetadataStore(
      sources({
        cachedSizes: { [key('src/a.ts')]: 7, [key('src/b.ts')]: 9 },
        nodeSizes: { [key('src/a.ts')]: 1024 },
        tokens: { [key('src/a.ts')]: 1, [key('src/b.ts')]: 2 },
      })
    );

    expect(store.getSnapshot(key('src/a.ts')).size).toBe(1024);
    expect(store.getSnapshot(key('src/b.ts')).size).toBe(9);
  });

  it('omits size entirely when no source knows it (never a silent zero)', () => {
    const store = createFileRowMetadataStore(sources({ tokens: { [key('a.ts')]: 3 } }));
    expect(store.getSnapshot(key('a.ts')).size).toBeUndefined();
  });

  it('marks binaries excluded — the same rule the dispatch planner applies', () => {
    const store = createFileRowMetadataStore(sources({ nodeSizes: { [key('logo.png')]: 500 } }));
    expect(store.getSnapshot(key('logo.png'))).toEqual({
      exclusionReason: 'binary',
      size: 500,
      tokens: 'excluded',
      type: 'png',
    });
  });

  it('marks files over the indexable size limit excluded, not pending forever', () => {
    // The planner retires these into `indexedKeysToAdd`, so their count never
    // arrives; `pending` would be a permanent lie.
    const store = createFileRowMetadataStore(
      sources({ nodeSizes: { [key('src/huge.ts')]: OVER_MAX_FILE_SIZE } })
    );
    expect(store.getSnapshot(key('src/huge.ts'))).toEqual({
      exclusionReason: 'too-large',
      size: OVER_MAX_FILE_SIZE,
      tokens: 'excluded',
      type: 'ts',
    });
  });

  it('leaves a file exactly at the size limit indexable', () => {
    const store = createFileRowMetadataStore(
      sources({ nodeSizes: { [key('src/big.ts')]: DEFAULT_MAX_FILE_SIZE } })
    );
    expect(store.getSnapshot(key('src/big.ts')).tokens).toBe('pending');
  });

  it('cannot classify an oversized file whose size is unknown', () => {
    const store = createFileRowMetadataStore(sources());
    expect(store.getSnapshot(key('src/unknown.ts')).exclusionReason).toBeUndefined();
  });

  it('reports binary before size when a file is both', () => {
    const store = createFileRowMetadataStore(
      sources({ nodeSizes: { [key('huge.png')]: OVER_MAX_FILE_SIZE } })
    );
    expect(store.getSnapshot(key('huge.png')).exclusionReason).toBe('binary');
  });

  it('marks uncounted text files pending rather than zero', () => {
    const store = createFileRowMetadataStore(sources());
    expect(store.getSnapshot(key('src/a.ts')).tokens).toBe('pending');
  });

  it('uses the shared fallback type for extensionless files', () => {
    const store = createFileRowMetadataStore(sources());
    expect(store.getSnapshot(key('src/Makefile')).type).toBe('file');
  });
});

describe('createFileRowMetadataStore snapshot identity', () => {
  it('keeps a stable identity until the key is invalidated with a changed value', () => {
    const tokens: Record<string, number> = {};
    const store = createFileRowMetadataStore(sources({ tokens }));
    const fileKey = key('src/a.ts');

    const first = store.getSnapshot(fileKey);
    expect(store.getSnapshot(fileKey)).toBe(first);

    // A source change alone must NOT change the snapshot — useSyncExternalStore
    // requires the value to hold until the store notifies.
    tokens[fileKey] = 12;
    expect(store.getSnapshot(fileKey)).toBe(first);

    store.subscribe(fileKey, () => undefined);
    store.invalidate([fileKey]);
    const next = store.getSnapshot(fileKey);
    expect(next).not.toBe(first);
    expect(next.tokens).toBe(12);
  });

  it('does not mint a new snapshot when an invalidated key is value-equal', () => {
    const store = createFileRowMetadataStore(sources({ tokens: { [key('a.ts')]: 5 } }));
    const fileKey = key('a.ts');
    store.subscribe(fileKey, () => undefined);

    const first = store.getSnapshot(fileKey);
    store.invalidate([fileKey]);
    expect(store.getSnapshot(fileKey)).toBe(first);
  });
});

describe('createFileRowMetadataStore per-key notification', () => {
  it('notifies ONLY the subscribers of the key whose metadata changed', () => {
    const tokens: Record<string, number> = {};
    const store = createFileRowMetadataStore(sources({ tokens }));
    const changed = key('src/a.ts');
    const untouched = key('src/b.ts');

    const changedListener = vi.fn();
    const untouchedListener = vi.fn();
    store.subscribe(changed, changedListener);
    store.subscribe(untouched, untouchedListener);
    store.getSnapshot(changed);
    store.getSnapshot(untouched);

    tokens[changed] = 99;
    store.invalidate([changed]);

    expect(changedListener).toHaveBeenCalledTimes(1);
    expect(untouchedListener).not.toHaveBeenCalled();
  });

  it('invalidateAll notifies only the keys whose snapshot actually changed', () => {
    const tokens: Record<string, number> = { [key('b.ts')]: 4 };
    const store = createFileRowMetadataStore(sources({ tokens }));
    const changed = key('a.ts');
    const stable = key('b.ts');

    const changedListener = vi.fn();
    const stableListener = vi.fn();
    store.subscribe(changed, changedListener);
    store.subscribe(stable, stableListener);
    store.getSnapshot(changed);
    store.getSnapshot(stable);

    tokens[changed] = 7;
    store.invalidateAll();

    expect(changedListener).toHaveBeenCalledTimes(1);
    expect(stableListener).not.toHaveBeenCalled();
  });

  it('coalesces changed keys into one root revision for metadata-sorted trees', () => {
    const tokens: Record<string, number> = {};
    const store = createFileRowMetadataStore(sources({ tokens }));
    const first = key('a.ts');
    const second = key('b.ts');
    const rootListener = vi.fn();
    store.subscribeFolder(ROOT, rootListener);
    store.getSnapshot(first);
    store.getSnapshot(second);

    tokens[first] = 1;
    tokens[second] = 2;
    store.invalidate([first, second]);

    expect(rootListener).toHaveBeenCalledTimes(1);
    expect(store.getFolderRevision(ROOT)).toBe(1);
  });

  it('stops delivering after unsubscribe', () => {
    const tokens: Record<string, number> = {};
    const store = createFileRowMetadataStore(sources({ tokens }));
    const fileKey = key('a.ts');
    const listener = vi.fn();
    const unsubscribe = store.subscribe(fileKey, listener);
    store.getSnapshot(fileKey);

    unsubscribe();
    tokens[fileKey] = 1;
    store.invalidate([fileKey]);

    expect(listener).not.toHaveBeenCalled();
  });

  it('tolerates a listener that unsubscribes a sibling mid-notify', () => {
    const tokens: Record<string, number> = {};
    const store = createFileRowMetadataStore(sources({ tokens }));
    const fileKey = key('a.ts');
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(fileKey, () => unsubscribeFirst());
    store.subscribe(fileKey, second);
    store.getSnapshot(fileKey);

    tokens[fileKey] = 3;
    expect(() => store.invalidate([fileKey])).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('recomputes only the invalidated key, where invalidateAll recomputes them all', () => {
    // The cost contract: a token arrival names its key, so the work must be
    // O(affected keys). `getTokenCount` is the compute path's entry point, so
    // counting its calls measures exactly how many rows were recomputed.
    const tokens: Record<string, number> = {};
    const getTokenCount = vi.fn((compositeKey: string) => tokens[compositeKey]);
    const store = createFileRowMetadataStore({
      getCachedSize: () => undefined,
      getDirectorySubtree: () => UNKNOWN_SUBTREE,
      getNodeSize: () => 1,
      getTokenCount,
    });
    const rows = ['a', 'b', 'c', 'd'].map((name) => key(`src/${name}.ts`));
    for (const row of rows) {
      store.subscribe(row, () => undefined);
      store.getSnapshot(row);
    }
    const [resolved] = rows;
    if (resolved === undefined) {
      throw new Error('fixture must provide rows');
    }

    getTokenCount.mockClear();
    tokens[resolved] = 5;
    store.invalidate([resolved]);
    expect(getTokenCount.mock.calls.map(([compositeKey]) => compositeKey)).toEqual([resolved]);

    // Contrast pins the difference the precise path exists to avoid.
    getTokenCount.mockClear();
    store.invalidateAll();
    expect(getTokenCount).toHaveBeenCalledTimes(rows.length);
  });

  it('drops cache entries for keys nobody subscribes to (bounded growth)', () => {
    const getTokenCount = vi.fn(() => undefined);
    const store = createFileRowMetadataStore({
      getCachedSize: () => undefined,
      getDirectorySubtree: () => UNKNOWN_SUBTREE,
      getNodeSize: () => undefined,
      getTokenCount,
    });

    const first = store.getSnapshot(key('a.ts'));
    store.invalidateAll();
    // Entry was evicted, so the next read recomputes instead of serving a
    // snapshot that would live forever after the row scrolled away.
    expect(store.getSnapshot(key('a.ts'))).not.toBe(first);
  });

  /**
   * BST-1209 review, important finding 2: a metadata sort registers ONE folder
   * listener and then reads a snapshot for every projected row. When the folder
   * listener pinned every key in the root, that read path grew the cache to the
   * whole expanded projection with no eviction — and made `invalidateAll` cost
   * O(all cached subtrees) instead of O(rows in play).
   */
  it('still evicts unsubscribed file snapshots while a folder listener is attached', () => {
    const store = createFileRowMetadataStore(sources());
    store.subscribeFolder(ROOT, vi.fn());

    const first = store.getSnapshot(key('a.ts'));
    store.invalidateAll();

    expect(store.getSnapshot(key('a.ts'))).not.toBe(first);
  });

  it('reads sort snapshots without caching them at all', () => {
    const store = createFileRowMetadataStore(sources({ tokens: { [key('a.ts')]: 5 } }));
    store.subscribeFolder(ROOT, vi.fn());

    expect(store.peekSnapshot(key('a.ts'))).toEqual({ tokens: 5, type: 'ts' });
    // Nothing was cached, so nothing can be evicted — a comparator sweeping
    // 10k projected rows leaves the store exactly as it found it.
    const listener = vi.fn();
    store.subscribe(key('a.ts'), listener);
    store.invalidateAll();
    expect(listener).not.toHaveBeenCalled();
  });

  it('answers a sort read from the cache when the row IS subscribed', () => {
    const store = createFileRowMetadataStore(sources({ tokens: { [key('a.ts')]: 5 } }));
    store.subscribe(key('a.ts'), vi.fn());

    const subscribed = store.getSnapshot(key('a.ts'));
    expect(store.peekSnapshot(key('a.ts'))).toBe(subscribed);
  });

  /**
   * The ordering signal is per-BATCH, not per-cached-change: an ordered tree
   * compares values across its whole projection, most of it uncached, so a
   * count landing for an off-screen row must still be able to move the order.
   */
  it('bumps the root revision for an invalidated key it never cached', () => {
    const tokens: Record<string, number> = {};
    const store = createFileRowMetadataStore(sources({ tokens }));
    const rootListener = vi.fn();
    store.subscribeFolder(ROOT, rootListener);

    tokens[key('offscreen.ts')] = 9;
    store.invalidate([key('offscreen.ts')]);

    expect(rootListener).toHaveBeenCalledTimes(1);
    expect(store.getFolderRevision(ROOT)).toBe(1);
  });
});

describe('createFileRowMetadataStore directory rollups', () => {
  const dirKey = key('src');

  function directoryStore(fixture: SourceFixture) {
    return createFileRowMetadataStore(sources(fixture));
  }

  it('sums tokens and sizes when the subtree is fully enumerated', () => {
    const store = directoryStore({
      nodeSizes: { [key('src/a.ts')]: 100, [key('src/b.ts')]: 20 },
      subtrees: {
        [dirKey]: { fileKeys: [key('src/a.ts'), key('src/b.ts')], isComplete: true },
      },
      tokens: { [key('src/a.ts')]: 10, [key('src/b.ts')]: 5 },
    });

    expect(store.getDirectorySnapshot(dirKey)).toEqual({
      size: 120,
      status: 'complete',
      tokens: 15,
    });
  });

  it('counts excluded binaries as zero tokens without blocking the rollup', () => {
    const store = directoryStore({
      nodeSizes: { [key('src/a.ts')]: 100, [key('src/logo.png')]: 900 },
      subtrees: {
        [dirKey]: { fileKeys: [key('src/a.ts'), key('src/logo.png')], isComplete: true },
      },
      tokens: { [key('src/a.ts')]: 10 },
    });

    expect(store.getDirectorySnapshot(dirKey)).toEqual({
      size: 1000,
      status: 'complete',
      tokens: 10,
    });
  });

  it('returns an explicit partial marker when the subtree is not fully enumerated', () => {
    const store = directoryStore({
      nodeSizes: { [key('src/a.ts')]: 100 },
      subtrees: {
        [dirKey]: {
          fileKeys: [key('src/a.ts')],
          incompleteReason: 'not-enumerated',
          isComplete: false,
        },
      },
      tokens: { [key('src/a.ts')]: 10 },
    });

    expect(store.getDirectorySnapshot(dirKey)).toEqual({
      reason: 'incomplete-subtree',
      status: 'partial',
    });
  });

  it('returns an explicit partial marker while any descendant token is pending', () => {
    const store = directoryStore({
      nodeSizes: { [key('src/a.ts')]: 100, [key('src/b.ts')]: 20 },
      subtrees: {
        [dirKey]: { fileKeys: [key('src/a.ts'), key('src/b.ts')], isComplete: true },
      },
      tokens: { [key('src/a.ts')]: 10 },
    });

    expect(store.getDirectorySnapshot(dirKey)).toEqual({
      reason: 'pending-metadata',
      status: 'partial',
    });
  });

  it('returns an explicit partial marker while any descendant size is unknown', () => {
    const store = directoryStore({
      nodeSizes: { [key('src/a.ts')]: 100 },
      subtrees: {
        [dirKey]: { fileKeys: [key('src/a.ts'), key('src/b.ts')], isComplete: true },
      },
      tokens: { [key('src/a.ts')]: 10, [key('src/b.ts')]: 5 },
    });

    expect(store.getDirectorySnapshot(dirKey)).toEqual({
      reason: 'pending-metadata',
      status: 'partial',
    });
  });

  it('reads partial — never throws mid-render — when the key has no enumerated subtree', () => {
    const store = directoryStore({});
    expect(store.getDirectorySnapshot(dirKey)).toEqual({
      reason: 'incomplete-subtree',
      status: 'partial',
    });
  });

  it('counts oversized files as zero tokens without blocking the rollup', () => {
    const store = directoryStore({
      nodeSizes: { [key('src/a.ts')]: 100, [key('src/huge.ts')]: OVER_MAX_FILE_SIZE },
      subtrees: {
        [dirKey]: { fileKeys: [key('src/a.ts'), key('src/huge.ts')], isComplete: true },
      },
      tokens: { [key('src/a.ts')]: 10 },
    });

    expect(store.getDirectorySnapshot(dirKey)).toEqual({
      size: 100 + OVER_MAX_FILE_SIZE,
      status: 'complete',
      tokens: 10,
    });
  });

  it('notifies a subscribed ancestor directory when a descendant token lands', () => {
    const tokens: Record<string, number> = { [key('src/a.ts')]: 10 };
    const store = createFileRowMetadataStore(
      sources({
        nodeSizes: { [key('src/a.ts')]: 100, [key('src/b.ts')]: 20 },
        subtrees: {
          [dirKey]: { fileKeys: [key('src/a.ts'), key('src/b.ts')], isComplete: true },
        },
        tokens,
      })
    );

    const directoryListener = vi.fn();
    const siblingListener = vi.fn();
    store.subscribe(dirKey, directoryListener);
    store.subscribe(key('src/a.ts'), siblingListener);
    store.getDirectorySnapshot(dirKey);
    store.getSnapshot(key('src/a.ts'));

    tokens[key('src/b.ts')] = 5;
    store.invalidate([key('src/b.ts')]);

    expect(directoryListener).toHaveBeenCalledTimes(1);
    expect(siblingListener).not.toHaveBeenCalled();
    expect(store.getDirectorySnapshot(dirKey)).toEqual({
      size: 120,
      status: 'complete',
      tokens: 15,
    });
  });
});

/**
 * A folder (sort) listener pins DIRECTORY rollups against eviction, because
 * recomputing one walks an enumerated subtree. Whole-branch review F3: that
 * pin had no release. The sort comparator reads `getDirectorySnapshot` for
 * every directory row in the PROJECTION — not just the visible rows — so the
 * cache filled to the projection's high-water mark and collapsing never shrank
 * it again. Every later expand/collapse/keystroke then recomputed every rollup
 * the session had ever shown.
 *
 * The release is liveness: a reconciliation drops folder-pinned rollups that
 * nothing has read since the previous one.
 */
describe('createFileRowMetadataStore folder-pin bound', () => {
  function buildLargeProjection(directoryCount: number) {
    const subtrees: Record<string, FileRowDirectorySubtree> = {};
    const nodeSizes: Record<string, number> = {};
    const tokens: Record<string, number> = {};
    const directoryKeys: string[] = [];
    for (let index = 0; index < directoryCount; index += 1) {
      const directoryKey = key(`dir-${index}`);
      const fileKey = key(`dir-${index}/file.ts`);
      directoryKeys.push(directoryKey);
      subtrees[directoryKey] = { fileKeys: [fileKey], isComplete: true };
      nodeSizes[fileKey] = 10;
      tokens[fileKey] = 1;
    }
    const subtreeReads: string[] = [];
    const store = createFileRowMetadataStore({
      ...sources({ nodeSizes, subtrees, tokens }),
      getDirectorySubtree: (compositeKey) => {
        subtreeReads.push(compositeKey);
        return subtrees[compositeKey] ?? UNKNOWN_SUBTREE;
      },
    });
    return { directoryKeys, store, subtreeReads };
  }

  it('lets go of rollups the projection no longer reads', () => {
    const { directoryKeys, store, subtreeReads } = buildLargeProjection(50);
    // A Tokens/Size sort: one folder listener, no per-row subscriptions.
    store.subscribeFolder(ROOT, () => undefined);

    // Expanded: the comparator sweeps the whole projection.
    for (const directoryKey of directoryKeys) {
      store.getDirectorySnapshot(directoryKey);
    }
    store.invalidateAll();

    // Collapsed: only three directory rows are projected now.
    const stillProjected = directoryKeys.slice(0, 3);
    for (const directoryKey of stillProjected) {
      store.getDirectorySnapshot(directoryKey);
    }
    store.invalidateAll();

    // A reconciliation must now cost THREE rollups, not fifty.
    subtreeReads.length = 0;
    store.invalidateAll();
    expect(new Set(subtreeReads)).toEqual(new Set(stillProjected));
  });

  it('keeps serving a dropped rollup — it recomputes, it does not go wrong', () => {
    const { directoryKeys, store } = buildLargeProjection(4);
    store.subscribeFolder(ROOT, () => undefined);
    for (const directoryKey of directoryKeys) {
      store.getDirectorySnapshot(directoryKey);
    }
    store.invalidateAll();
    store.getDirectorySnapshot(directoryKeys[0] as string);
    store.invalidateAll();

    // Evicted, then read again: same value, recomputed from source.
    expect(store.getDirectorySnapshot(directoryKeys[3] as string)).toEqual({
      size: 10,
      status: 'complete',
      tokens: 1,
    });
  });

  it('never sweeps a rollup a rendered CELL subscribes to', () => {
    const { directoryKeys, store, subtreeReads } = buildLargeProjection(3);
    store.subscribeFolder(ROOT, () => undefined);
    const subscribed = directoryKeys[2] as string;
    store.subscribe(subscribed, () => undefined);
    for (const directoryKey of directoryKeys) {
      store.getDirectorySnapshot(directoryKey);
    }
    store.invalidateAll();

    // Only the first row stays in the sorted projection; the third is
    // off-projection but still has its own cell listener.
    store.getDirectorySnapshot(directoryKeys[0] as string);
    store.invalidateAll();

    subtreeReads.length = 0;
    store.invalidateAll();
    expect(new Set(subtreeReads)).toEqual(new Set([directoryKeys[0], subscribed]));
  });

  it('treats a read-free reconciliation as no evidence, not as an empty projection', () => {
    const { directoryKeys, store, subtreeReads } = buildLargeProjection(3);
    store.subscribeFolder(ROOT, () => undefined);
    for (const directoryKey of directoryKeys) {
      store.getDirectorySnapshot(directoryKey);
    }

    // Two reconciliations back to back, nothing rendered in between.
    store.invalidateAll();
    subtreeReads.length = 0;
    store.invalidateAll();

    expect(new Set(subtreeReads)).toEqual(new Set(directoryKeys));
  });
});
