/**
 * The content-based binary verdict.
 *
 * Written after a 149-record error flood was blamed on this heuristic
 * misclassifying ordinary TypeScript. It had not: four tracked source files
 * carry raw `0x00` bytes (a `'\0'` join separator written as a literal NUL
 * rather than the escape), so `file(1)` calls them `data` and `grep` refuses
 * them too. The verdict was right; the severity and the retry loop around it
 * were wrong. These tests pin the rules so the next such investigation starts
 * from evidence instead of suspicion.
 */

import { describe, expect, it } from 'vitest';
import { isBinaryContent } from '../binary-content';

describe('isBinaryContent', () => {
  it('flags a single NUL byte anywhere in the sample', () => {
    // The real-world case: `orderedIds.join('\0')` written with a literal NUL.
    expect(isBinaryContent("if (a.join('\0') === b.join('\0')) {")).toBe(true);
  });

  it('treats ordinary source as text', () => {
    expect(isBinaryContent('export const x = 1;\n\tconst y = 2;\r\n')).toBe(false);
  });

  it('treats empty content as TEXT, not binary', () => {
    // Guards the 0/0 = NaN edge: an empty read is a zero-token file, and
    // reporting it as binary would hide a genuinely empty file behind an
    // exclusion. A read FAILURE throws and never reaches here.
    expect(isBinaryContent('')).toBe(false);
  });

  it('does not flag U+FFFD replacement characters', () => {
    // Node decodes invalid UTF-8 to U+FFFD (65533), which is neither 0 nor
    // < 32 — so a mis-decoded text file is never mistaken for binary here.
    expect(isBinaryContent('const s = "���";')).toBe(false);
  });

  it('tolerates control characters below the ratio threshold', () => {
    const content = `${'a'.repeat(99)}`;
    expect(isBinaryContent(content)).toBe(false);
  });

  it('flags content once control characters pass the ratio threshold', () => {
    const content = `${''.repeat(11)}${'a'.repeat(89)}`;
    expect(isBinaryContent(content)).toBe(true);
  });

  it('only examines the first 8192 characters', () => {
    // Documents the sampling ceiling: the same defect past the window reads as
    // text, which is why this class of bug looks nondeterministic across files.
    expect(isBinaryContent(`${'a'.repeat(8192)}\0`)).toBe(false);
    expect(isBinaryContent(`${'a'.repeat(8191)}\0`)).toBe(true);
  });
});
