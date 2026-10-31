import { describe, expect, it } from 'vitest';
import {
  countLines,
  parseHunkHeaders,
  parseNumstatZ,
} from '../../src/git-workspace/structured-diff-parsers.ts';

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

describe('parseHunkHeaders', () => {
  it('extracts a single hunk with explicit counts', () => {
    const diff = ['diff --git a/foo.txt b/foo.txt', '@@ -10,7 +10,8 @@ context', '+added'].join(
      '\n'
    );
    expect(parseHunkHeaders(diff)).toEqual([
      { newLines: 8, newStart: 10, oldLines: 7, oldStart: 10 },
    ]);
  });

  it('defaults an omitted count to 1', () => {
    const diff = '@@ -1 +1 @@';
    expect(parseHunkHeaders(diff)).toEqual([
      { newLines: 1, newStart: 1, oldLines: 1, oldStart: 1 },
    ]);
  });

  it('extracts multiple hunks in order', () => {
    const diff = ['@@ -1,2 +1,2 @@', '-old', '+new', '@@ -10,3 +11,4 @@', ' context'].join('\n');
    expect(parseHunkHeaders(diff)).toEqual([
      { newLines: 2, newStart: 1, oldLines: 2, oldStart: 1 },
      { newLines: 4, newStart: 11, oldLines: 3, oldStart: 10 },
    ]);
  });

  it('does not match "@@" appearing mid-line rather than at line start', () => {
    const diff = ['@@ -1,2 +1,2 @@', '+  const s = "@@ -9,9 +9,9 @@ not a header";'].join('\n');
    expect(parseHunkHeaders(diff)).toEqual([
      { newLines: 2, newStart: 1, oldLines: 2, oldStart: 1 },
    ]);
  });

  it('tolerates the literal "…(output truncated)" marker line without throwing', () => {
    const diff = ['@@ -1,2 +1,2 @@', '-old', '…(output truncated)'].join('\n');
    expect(parseHunkHeaders(diff)).toEqual([
      { newLines: 2, newStart: 1, oldLines: 2, oldStart: 1 },
    ]);
  });

  it('throws when a line matched as a hunk header but cannot be parsed', () => {
    const diff = '@@ -abc +1 @@';
    expect(() => parseHunkHeaders(diff)).toThrow(/malformed|hunk/iu);
  });

  it('tolerates a partial header cut off immediately before the truncation marker', () => {
    // boundOutput slices at a raw char offset, so an over-cap diff can end
    // mid-header, right before the visible truncation marker — this is the
    // hunks-only over-cap path the marker exists to serve, not malformed input.
    const diff = ['@@ -120,7 +1', '…(output truncated)'].join('\n');
    expect(parseHunkHeaders(diff)).toEqual([]);
  });

  it('still throws on a malformed header NOT immediately followed by the truncation marker', () => {
    const diff = ['@@ -120,7 +1', 'some other content'].join('\n');
    expect(() => parseHunkHeaders(diff)).toThrow(/malformed|hunk/iu);
  });

  it('throws when a second "diff --git " header appears (single-file precondition)', () => {
    const diff = [
      'diff --git a/foo.txt b/foo.txt',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      'diff --git a/bar.txt b/bar.txt',
      '@@ -1,1 +1,1 @@',
    ].join('\n');
    expect(() => parseHunkHeaders(diff)).toThrow(/single-file|diff --git/iu);
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
