import { describe, expect, it } from 'vitest';
import type { TapestryFileBase } from '../../tapestry/tapestry-adapter';
import type { FileTapestry, TapestryRange } from '../../tapestry/types';
import type { TapestryRangeMap } from '../context-selected-token-summary';
import { syncTapestryRanges } from '../tapestry-range-sync';

const KEY = 'root-1::src/a.ts';

function makeBase(
  totalLines: number,
  contentStatus: FileTapestry['contentStatus']
): TapestryFileBase {
  return {
    compositeKey: KEY,
    content: [],
    contentStatus,
    id: KEY,
    language: 'ts',
    name: 'a.ts',
    path: 'src/a.ts',
    rootFolderId: 'root-1',
    structure: [],
    totalLines,
    type: 'TS',
  };
}

function makeRange(
  overrides: Partial<TapestryRange> & Pick<TapestryRange, 'startLine' | 'endLine'>
): TapestryRange {
  return {
    color: '#000000',
    endLine: overrides.endLine,
    id: overrides.id ?? 'r',
    isActive: overrides.isActive ?? true,
    startLine: overrides.startLine,
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    ...(overrides.userModified === undefined ? {} : { userModified: overrides.userModified }),
  };
}

function sync(args: {
  prev: TapestryRangeMap;
  base: TapestryFileBase;
  totals: Map<string, number>;
}) {
  return syncTapestryRanges({
    bases: new Map([[KEY, args.base]]),
    prev: args.prev,
    totals: args.totals,
  });
}

describe('syncTapestryRanges — not-ready guard (regression)', () => {
  it('preserves a pre-content range through a not-ready pass, then a ready pass keeps it (no clamp-to-0, no stretch)', () => {
    // A programmatic writer (workspace-search bridge) wrote a chunk span BEFORE
    // content loaded, while totalLines is still a ~1-line placeholder.
    const preContentRange = makeRange({
      endLine: 8,
      id: 'range-1',
      origin: 'search',
      startLine: 1,
    });
    const prev: TapestryRangeMap = { [KEY]: [preContentRange] };

    // Pass 1: content NOT ready, placeholder total 1. Must NOT clamp [1,8) -> [0,1).
    const notReady = sync({
      base: makeBase(1, 'loading'),
      prev,
      totals: new Map(),
    });
    expect(notReady.next[KEY]).toEqual([preContentRange]);
    // The untrusted placeholder total is not recorded as a baseline.
    expect(notReady.totals.has(KEY)).toBe(false);

    // Pass 2: content ready, real total 12. Must keep [1,8) — no stretch to whole file.
    const ready = sync({
      base: makeBase(12, 'ready'),
      prev: notReady.next,
      totals: notReady.totals,
    });
    expect(ready.next[KEY]).toEqual([preContentRange]);
    expect(ready.totals.get(KEY)).toBe(12);
  });

  it('does not clamp a placeholder-total range that overflows the placeholder while not ready', () => {
    const range = makeRange({ endLine: 8, id: 'range-1', startLine: 1 });
    const result = sync({
      base: makeBase(1, 'loading'),
      prev: { [KEY]: [range] },
      totals: new Map(),
    });
    expect(result.next[KEY]).toEqual([range]);
    expect(result.changed).toBe(false);
  });
});

describe('syncTapestryRanges — ready-content behavior', () => {
  it('creates a full-file default for a rangeless ready file and records its total', () => {
    const result = sync({
      base: makeBase(12, 'ready'),
      prev: {},
      totals: new Map(),
    });
    const ranges = result.next[KEY];
    expect(ranges).toHaveLength(1);
    expect(ranges?.[0]).toMatchObject({ endLine: 12, isActive: true, startLine: 0 });
    expect(result.totals.get(KEY)).toBe(12);
    expect(result.changed).toBe(true);
  });

  it('stretches a true default when the total changes across ready passes', () => {
    const first = sync({ base: makeBase(12, 'ready'), prev: {}, totals: new Map() });
    const second = sync({
      base: makeBase(20, 'ready'),
      prev: first.next,
      totals: first.totals,
    });
    expect(second.next[KEY]).toEqual([{ ...first.next[KEY]?.[0], endLine: 20 }]);
  });

  it('stretches a default created before content to the real total once ready (first-ready)', () => {
    // Rangeless while loading -> default created at the placeholder/estimate total.
    const loading = sync({ base: makeBase(12, 'loading'), prev: {}, totals: new Map() });
    expect(loading.next[KEY]?.[0]).toMatchObject({ endLine: 12, startLine: 0 });
    expect(loading.totals.has(KEY)).toBe(false);

    // Content ready at the real total -> the untouched default stretches to it.
    const ready = sync({
      base: makeBase(200, 'ready'),
      prev: loading.next,
      totals: loading.totals,
    });
    expect(ready.next[KEY]?.[0]).toMatchObject({ endLine: 200, startLine: 0 });
  });

  it('clamps an out-of-bounds range when ready', () => {
    const range = makeRange({ endLine: 100, id: 'a', startLine: 5 });
    const result = sync({
      base: makeBase(12, 'ready'),
      prev: { [KEY]: [range] },
      totals: new Map(),
    });
    expect(result.next[KEY]).toEqual([{ ...range, endLine: 12, startLine: 5 }]);
  });

  it('does NOT stretch an origin:"search" single range at startLine 0 even when ready and totals change', () => {
    const searchRange = makeRange({ endLine: 8, id: 'range-1', origin: 'search', startLine: 0 });
    const first = sync({
      base: makeBase(12, 'ready'),
      prev: { [KEY]: [searchRange] },
      totals: new Map([[KEY, 8]]),
    });
    expect(first.next[KEY]).toEqual([searchRange]);

    const second = sync({
      base: makeBase(40, 'ready'),
      prev: first.next,
      totals: first.totals,
    });
    expect(second.next[KEY]).toEqual([searchRange]);
  });
});
