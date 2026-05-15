import { describe, expect, it } from 'vitest';

import { getPathDepth } from '../path-depth';

describe('getPathDepth', () => {
  it.each([
    ['', 0],
    ['foo', 0],
    ['foo/bar', 1],
    ['foo/bar/baz', 2],
    ['foo/bar/', 2],
    ['/foo/bar', 2],
    ['foo//bar', 2],
    ['/', 1],
  ] satisfies [
    string,
    number,
  ][])('counts slash separators in %j', (path: string, expected: number) => {
    expect(getPathDepth(path)).toBe(expected);
  });

  it('matches split separator-count semantics for representative paths', () => {
    const paths: string[] = [
      '',
      '/',
      'foo',
      'foo/bar',
      '/foo/bar/',
      'foo//bar',
      '//foo//bar//baz//',
    ];

    for (const path of paths) {
      expect(getPathDepth(path)).toBe(path.split('/').length - 1);
    }
  });
});
