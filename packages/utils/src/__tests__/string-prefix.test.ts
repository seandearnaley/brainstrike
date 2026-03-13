import { describe, expect, it } from 'vitest';
import { startsWithPrefix } from '../string-prefix';

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

  describe('dev-mode assertion', () => {
    it('throws when separator has more than 1 character in non-production env', () => {
      // NODE_ENV defaults to 'test' in vitest, which is not 'production'
      expect(() => startsWithPrefix('/foo/bar', '/foo', '::')).toThrow(
        'startsWithPrefix: separator must be a single character, got "::"'
      );
    });

    it('throws for empty separator in non-production env', () => {
      expect(() => startsWithPrefix('/foo/bar', '/foo', '')).toThrow(
        'startsWithPrefix: separator must be a single character, got ""'
      );
    });
  });
});
