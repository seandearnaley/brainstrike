import { describe, expect, it } from 'vitest';

import { extractPathSegments } from '../path-utils';

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
