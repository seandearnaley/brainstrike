import { describe, expect, it } from 'vitest';

import { calculatePathDepth, extractPathSegments } from '../path-utils';

describe('extractPathSegments', () => {
  it('returns an empty array for an empty string', () => {
    expect(extractPathSegments('')).toEqual([]);
  });

  it('returns an empty array for a single root slash', () => {
    expect(extractPathSegments('/')).toEqual([]);
  });

  it('splits a simple relative path', () => {
    expect(extractPathSegments('a/b/c')).toEqual(['a', 'b', 'c']);
  });

  it('strips leading and trailing slashes', () => {
    expect(extractPathSegments('/a/b/')).toEqual(['a', 'b']);
  });

  it('collapses consecutive slashes', () => {
    expect(extractPathSegments('a//b///c')).toEqual(['a', 'b', 'c']);
  });

  it('returns a single segment when there are no slashes', () => {
    expect(extractPathSegments('file.txt')).toEqual(['file.txt']);
  });

  it('matches the semantics of split+filter(Boolean) for messy paths', () => {
    const inputs = ['', '/', 'a', 'a/b', '/a/b/', 'a//b', '//a//b//c//', 'a/b/c.tsx', '/'];
    for (const input of inputs) {
      expect(extractPathSegments(input)).toEqual(input.split('/').filter(Boolean));
    }
  });
});

describe('calculatePathDepth', () => {
  it.each([
    ['', 0],
    ['file.txt', 0],
    ['foo/bar', 1],
    ['foo/bar/baz', 2],
    ['foo/bar/', 2],
    ['/foo/bar', 2],
    ['a//b', 2],
    ['/', 1],
  ] satisfies [
    string,
    number,
  ][])('counts slash separators in %j', (path: string, expected: number) => {
    expect(calculatePathDepth(path)).toBe(expected);
  });

  it('matches split separator-count semantics for representative paths', () => {
    const paths: string[] = ['', '/', 'a', 'a/b', '/a/b/', 'a//b', '//a//b//c//', 'a/b/c.tsx'];

    for (const path of paths) {
      expect(calculatePathDepth(path)).toBe(path.split('/').length - 1);
    }
  });
});
