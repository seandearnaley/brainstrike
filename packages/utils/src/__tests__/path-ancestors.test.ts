import { describe, expect, it } from 'vitest';

import { getAncestorDirectoryPaths } from '../path-ancestors';

describe('getAncestorDirectoryPaths', () => {
  it('returns ancestor directories for nested absolute file paths', () => {
    expect(getAncestorDirectoryPaths('/src/nested/deeper/file.ts')).toEqual([
      '/src',
      '/src/nested',
      '/src/nested/deeper',
    ]);
  });

  it('includes the root directory when requested', () => {
    expect(getAncestorDirectoryPaths('/src/file.ts', { includeRoot: true })).toEqual(['/', '/src']);
  });

  it('reuses cached directory chains across sibling files', () => {
    const cache = new Map<string, readonly string[]>();

    expect(getAncestorDirectoryPaths('/src/a.ts', { cache, includeRoot: true })).toEqual([
      '/',
      '/src',
    ]);
    expect(getAncestorDirectoryPaths('/src/nested/b.ts', { cache, includeRoot: true })).toEqual([
      '/',
      '/src',
      '/src/nested',
    ]);
    expect(cache.get('/src')).toEqual(['/', '/src']);
  });

  it('returns an empty array for top-level relative paths', () => {
    expect(getAncestorDirectoryPaths('index.ts')).toEqual([]);
  });
});
