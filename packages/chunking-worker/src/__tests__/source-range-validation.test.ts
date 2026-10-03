import { describe, expect, it } from 'vitest';
import { resolveSourceRanges } from '../source-range-resolution';
import {
  buildLineStartOffsets,
  findLineForOffset,
  matchesChunkSourceRange,
} from '../source-range-validation';

describe('canonical provided source span validation', () => {
  it('uses the same source normalization and offsets as the existing chunker', () => {
    for (const [source, chunk] of [
      ['first\r\nsecond', 'first\nsecond'],
      ['before\n\n  after', 'beforeafter'],
      ['literal source', 'literal source'],
    ]) {
      const range = resolveSourceRanges(source, [{ content: chunk }], 0).ranges[0];
      expect(range).not.toBeNull();
      expect(matchesChunkSourceRange(source, chunk, range!.startOffset, range!.endOffset)).toBe(
        true
      );
      expect(findLineForOffset(buildLineStartOffsets(source), range!.endOffset - 1)).toBe(
        range!.endLine
      );
    }
  });
  it('does not relocate a claimed range or accept empty/out-of-bounds/shifted metadata', () => {
    const source = 'x\nfoo\nfoo';
    expect(matchesChunkSourceRange(source, 'foo', 2, 5)).toBe(true);
    expect(matchesChunkSourceRange(source, 'foo', 1, 5)).toBe(false);
    expect(matchesChunkSourceRange(source, 'foo', 0, 5)).toBe(false);
    expect(matchesChunkSourceRange(source, 'foo', 2, 6)).toBe(false);
    expect(matchesChunkSourceRange(source, 'foo', -1, 5)).toBe(false);
    expect(matchesChunkSourceRange(source, 'foo', 2, 500)).toBe(false);
    expect(matchesChunkSourceRange(source, '', 2, 5)).toBe(false);
  });
});
