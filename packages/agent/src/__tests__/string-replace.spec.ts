/**
 * Unit coverage for the PURE fuzzy-match cascade behind
 * `brainstrike.stringReplaceWorkspaceFile` (packages/agent/src/tools/string-replace.ts).
 *
 * Proves each cascade branch applies correctly (exact, whitespace-normalized,
 * Levenshtein-fuzzy), and — critically — that the two SAFETY refusals THROW
 * rather than guessing (no silent fallbacks):
 *   - a single-line oldStr matching MULTIPLE lines → StringReplaceError('ambiguous')
 *   - no sufficiently close match → StringReplaceError('not_found'), surfacing the
 *     "diverged after N lines" diagnostic when a fuzzy match drifted.
 */
import { describe, expect, it } from 'vitest';
import { applyStringReplace, StringReplaceError } from '../tools/string-replace';

describe('applyStringReplace — exact match', () => {
  it('replaces an exact multi-line block and leaves the rest intact', () => {
    const fileContent = ['line a', 'export const x = 1;', 'line c'].join('\n');
    const result = applyStringReplace({
      fileContent,
      oldStr: 'export const x = 1;',
      newStr: 'export const x = 42;',
    });
    expect(result.matchType).toBe('exact');
    expect(result.newContent).toBe(['line a', 'export const x = 42;', 'line c'].join('\n'));
  });

  it('deletes a block when newStr is empty', () => {
    const fileContent = 'before\nREMOVE ME\nafter';
    const result = applyStringReplace({
      fileContent,
      oldStr: '\nREMOVE ME',
      newStr: '',
    });
    expect(result.newContent).toBe('before\nafter');
  });
});

describe('applyStringReplace — whitespace-normalized match', () => {
  it('matches when only indentation/whitespace differs from the file', () => {
    // File uses a tab + trailing spaces; oldStr uses plain spaces.
    const fileContent = ['function f() {', '\treturn   1 ;', '}'].join('\n');
    const result = applyStringReplace({
      fileContent,
      oldStr: 'return 1 ;',
      newStr: '    return 2;',
    });
    expect(result.matchType).toBe('whitespace-normalized');
    expect(result.newContent).toContain('return 2;');
    expect(result.newContent).not.toContain('return   1');
    // Surrounding lines preserved.
    expect(result.newContent.startsWith('function f() {')).toBe(true);
    expect(result.newContent.endsWith('}')).toBe(true);
  });
});

describe('applyStringReplace — WHITESPACE-NORMALIZED duplicate guard (wrong-location-edit fix)', () => {
  // Regression: the exact guard counts EXACT occurrences, so an oldStr that
  // matches only AFTER whitespace normalization sees 0 and the guard never
  // fires. The whitespace-normalized branch then picked the FIRST window
  // silently — a wrong-location edit when the normalized block occurs more than
  // once. The branch now counts normalize-matching windows and refuses >1,
  // consistent with the exact and single-line fuzzy guards.

  it('THROWS ambiguous when oldStr matches >1 location ONLY after whitespace normalization (writes nothing)', () => {
    // Two identical statements, one tab-indented and one space-indented; oldStr
    // uses a DOUBLE space so it is not an exact substring of either line (the
    // exact guard sees 0), yet normalizes equal to BOTH.
    const fileContent = ['function f() {', '\treturn x;', '    return x;', '}'].join('\n');
    let thrown: unknown;
    try {
      applyStringReplace({ fileContent, oldStr: 'return  x;', newStr: 'return y;' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StringReplaceError);
    const typed = thrown as StringReplaceError;
    expect(typed.reason).toBe('ambiguous');
    expect(typed.message).toMatch(/normaliz/i);
    expect(typed.message).toContain('surrounding');
    // The message reports the colliding line numbers (lines 2 and 3).
    expect(typed.message).toMatch(/2, 3/);
  });

  it('applies the edit when exactly ONE location matches after whitespace normalization', () => {
    // Only the tab-indented statement matches the double-spaced oldStr's
    // normalized form; the other line is genuinely different.
    const fileContent = ['function f() {', '\treturn x;', '    return other;', '}'].join('\n');
    const result = applyStringReplace({
      fileContent,
      oldStr: 'return  x;',
      newStr: 'return y;',
    });
    expect(result.matchType).toBe('whitespace-normalized');
    expect(result.newContent).toContain('return y;');
    expect(result.newContent).toContain('return other;');
    // The unique match was edited; the distinct line is untouched.
    expect(result.newContent).not.toContain('return x;');
  });
});

describe('applyStringReplace — Levenshtein-fuzzy match', () => {
  it('applies a close (non-exact) multi-line match within tolerance', () => {
    // oldStr has a tiny typo on the second line ("return" vs "return") that
    // exceeds exact + whitespace matching but is within the <5% Levenshtein
    // tolerance, so the fuzzy branch should still locate and replace the block.
    const fileContent = ['const config = {', '  enabled: true,', '  retries: 3,', '};'].join('\n');
    const result = applyStringReplace({
      fileContent,
      oldStr: ['const config = {', '  enabled: true,', '  retries: 3,', '};'].join('\n'),
      newStr: ['const config = {', '  enabled: false,', '  retries: 5,', '};'].join('\n'),
    });
    expect(result.newContent).toContain('enabled: false');
    expect(result.newContent).toContain('retries: 5');
    expect(result.newContent).not.toContain('retries: 3');
  });
});

describe('applyStringReplace — SAFETY refusals (no silent fallbacks)', () => {
  it('THROWS ambiguous when a single-line oldStr matches multiple lines (no write)', () => {
    const fileContent = ['count++;', 'doThing();', 'count++;', 'doOther();', 'count++;'].join('\n');
    let thrown: unknown;
    try {
      applyStringReplace({ fileContent, oldStr: 'count++;', newStr: 'count--;' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StringReplaceError);
    const typed = thrown as StringReplaceError;
    expect(typed.reason).toBe('ambiguous');
    // The message tells the model how to recover and lists the colliding lines.
    expect(typed.message).toMatch(/multiple|matches \d+ locations/i);
    expect(typed.message).toContain('surrounding');
  });

  it('applies a single-line edit that is UNIQUE (the guard only fires on collisions)', () => {
    const fileContent = ['count++;', 'doThing();', 'uniqueMarker();'].join('\n');
    const result = applyStringReplace({
      fileContent,
      oldStr: 'uniqueMarker();',
      newStr: 'replacedMarker();',
    });
    expect(result.newContent).toContain('replacedMarker();');
    expect(result.newContent).not.toContain('uniqueMarker();');
  });

  it('THROWS not_found when oldStr has no sufficiently close match', () => {
    const fileContent = 'alpha\nbeta\ngamma';
    let thrown: unknown;
    try {
      applyStringReplace({
        fileContent,
        oldStr: 'this text does not appear anywhere in the file at all',
        newStr: 'x',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StringReplaceError);
    expect((thrown as StringReplaceError).reason).toBe('not_found');
  });

  it('surfaces the "diverged after N lines" diagnostic when a fuzzy match drifts', () => {
    // The first line matches exactly, but a later line diverges far beyond
    // tolerance, so the fuzzy matcher should refuse AND explain where it diverged.
    const fileContent = [
      'function compute(input) {',
      '  const total = input * 2;',
      '  return total;',
      '}',
    ].join('\n');
    let thrown: unknown;
    try {
      applyStringReplace({
        fileContent,
        oldStr: [
          'function compute(input) {',
          '  const COMPLETELY_DIFFERENT_LINE_THAT_WILL_NOT_MATCH_AT_ALL = 999999;',
          '  return total;',
          '}',
        ].join('\n'),
        newStr: 'replacement',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StringReplaceError);
    const typed = thrown as StringReplaceError;
    expect(typed.reason).toBe('not_found');
    expect(typed.message).toContain('diverged after');
  });

  it('THROWS no_op when oldStr equals newStr', () => {
    let thrown: unknown;
    try {
      applyStringReplace({ fileContent: 'a\nb\nc', oldStr: 'b', newStr: 'b' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StringReplaceError);
    expect((thrown as StringReplaceError).reason).toBe('no_op');
  });
});

describe('applyStringReplace — MULTI-LINE duplicate block guard (over-broad-edit fix)', () => {
  // Regression: tryExactMatch previously did split(oldStr).join(newStr) = replace
  // ALL, and the occurrence guard was single-line-only. A multi-line block
  // appearing N>1 times rewrote EVERY location with matchType 'exact'. The guard
  // now counts EXACT occurrences regardless of newlines and refuses >1.
  const block = ['if (cfg) {', '  enable();', '}'].join('\n');

  it('THROWS ambiguous when a multi-line block appears exactly twice (writes nothing)', () => {
    const fileContent = [block, 'middle();', block, 'tail();'].join('\n');
    let thrown: unknown;
    try {
      applyStringReplace({ fileContent, oldStr: block, newStr: 'disable();' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StringReplaceError);
    const typed = thrown as StringReplaceError;
    expect(typed.reason).toBe('ambiguous');
    expect(typed.message).toMatch(/2 locations/);
    expect(typed.message).toContain('surrounding');
  });

  it('THROWS ambiguous when a multi-line block appears exactly three times', () => {
    const fileContent = [block, 'a();', block, 'b();', block].join('\n');
    expect(() => applyStringReplace({ fileContent, oldStr: block, newStr: 'x();' })).toThrow(
      /3 locations/
    );
  });

  it('applies a multi-line block that appears exactly ONCE — and only that occurrence', () => {
    // The unique block is surrounded by a SIMILAR-but-distinct block so a buggy
    // replace-all would also corrupt the neighbor.
    const uniqueBlock = ['if (cfg) {', '  enableUnique();', '}'].join('\n');
    const neighbor = ['if (cfg) {', '  enableOther();', '}'].join('\n');
    const fileContent = [neighbor, 'sep();', uniqueBlock, 'sep();'].join('\n');
    const result = applyStringReplace({
      fileContent,
      oldStr: uniqueBlock,
      newStr: 'if (cfg) {\n  enableReplaced();\n}',
    });
    expect(result.matchType).toBe('exact');
    expect(result.newContent).toContain('enableReplaced();');
    // The neighbor block was NOT touched.
    expect(result.newContent).toContain('enableOther();');
    // The original unique body is gone.
    expect(result.newContent).not.toContain('enableUnique();');
  });
});

describe('applyStringReplace — no-op success guard (silent-failure fix)', () => {
  it('THROWS not_found when a fuzzy replace-in-line match produces NO change', () => {
    // The fuzzy replace-in-line branch selects the line "  return foo ( x ) ;"
    // via a whitespace-removed includes() match for "foo(x)", but the RAW
    // .replace('foo(x)', …) finds nothing because the literal differs (the file
    // line has interior spaces). Pre-fix this returned replaced=true on an
    // UNCHANGED file (silent failure); assertChanged now throws not_found with the
    // "located but produced no change" message instead of a phantom success.
    const fileContent = 'head\n  return foo ( x ) ;\ntail';
    let thrown: unknown;
    try {
      applyStringReplace({
        fileContent,
        oldStr: 'foo(x)',
        newStr: 'bar(x)',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StringReplaceError);
    const typed = thrown as StringReplaceError;
    expect(typed.reason).toBe('not_found');
    // Specifically the no-op guard, not a generic miss.
    expect(typed.message).toContain('produced no change');
  });
});
