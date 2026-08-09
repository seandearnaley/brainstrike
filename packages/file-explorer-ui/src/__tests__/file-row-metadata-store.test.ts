import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { describe, expect, it, vi } from 'vitest';
import {
  createFileRowMetadataStore,
  type FileRowDirectorySubtree,
  type FileRowMetadataSources,
} from '../indexing/file-row-metadata-store';

const ROOT = 'root-id';

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
    getDirectorySubtree: (compositeKey) => subtrees[compositeKey] ?? null,
    getNodeSize: (compositeKey) => nodeSizes[compositeKey],
    getTokenCount: (compositeKey) => tokens[compositeKey],
  };
}

describe('createFileRowMetadataStore file snapshots', () => {
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
      size: 500,
      tokens: 'excluded',
      type: 'png',
    });
  });

  it('marks uncounted text files pending rather than zero', () => {
    const store = createFileRowMetadataStore(sources());
    expect(store.getSnapshot(key('src/a.ts')).tokens).toBe('pending');
  });

  it('derives an empty type for extensionless files', () => {
    const store = createFileRowMetadataStore(sources());
    expect(store.getSnapshot(key('src/Makefile')).type).toBe('');
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
      getDirectorySubtree: () => null,
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
      getDirectorySubtree: () => null,
      getNodeSize: () => undefined,
      getTokenCount,
    });

    const first = store.getSnapshot(key('a.ts'));
    store.invalidateAll();
    // Entry was evicted, so the next read recomputes instead of serving a
    // snapshot that would live forever after the row scrolled away.
    expect(store.getSnapshot(key('a.ts'))).not.toBe(first);
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
      subtrees: { [dirKey]: { fileKeys: [key('src/a.ts')], isComplete: false } },
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

  it('throws instead of guessing when the key has no enumerated subtree', () => {
    const store = directoryStore({});
    expect(() => store.getDirectorySnapshot(dirKey)).toThrow(/no enumerated subtree/i);
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
