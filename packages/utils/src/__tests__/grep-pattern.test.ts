import { describe, expect, it } from 'vitest';
import {
  escapeLikeLiteral,
  extractTrigramLiteral,
  MIN_TRIGRAM_LITERAL_LENGTH,
} from '../grep-pattern.js';

describe('escapeLikeLiteral', () => {
  it('escapes LIKE metacharacters and backslashes', () => {
    expect(escapeLikeLiteral('100%_done\\x')).toBe('100\\%\\_done\\\\x');
  });

  it('passes plain text through unchanged', () => {
    expect(escapeLikeLiteral('createForegroundEmbeddingGate')).toBe(
      'createForegroundEmbeddingGate'
    );
  });
});

describe('extractTrigramLiteral', () => {
  it('returns the longest literal run from a regex', () => {
    expect(extractTrigramLiteral('embedding\\s+gate\\(')).toBe('embedding');
  });

  it('treats escaped punctuation as literal characters', () => {
    // \. is a literal dot — "config.load" wins over "load"
    expect(extractTrigramLiteral('config\\.load')).toBe('config.load');
  });

  it('drops the character preceding ? and * quantifiers', () => {
    // "colou?r": the u is optional, so only "colo" + "r" are guaranteed
    expect(extractTrigramLiteral('colou?r')).toBe('colo');
  });

  it('keeps the character preceding + (at least one occurrence)', () => {
    expect(extractTrigramLiteral('foob+ar')).toBe('foob');
  });

  it('drops the character preceding a brace quantifier', () => {
    expect(extractTrigramLiteral('abcd{0,3}ef')).toBe('abc');
  });

  it('breaks runs at character classes, dots, and anchors', () => {
    expect(extractTrigramLiteral('^get[A-Z]\\w+Handler$')).toBe('Handler');
  });

  it('breaks runs at class escapes like \\d and \\w', () => {
    expect(extractTrigramLiteral('version\\d+')).toBe('version');
  });

  it('does NOT leak encoding chars of \\x / \\u / octal / \\c escapes into the literal', () => {
    // \x66 decodes to 'f' — the "66" must NOT become a fixed-string literal that a
    // prefilter would search for (would silently miss a line matching "foo").
    expect(extractTrigramLiteral('\\x66oo')).toBeNull(); // guaranteed run "oo" < 3
    expect(extractTrigramLiteral('\\u0066oo')).toBeNull();
    expect(extractTrigramLiteral('\\060oo')).toBeNull(); // octal
    // A genuine guaranteed literal AFTER the escape is still extracted (sound: the
    // escaped char prefixes it, so the literal is a substring of every match).
    expect(extractTrigramLiteral('\\x66foobar')).toBe('foobar');
    expect(extractTrigramLiteral('\\u0066foobar')).toBe('foobar');
    expect(extractTrigramLiteral('\\u{66}foobar')).toBe('foobar');
    expect(extractTrigramLiteral('\\cAfoobar')).toBe('foobar');
  });

  it('returns null when no literal run reaches the minimum length', () => {
    expect(extractTrigramLiteral('\\d+\\.\\d+')).toBeNull();
    expect(extractTrigramLiteral('a.b.c')).toBeNull();
  });

  it('returns null for alternation (no single required literal)', () => {
    expect(extractTrigramLiteral('foobar|bazqux')).toBeNull();
  });

  it('returns null for negative lookaround (asserted-absent text is not required)', () => {
    expect(extractTrigramLiteral('(?!forbidden)allowed')).toBeNull();
    expect(extractTrigramLiteral('(?<!skip)needle')).toBeNull();
  });

  it('returns null for unparsed group prefixes (non-capturing, named, lookahead)', () => {
    expect(extractTrigramLiteral('(?:foo)bar')).toBeNull();
    expect(extractTrigramLiteral('(?=foo)bar')).toBeNull();
    expect(extractTrigramLiteral('(?<name>foo)bar')).toBeNull();
  });

  it('returns null when a group is optionalized (cannot attribute runs safely)', () => {
    expect(extractTrigramLiteral('(prefix)?suffix')).toBeNull();
  });

  it('collects literals inside non-optional groups', () => {
    expect(extractTrigramLiteral('(needle)stack')).toBe('needle');
  });

  it('exports the minimum literal length used by the service', () => {
    expect(MIN_TRIGRAM_LITERAL_LENGTH).toBe(3);
  });
});
