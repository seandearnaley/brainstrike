import { describe, expect, it } from 'vitest';
import {
  addTrailingSlash,
  buildUrl,
  joinUrlParts,
  parseQueryParams,
  removeTrailingSlash,
} from '../url-utils';

describe('url-utils', () => {
  describe('removeTrailingSlash', () => {
    it('removes single trailing slash', () => {
      expect(removeTrailingSlash('https://example.com/path/')).toBe('https://example.com/path');
    });

    it('removes multiple trailing slashes', () => {
      expect(removeTrailingSlash('path//')).toBe('path');
    });

    it('returns same string if no trailing slash', () => {
      expect(removeTrailingSlash('https://example.com')).toBe('https://example.com');
    });
  });

  describe('addTrailingSlash', () => {
    it('adds slash when missing', () => {
      expect(addTrailingSlash('https://example.com')).toBe('https://example.com/');
    });

    it('leaves existing slash', () => {
      expect(addTrailingSlash('https://example.com/')).toBe('https://example.com/');
    });
  });

  describe('joinUrlParts', () => {
    it('joins parts without duplicating slashes', () => {
      const result = joinUrlParts('http://example.com/', '/path/', 'to/', '/resource');
      expect(result).toBe('http://example.com/path/to/resource');
    });

    it('normalizes repeated slashes', () => {
      const result = joinUrlParts('http://example.com///', '//path', 'to//', '/resource');
      expect(result).toBe('http://example.com/path/to/resource');
    });
  });

  describe('buildUrl', () => {
    it('builds url with query params', () => {
      const url = buildUrl('https://example.com/api', {
        a: 1,
        b: 'two',
        c: true,
      });
      expect(url).toBe('https://example.com/api?a=1&b=two&c=true');
    });

    it('omits null and undefined params', () => {
      const url = buildUrl('https://example.com', {
        a: null,
        b: undefined,
        c: '3',
      });
      expect(url).toBe('https://example.com/?c=3');
    });
  });

  describe('parseQueryParams', () => {
    it('parses query string from full url', () => {
      const params = parseQueryParams('https://example.com/search?q=test&sort=asc');
      expect(params).toEqual({ q: 'test', sort: 'asc' });
    });

    it('parses raw query string', () => {
      const params = parseQueryParams('?a=1&b=2');
      expect(params).toEqual({ a: '1', b: '2' });
    });
  });
});
