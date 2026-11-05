import { describe, expect, it } from 'vitest';
import { countLines, parseNumstatZ } from '../../src/git-workspace/structured-diff-parsers.ts';

describe('parseNumstatZ', () => {
  it('parses a plain modify entry', () => {
    const output = '3\t1\tfoo.txt\0';
    expect(parseNumstatZ(output)).toEqual([
      { additions: 3, deletions: 1, oldPath: null, path: 'foo.txt' },
    ]);
  });

  it('recovers both oldPath and path from a rename triple without a filter-induced shift', () => {
    // Real `git diff --numstat -z --find-renames` byte layout, confirmed empirically:
    // "adds\tdels\t" NUL oldPath NUL newPath NUL (no trailing path in the first field).
    const output = '2\t0\t\0modified.txt\0renamed.txt\0';
    expect(parseNumstatZ(output)).toEqual([
      { additions: 2, deletions: 0, oldPath: 'modified.txt', path: 'renamed.txt' },
    ]);
  });

  it('maps binary "-\\t-\\t" counts to null', () => {
    const output = '-\t-\timage.bin\0';
    expect(parseNumstatZ(output)).toEqual([
      { additions: null, deletions: null, oldPath: null, path: 'image.bin' },
    ]);
  });

  it('preserves a tab embedded in the path (a `-z` path is emitted verbatim, not quoted)', () => {
    const output = '2\t0\ttab\tname.txt\0';
    expect(parseNumstatZ(output)).toEqual([
      { additions: 2, deletions: 0, oldPath: null, path: 'tab\tname.txt' },
    ]);
  });

  it('handles a binary rename triple ("-\\t-\\t" NUL oldPath NUL newPath)', () => {
    const output = '-\t-\t\0old.bin\0new.bin\0';
    expect(parseNumstatZ(output)).toEqual([
      { additions: null, deletions: null, oldPath: 'old.bin', path: 'new.bin' },
    ]);
  });

  it('parses multiple entries including a mix of plain, binary, and rename records', () => {
    // Real output observed from a staged plain add + binary edit + rename+edit.
    const output = [
      '1\t0\tadded.txt',
      '-\t-\timage.bin',
      '2\t0\t',
      'modified.txt',
      'renamed.txt',
      '',
    ].join('\0');
    expect(parseNumstatZ(output)).toEqual([
      { additions: 1, deletions: 0, oldPath: null, path: 'added.txt' },
      { additions: null, deletions: null, oldPath: null, path: 'image.bin' },
      { additions: 2, deletions: 0, oldPath: 'modified.txt', path: 'renamed.txt' },
    ]);
  });

  it('returns an empty array for empty output (no changes)', () => {
    expect(parseNumstatZ('')).toEqual([]);
  });

  it('throws with the record content when a record has an unexpected empty field', () => {
    // A record that is not a well-formed "adds\tdels\tpath" or rename-triple shape
    // (an empty field appearing where a normal record was expected) must throw
    // rather than being silently dropped by a Boolean filter (spike shortcut).
    const output = '3\t1\tfoo.txt\0\0bar\t1\t2\0';
    expect(() => parseNumstatZ(output)).toThrow(/malformed/iu);
  });

  it('throws with the record content when a rename triple is missing its new path', () => {
    const output = '2\t0\t\0modified.txt\0';
    expect(() => parseNumstatZ(output)).toThrow(/modified\.txt|rename/iu);
  });

  it('throws on a record with a non-numeric count', () => {
    const output = 'x\t1\tfoo.txt\0';
    expect(() => parseNumstatZ(output)).toThrow(/count/iu);
  });
});

describe('countLines', () => {
  it('counts a single newline-terminated line as 1, not 2', () => {
    expect(countLines('new\n')).toBe(1);
  });

  it('counts two non-terminated lines as 2', () => {
    expect(countLines('a\nb')).toBe(2);
  });

  it('counts empty text as 0', () => {
    expect(countLines('')).toBe(0);
  });

  it('counts multi-line trailing-newline text without an off-by-one', () => {
    expect(countLines('a\nb\n')).toBe(2);
  });
});
