import { describe, expect, it } from 'vitest';
import { startsWithDoubleCharPrefix, startsWithPrefix } from '../string-prefix';

describe('startsWithPrefix', () => {
  describe('basic matching', () => {
    it('returns true when path starts with prefix followed by separator', () => {
      expect(startsWithPrefix('/foo/bar', '/foo', '/')).toBe(true);
    });

    it('returns false when path does not start with prefix', () => {
      expect(startsWithPrefix('/baz/bar', '/foo', '/')).toBe(false);
    });

    it('returns true for nested path matching', () => {
      expect(startsWithPrefix('/foo/bar/baz', '/foo', '/')).toBe(true);
    });

    it('returns true for single char prefix', () => {
      expect(startsWithPrefix('a/b', 'a', '/')).toBe(true);
    });
  });

  describe('exact prefix without separator', () => {
    it('returns false when path exactly equals prefix (no trailing separator)', () => {
      expect(startsWithPrefix('/foo', '/foo', '/')).toBe(false);
    });

    it('returns false when path equals prefix (length check fails)', () => {
      expect(startsWithPrefix('abc', 'abc', '/')).toBe(false);
    });
  });

  describe('prefix is substring but wrong separator', () => {
    it('returns false when char after prefix is not the separator', () => {
      expect(startsWithPrefix('/fooXbar', '/foo', '/')).toBe(false);
    });

    it('returns false when prefix is followed by a different character', () => {
      expect(startsWithPrefix('abc-def', 'abc', '/')).toBe(false);
    });
  });

  describe('empty strings', () => {
    it('returns false when both path and prefix are empty', () => {
      expect(startsWithPrefix('', '', '/')).toBe(false);
    });

    it('returns true when prefix is empty and path starts with separator', () => {
      // path.length > prefix.length (any non-empty > 0) AND charCodeAt(0) === separator
      expect(startsWithPrefix('/foo', '', '/')).toBe(true);
    });

    it('returns false when prefix is empty and path does not start with separator', () => {
      expect(startsWithPrefix('foo', '', '/')).toBe(false);
    });

    it('returns false when path is empty and prefix is not', () => {
      expect(startsWithPrefix('', '/foo', '/')).toBe(false);
    });
  });

  describe('prefix longer than path', () => {
    it('returns false when prefix is longer than path', () => {
      expect(startsWithPrefix('/fo', '/foo', '/')).toBe(false);
    });

    it('returns false when prefix is much longer than path', () => {
      expect(startsWithPrefix('a', 'abcdef', '/')).toBe(false);
    });
  });

  describe('different separators', () => {
    it('works with colon separator', () => {
      expect(startsWithPrefix('folder:file', 'folder', ':')).toBe(true);
      expect(startsWithPrefix('folder/file', 'folder', ':')).toBe(false);
    });

    it('works with backslash separator', () => {
      expect(startsWithPrefix('C\\Users\\file', 'C', '\\')).toBe(true);
      expect(startsWithPrefix('C/Users/file', 'C', '\\')).toBe(false);
    });

    it('works with dot separator', () => {
      expect(startsWithPrefix('com.example.app', 'com', '.')).toBe(true);
      expect(startsWithPrefix('com/example/app', 'com', '.')).toBe(false);
    });

    it('works with pipe separator', () => {
      expect(startsWithPrefix('a|b|c', 'a', '|')).toBe(true);
    });
  });

  describe('undefined/null edge cases', () => {
    it('throws TypeError when path is undefined', () => {
      expect(() => startsWithPrefix(undefined as unknown as string, '/foo', '/')).toThrow();
    });

    it('throws TypeError when prefix is undefined', () => {
      expect(() => startsWithPrefix('/foo/bar', undefined as unknown as string, '/')).toThrow();
    });

    it('throws TypeError when path is null', () => {
      expect(() => startsWithPrefix(null as unknown as string, '/foo', '/')).toThrow();
    });

    it('throws TypeError when prefix is null', () => {
      expect(() => startsWithPrefix('/foo/bar', null as unknown as string, '/')).toThrow();
    });
  });

  describe('runtime validation', () => {
    it('throws when separator has more than 1 character', () => {
      expect(() => startsWithPrefix('/foo/bar', '/foo', '::')).toThrow(
        'startsWithPrefix: separator must be a single character, got "::"'
      );
    });

    it('throws for empty separator', () => {
      expect(() => startsWithPrefix('/foo/bar', '/foo', '')).toThrow(
        'startsWithPrefix: separator must be a single character, got ""'
      );
    });
  });
});

describe('startsWithDoubleCharPrefix', () => {
  describe('basic matching with :: separator', () => {
    it('returns true when value starts with prefix followed by ::', () => {
      expect(startsWithDoubleCharPrefix('folder1::file.ts', 'folder1', '::')).toBe(true);
    });

    it('returns false when value does not start with prefix', () => {
      expect(startsWithDoubleCharPrefix('other::file.ts', 'folder1', '::')).toBe(false);
    });

    it('returns true for nested value after separator', () => {
      expect(startsWithDoubleCharPrefix('folder1::src/index.ts', 'folder1', '::')).toBe(true);
    });
  });

  describe('exact prefix without separator', () => {
    it('returns false when value exactly equals prefix', () => {
      expect(startsWithDoubleCharPrefix('folder1', 'folder1', '::')).toBe(false);
    });

    it('returns false when value is prefix followed by only one separator char', () => {
      expect(startsWithDoubleCharPrefix('folder1:', 'folder1', '::')).toBe(false);
    });

    it('returns false when value is prefix followed by separator but nothing else', () => {
      expect(startsWithDoubleCharPrefix('folder1::', 'folder1', '::')).toBe(false);
    });
  });

  describe('prefix is substring but wrong separator', () => {
    it('returns false when prefix is followed by single colon then other chars', () => {
      expect(startsWithDoubleCharPrefix('folder1:file.ts', 'folder1', '::')).toBe(false);
    });

    it('does not match when prefix is a prefix of another folder ID', () => {
      expect(startsWithDoubleCharPrefix('folder10::file.ts', 'folder1', '::')).toBe(false);
    });
  });

  describe('empty strings', () => {
    it('returns false when both value and prefix are empty', () => {
      expect(startsWithDoubleCharPrefix('', '', '::')).toBe(false);
    });

    it('returns true when prefix is empty and value starts with separator and has content', () => {
      expect(startsWithDoubleCharPrefix('::foo', '', '::')).toBe(true);
    });

    it('returns false when value is empty and prefix is not', () => {
      expect(startsWithDoubleCharPrefix('', 'folder1', '::')).toBe(false);
    });
  });

  describe('length guard ensures content after separator', () => {
    it('requires at least one char after the two-char separator', () => {
      // "abc::" has length 5, prefix "abc" has length 3, 5 > 3 + 2 is false
      expect(startsWithDoubleCharPrefix('abc::', 'abc', '::')).toBe(false);
      // "abc::x" has length 6, 6 > 5 is true
      expect(startsWithDoubleCharPrefix('abc::x', 'abc', '::')).toBe(true);
    });
  });

  describe('runtime validation', () => {
    it('throws when separator is not exactly 2 characters', () => {
      expect(() => startsWithDoubleCharPrefix('a:b', 'a', ':')).toThrow(
        'startsWithDoubleCharPrefix: separator must be exactly 2 characters, got ":"'
      );
    });

    it('throws for empty separator', () => {
      expect(() => startsWithDoubleCharPrefix('a::b', 'a', '')).toThrow(
        'startsWithDoubleCharPrefix: separator must be exactly 2 characters, got ""'
      );
    });

    it('throws for three-char separator', () => {
      expect(() => startsWithDoubleCharPrefix('a:::b', 'a', ':::')).toThrow(
        'startsWithDoubleCharPrefix: separator must be exactly 2 characters, got ":::"'
      );
    });
  });
});
