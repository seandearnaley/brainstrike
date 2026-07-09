import type { TapestryRange } from '@brainstrike/file-explorer-ui';
import { describe, expect, it } from 'vitest';
import {
  addChunkRange,
  chunkCoverage,
  fileCoverage,
  removeChunkRange,
  toTapestrySpan,
} from '../range-math';

// Palette (from @brainstrike/types TAPESTRY_COLOR_NAMES order):
// index 0 = red #ef4444, index 1 = orange #f97316.
const RED = '#ef4444';
const ORANGE = '#f97316';

function range(
  overrides: Partial<TapestryRange> & Pick<TapestryRange, 'startLine' | 'endLine'>
): TapestryRange {
  return {
    color: overrides.color ?? '#000000',
    endLine: overrides.endLine,
    id: overrides.id ?? 'r',
    isActive: overrides.isActive ?? true,
    startLine: overrides.startLine,
    ...(overrides.userModified === undefined ? {} : { userModified: overrides.userModified }),
  };
}

const fixedId = (): string => 'new-id';

describe('toTapestrySpan', () => {
  it('converts inclusive {10,14} to exclusive {10,15}', () => {
    expect(toTapestrySpan({ endLine: 14, startLine: 10 })).toEqual({ endLine: 15, startLine: 10 });
  });
});

describe('addChunkRange', () => {
  it('empty existing -> one active range colored by count 0', () => {
    const result = addChunkRange([], { endLine: 14, startLine: 10 }, fixedId);
    expect(result).toEqual([
      { color: RED, endLine: 15, id: 'new-id', isActive: true, startLine: 10 },
    ]);
  });

  it('coalesces an overlapping active range: [10,15) + chunk {13,20} -> [10,21)', () => {
    const existing = [range({ endLine: 15, id: 'a', startLine: 10 })];
    const result = addChunkRange(existing, { endLine: 20, startLine: 13 }, fixedId);
    expect(result).toEqual([
      { color: ORANGE, endLine: 21, id: 'new-id', isActive: true, startLine: 10 },
    ]);
  });

  it('coalesces an adjacent active range: [10,15) + chunk {15,18} -> [10,19)', () => {
    const existing = [range({ endLine: 15, id: 'a', startLine: 10 })];
    const result = addChunkRange(existing, { endLine: 18, startLine: 15 }, fixedId);
    expect(result).toEqual([
      { color: ORANGE, endLine: 19, id: 'new-id', isActive: true, startLine: 10 },
    ]);
  });

  it('keeps disjoint ranges separate and sorted', () => {
    const existing = [range({ endLine: 15, id: 'a', startLine: 10 })];
    const result = addChunkRange(existing, { endLine: 25, startLine: 20 }, fixedId);
    expect(result).toEqual([
      range({ endLine: 15, id: 'a', startLine: 10 }),
      { color: ORANGE, endLine: 26, id: 'new-id', isActive: true, startLine: 20 },
    ]);
  });

  it('preserves an overlapping userModified range verbatim and adds the new range alongside', () => {
    const userRange = range({ endLine: 20, id: 'u', startLine: 10, userModified: true });
    const result = addChunkRange([userRange], { endLine: 16, startLine: 12 }, fixedId);
    expect(result).toEqual([
      userRange,
      { color: ORANGE, endLine: 17, id: 'new-id', isActive: true, startLine: 12 },
    ]);
    // Never mutated or absorbed.
    expect(result[0]).toBe(userRange);
  });

  it('does not coalesce with inactive ranges', () => {
    const inactive = range({ endLine: 15, id: 'i', isActive: false, startLine: 10 });
    const result = addChunkRange([inactive], { endLine: 18, startLine: 12 }, fixedId);
    expect(result).toEqual([
      inactive,
      { color: ORANGE, endLine: 19, id: 'new-id', isActive: true, startLine: 12 },
    ]);
  });
});

describe('removeChunkRange', () => {
  it('removes an exactly-covering non-userModified active range', () => {
    const existing = [range({ color: RED, endLine: 15, id: 'a', startLine: 10 })];
    expect(removeChunkRange(existing, { endLine: 14, startLine: 10 })).toEqual([]);
  });

  it('trims a wider range: [5,30) minus chunk {10,14} -> [5,10) + [15,30)', () => {
    const existing = [range({ color: RED, endLine: 30, id: 'a', startLine: 5 })];
    const result = removeChunkRange(existing, { endLine: 14, startLine: 10 });
    expect(result).toEqual([
      { color: RED, endLine: 10, id: 'a', isActive: true, startLine: 5 },
      { color: RED, endLine: 30, id: 'a:15', isActive: true, startLine: 15 },
    ]);
  });

  it('never removes or trims a userModified range', () => {
    const existing = [
      range({ color: RED, endLine: 20, id: 'u', startLine: 10, userModified: true }),
    ];
    expect(removeChunkRange(existing, { endLine: 20, startLine: 10 })).toEqual(existing);
  });

  it('leaves inactive ranges untouched', () => {
    const existing = [range({ color: RED, endLine: 15, id: 'i', isActive: false, startLine: 10 })];
    expect(removeChunkRange(existing, { endLine: 14, startLine: 10 })).toEqual(existing);
  });

  it('keeps a non-overlapping active range verbatim', () => {
    const existing = [range({ color: RED, endLine: 25, id: 'a', startLine: 20 })];
    expect(removeChunkRange(existing, { endLine: 14, startLine: 10 })).toEqual(existing);
  });
});

describe('chunkCoverage', () => {
  const chunk = { endLine: 14, startLine: 10 }; // span [10,15)

  it('unselected file -> unchecked', () => {
    expect(chunkCoverage(false, [range({ endLine: 15, startLine: 10 })], chunk)).toBe('unchecked');
  });

  it('selected file with undefined ranges -> checked (whole-file semantics)', () => {
    expect(chunkCoverage(true, undefined, chunk)).toBe('checked');
  });

  it('selected file with empty ranges -> checked (whole-file semantics)', () => {
    expect(chunkCoverage(true, [], chunk)).toBe('checked');
  });

  it('fully covered by one active range -> checked', () => {
    expect(chunkCoverage(true, [range({ endLine: 15, id: 'a', startLine: 10 })], chunk)).toBe(
      'checked'
    );
  });

  it('fully covered by the union of two active ranges -> checked', () => {
    expect(
      chunkCoverage(
        true,
        [
          range({ endLine: 12, id: 'a', startLine: 8 }),
          range({ endLine: 16, id: 'b', startLine: 12 }),
        ],
        chunk
      )
    ).toBe('checked');
  });

  it('partially covered -> indeterminate', () => {
    expect(chunkCoverage(true, [range({ endLine: 13, id: 'a', startLine: 10 })], chunk)).toBe(
      'indeterminate'
    );
  });

  it('zero overlap while other ranges exist -> unchecked', () => {
    expect(chunkCoverage(true, [range({ endLine: 25, id: 'a', startLine: 20 })], chunk)).toBe(
      'unchecked'
    );
  });

  it('coverage only from an inactive range -> unchecked', () => {
    expect(
      chunkCoverage(true, [range({ endLine: 15, id: 'a', isActive: false, startLine: 10 })], chunk)
    ).toBe('unchecked');
  });
});

describe('fileCoverage', () => {
  it('unselected -> unchecked regardless of children', () => {
    expect(fileCoverage(false, ['checked'])).toBe('unchecked');
  });

  it('selected with zero children -> checked', () => {
    expect(fileCoverage(true, [])).toBe('checked');
  });

  it('all children checked -> checked', () => {
    expect(fileCoverage(true, ['checked', 'checked'])).toBe('checked');
  });

  it('mixed children -> indeterminate', () => {
    expect(fileCoverage(true, ['checked', 'indeterminate'])).toBe('indeterminate');
    expect(fileCoverage(true, ['checked', 'unchecked'])).toBe('indeterminate');
    expect(fileCoverage(true, ['unchecked', 'unchecked'])).toBe('indeterminate');
  });
});
