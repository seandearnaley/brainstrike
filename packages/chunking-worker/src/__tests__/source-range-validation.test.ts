import { describe, expect, it } from 'vitest';
import { resolveSourceRanges } from '../source-range-resolution';
import {
  buildLineStartOffsets,
  findLineForOffset,
  matchesChunkSourceRange,
} from '../source-range-validation';

describe('canonical provided source span validation', () => {
  it('accepts the exact span the chunker located, never its whitespace-normalized text (BST-1989)', () => {
    for (const [source, chunk] of [
      ['first\r\nsecond', 'first\nsecond'],
      ['before\n\n  after', 'beforeafter'],
      ['literal source', 'literal source'],
    ] as const) {
      const range = resolveSourceRanges(source, [{ content: chunk }], 0).ranges[0];
      expect(range).not.toBeNull();
      if (!range) {
        throw new Error('Expected the canonical source span');
      }
      const span = source.slice(range.startOffset, range.endOffset);
      expect(matchesChunkSourceRange(source, span, range.startOffset, range.endOffset)).toBe(true);
      expect(matchesChunkSourceRange(source, chunk, range.startOffset, range.endOffset)).toBe(
        chunk === span
      );
      expect(findLineForOffset(buildLineStartOffsets(source), range.endOffset - 1)).toBe(
        range.endLine
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
