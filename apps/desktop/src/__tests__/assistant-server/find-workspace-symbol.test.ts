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

  it('falls back to a bounded indentation range when braces never balance (mis-scan)', () => {
    // The single-pass scanner miscounts the `{` inside the regex literal as a
    // real opening brace that never closes. The enclosing range must NOT span to
    // EOF (near-whole-file) — it falls back to the bounded indentation heuristic.
    const content = [
      'const myRegex = /[{]/;', // 1: opening brace miscounted, never balances
      '  helper();', // 2: indented continuation
      'topLevel();', // 3: dedent ends the indent block
      'more();', // 4
      'evenMore();', // 5
    ].join('\n');

    const [match] = findSymbolMatches(content, 'myRegex', {
      maxMatches: 1,
      contextLines: 0,
    }).matches;

    expect(match).toMatchObject({ declarationLine: 1, startLine: 1, endLine: 2 });
  });

  describe('declaration ranking', () => {
    it('surfaces the real declaration over earlier imports/call sites when capped', () => {
      const content = [
        "import { add } from './math';", // 1: import (usage)
        'const x = add(1, 2);', // 2: call (note: leading `const`, but declares x not add)
        'const y = add(3, 4);', // 3: call
        'const z = add(5, 6);', // 4: call
        'const w = add(7, 8);', // 5: call
        'export function add(a: number, b: number): number {', // 6: declaration
        '  return a + b;',
        '}',
      ].join('\n');

      const result = findSymbolMatches(content, 'add', { maxMatches: 2, contextLines: 0 });

      // The actual declaration (line 6) must be surfaced even though it is the
      // 6th substring match and the cap is 2 — declaration-looking lines rank
      // ahead of imports/call sites so the definition isn't crowded out.
      expect(result.matches.map((m) => m.declarationLine)).toContain(6);
      expect(result.totalMatches).toBe(6);
      expect(result.truncated).toBe(true);
      // Selected matches are still presented in file order.
      const ordered = result.matches.map((m) => m.declarationLine);
      expect([...ordered]).toEqual([...ordered].sort((a, b) => a - b));
    });

    it('ranks a const/let/var declaration of the symbol above its uses', () => {
      const content = [
        'foo(handler);', // 1: usage
        'bar(handler);', // 2: usage
        'export const handler = () => {};', // 3: declaration
      ].join('\n');

      const result = findSymbolMatches(content, 'handler', { maxMatches: 1, contextLines: 0 });

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.declarationLine).toBe(3);
    });

    it('ranks a named declaration above earlier call sites that look like `name(`', () => {
      // A bare top-level call `doThing(...)` matches the member-declaration shape
      // (`name(`), so without ranking named declarations higher, a call before
      // the definition would crowd the real `function doThing` past the cap.
      const content = [
        'doThing(initialArgs);', // 1: call (member-decl-shaped)
        'doThing(moreArgs);', // 2: call
        'export function doThing(x: number) {', // 3: the real declaration
        '  return x;',
        '}',
      ].join('\n');

      const [match] = findSymbolMatches(content, 'doThing', {
        maxMatches: 1,
        contextLines: 0,
      }).matches;

      expect(match?.declarationLine).toBe(3);
    });

    it('does not treat a partial-identifier collision as a word-boundary match', () => {
      // `paddle` and `addItem` contain "add" but are not the symbol; the real
      // word-boundary use should outrank them under the cap.
      const content = [
        'const paddle = makePaddle();', // 1: collision (substring only)
        'const list = addItem(list);', // 2: collision (substring only)
        'add(1, 2);', // 3: word-boundary use of `add`
      ].join('\n');

      const result = findSymbolMatches(content, 'add', { maxMatches: 1, contextLines: 0 });

      expect(result.totalMatches).toBe(3);
      expect(result.matches[0]?.declarationLine).toBe(3);
    });
  });
});
