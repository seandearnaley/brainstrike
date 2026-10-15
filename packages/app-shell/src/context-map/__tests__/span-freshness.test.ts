import type { ContextSpan } from '@brainstrike/assistant-ui/thread-context-fold';
import { INACCESSIBLE_CONTENT_PREFIX } from '@brainstrike/file-explorer-hooks';
import { BINARY_CONTENT_MESSAGE } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { isComparableFileText, spanFreshness, splitFileLines } from '../span-freshness';

const read = (startLine: number, deliveredLines: string[]): ContextSpan => ({
  deliveredLines,
  endLine: startLine + deliveredLines.length - 1,
  kind: 'read',
  path: 'src/a.ts',
  startLine,
});

describe('spanFreshness', () => {
  const current = splitFileLines('one\r\ntwo\nthree\nfour');

  it('compares delivered lines with the current lines at the same position', () => {
    expect(spanFreshness(read(2, ['two', 'three']), current)).toBe('unchanged');
    expect(spanFreshness(read(2, ['two', 'THREE']), current)).toBe('changed');
    expect(spanFreshness(read(1, ['one\r']), current)).toBe('unchanged');
  });

  it('reads a file that shrank under the span as changed', () => {
    expect(spanFreshness(read(4, ['four', 'five']), current)).toBe('changed');
  });

  it('is unknown without current text, delivered lines, a start line, or for a repeat read', () => {
    expect(spanFreshness(read(1, ['one']), undefined)).toBe('unknown');
    expect(spanFreshness({ chunkId: 'c', kind: 'semantic', path: 'src/a.ts' }, current)).toBe(
      'unknown'
    );
    expect(
      spanFreshness({ endLine: 2, kind: 'edit', path: 'src/a.ts', startLine: 1 }, current)
    ).toBe('unknown');
    expect(spanFreshness({ ...read(1, ['one']), repeat: true }, current)).toBe('unknown');
  });
});

describe('isComparableFileText', () => {
  it("refuses the explorer's binary and inaccessible placeholders", () => {
    expect(isComparableFileText('text')).toBe(true);
    expect(isComparableFileText(undefined)).toBe(false);
    expect(isComparableFileText(BINARY_CONTENT_MESSAGE)).toBe(false);
    expect(isComparableFileText(`${INACCESSIBLE_CONTENT_PREFIX} - denied`)).toBe(false);
  });
});
