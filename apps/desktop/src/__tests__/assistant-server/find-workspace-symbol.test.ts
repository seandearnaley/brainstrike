import { describe, expect, it } from 'vitest';
import { findSymbolMatches } from '../../assistant-server/find-workspace-symbol';

const TS = `import x from 'y';

export function alpha(a: number): number {
  if (a > 0) {
    return a;
  }
  return 0;
}

const note = "function beta() { not real }";

export const gamma = 1;
`;

describe('findSymbolMatches', () => {
  it('returns the enclosing brace block for a function (1-based inclusive)', () => {
    const { matches } = findSymbolMatches(TS, 'alpha', { maxMatches: 5, contextLines: 1 });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ declarationLine: 3, startLine: 3, endLine: 8 });
  });

  it('treats a single-line const as a one-line range', () => {
    const { matches } = findSymbolMatches(TS, 'gamma', { maxMatches: 5, contextLines: 0 });
    expect(matches[0]).toMatchObject({ declarationLine: 12, startLine: 12, endLine: 12 });
  });

  it('ignores braces inside string/comment-only lines for block detection', () => {
    const { matches } = findSymbolMatches(TS, 'beta', { maxMatches: 5, contextLines: 0 });
    expect(matches[0]).toMatchObject({ declarationLine: 10, startLine: 10, endLine: 10 });
  });

  it('handles indent-based blocks (no braces)', () => {
    const py = ['def foo():', '    a = 1', '    return a', '', 'bar = 2'].join('\n');
    const { matches } = findSymbolMatches(py, 'foo', { maxMatches: 5, contextLines: 0 });
    expect(matches[0]).toMatchObject({ declarationLine: 1, startLine: 1, endLine: 3 });
  });

  it('respects maxMatches and reports truncated', () => {
    const many = ['a x', 'b x', 'c x', 'd x'].join('\n');
    const result = findSymbolMatches(many, 'x', { maxMatches: 2, contextLines: 0 });
    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('returns empty for no match', () => {
    const result = findSymbolMatches(TS, 'doesNotExist', { maxMatches: 5, contextLines: 0 });
    expect(result).toMatchObject({ matches: [], totalMatches: 0, truncated: false });
  });
});
