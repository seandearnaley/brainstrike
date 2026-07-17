import { describe, expect, it } from 'vitest';
import type { SelectedChunk } from '../chunk-selection-store';
import { deriveSearchRanges, searchRangeColor, toTapestrySpan } from '../range-math';

// Palette (from @brainstrike/types TAPESTRY_COLOR_NAMES order):
// index 0 = red #ef4444, index 1 = orange #f97316.
const RED = '#ef4444';
const ORANGE = '#f97316';

function chunk(id: string, startLine: number, endLine: number): SelectedChunk {
  return { chunkId: id, endLine, startLine };
}

let idCounter = 0;
const seqId = (): string => `id-${idCounter++}`;

describe('toTapestrySpan', () => {
  it('converts inclusive {10,14} to exclusive {10,15}', () => {
    expect(toTapestrySpan({ endLine: 14, startLine: 10 })).toEqual({ endLine: 15, startLine: 10 });
  });
});

describe('searchRangeColor', () => {
  it('picks palette colors by index, wrapping modulo the palette length', () => {
    expect(searchRangeColor(0)).toBe(RED);
    expect(searchRangeColor(1)).toBe(ORANGE);
  });
});

describe('deriveSearchRanges', () => {
  it('empty set -> no ranges (preview default takes over)', () => {
    expect(deriveSearchRanges([], seqId, searchRangeColor)).toEqual([]);
  });

  it('one chunk -> one active search-owned covering range colored by index 0', () => {
    const result = deriveSearchRanges([chunk('c1', 10, 14)], () => 'new-id', searchRangeColor);
    expect(result).toEqual([
      {
        color: RED,
        endLine: 15,
        id: 'new-id',
        isActive: true,
        origin: 'search',
        startLine: 10,
        userModified: false,
      },
    ]);
  });

  it('coalesces OVERLAPPING chunks into one covering span: [10,15)+[13,21) -> [10,21)', () => {
    const result = deriveSearchRanges(
      [chunk('a', 10, 14), chunk('b', 13, 20)],
      () => 'merged',
      searchRangeColor
    );
    expect(result).toEqual([
      {
        color: RED,
        endLine: 21,
        id: 'merged',
        isActive: true,
        origin: 'search',
        startLine: 10,
        userModified: false,
      },
    ]);
  });

  it('coalesces ADJACENT chunks: [10,15)+[15,19) -> [10,19)', () => {
    const result = deriveSearchRanges(
      [chunk('a', 10, 14), chunk('b', 15, 18)],
      () => 'merged',
      searchRangeColor
    );
    expect(result).toEqual([
      {
        color: RED,
        endLine: 19,
        id: 'merged',
        isActive: true,
        origin: 'search',
        startLine: 10,
        userModified: false,
      },
    ]);
  });

  it('keeps DISJOINT chunks as separate covering spans, sorted, colored by index', () => {
    idCounter = 0;
    const result = deriveSearchRanges(
      [chunk('b', 20, 24), chunk('a', 10, 14)],
      seqId,
      searchRangeColor
    );
    expect(result).toEqual([
      {
        color: RED,
        endLine: 15,
        id: 'id-0',
        isActive: true,
        origin: 'search',
        startLine: 10,
        userModified: false,
      },
      {
        color: ORANGE,
        endLine: 25,
        id: 'id-1',
        isActive: true,
        origin: 'search',
        startLine: 20,
        userModified: false,
      },
    ]);
  });

  it('collapses identical/nested chunks to their covering span', () => {
    const identical = deriveSearchRanges(
      [chunk('a', 10, 20), chunk('b', 10, 20)],
      () => 'm',
      searchRangeColor
    );
    expect(identical).toHaveLength(1);
    expect(identical[0]).toMatchObject({ endLine: 21, startLine: 10 });

    const nested = deriveSearchRanges(
      [chunk('a', 10, 30), chunk('b', 15, 20)],
      () => 'm',
      searchRangeColor
    );
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ endLine: 31, startLine: 10 });
  });
});
