import { describe, expect, it } from 'vitest';
import { buildGrepPattern, escapeRegExpLiteral } from '../workspace-search-executor';

describe('grep pattern derivation', () => {
  it('escapeRegExpLiteral escapes regex metacharacters', () => {
    expect(escapeRegExpLiteral('a.b*c')).toBe('a\\.b\\*c');
  });

  it('wholeWord wraps a literal in \\b after escaping', () => {
    expect(buildGrepPattern({ isRegex: false, query: 'a.b', wholeWord: true })).toEqual({
      isRegex: true,
      pattern: '\\ba\\.b\\b',
    });
  });

  it('wholeWord wraps a regex without escaping', () => {
    expect(buildGrepPattern({ isRegex: true, query: 'foo|bar', wholeWord: true })).toEqual({
      isRegex: true,
      pattern: '\\b(?:foo|bar)\\b',
    });
  });

  it('passes a plain literal through unchanged', () => {
    expect(buildGrepPattern({ isRegex: false, query: 'a.b', wholeWord: false })).toEqual({
      isRegex: false,
      pattern: 'a.b',
    });
  });

  it('passes a plain regex through unchanged', () => {
    expect(buildGrepPattern({ isRegex: true, query: 'foo|bar', wholeWord: false })).toEqual({
      isRegex: true,
      pattern: 'foo|bar',
    });
  });
});
