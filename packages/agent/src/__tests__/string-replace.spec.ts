/**
 * Unit coverage for the PURE fuzzy-match cascade behind
 * `brainstrike.stringReplaceWorkspaceFile` (packages/agent/src/tools/string-replace.ts).
 *
 * Proves each cascade branch applies correctly (exact, whitespace-normalized,
 * Levenshtein-fuzzy), and — critically — that the two SAFETY refusals THROW
 * rather than guessing (no silent fallbacks):
 *   - a single-line old_str matching MULTIPLE lines → StringReplaceError('ambiguous')
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
    // File uses a tab + trailing spaces; old_str uses plain spaces.
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

describe('applyStringReplace — Levenshtein-fuzzy match', () => {
  it('applies a close (non-exact) multi-line match within tolerance', () => {
    // old_str has a tiny typo on the second line ("return" vs "return") that
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
  it('THROWS ambiguous when a single-line old_str matches multiple lines (no write)', () => {
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

  it('THROWS not_found when old_str has no sufficiently close match', () => {
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

  it('THROWS no_op when old_str equals new_str', () => {
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
