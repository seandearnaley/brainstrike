import { describe, expect, it } from 'vitest';

import { accumulateAncestorDirectoryCounts, getAncestorDirectoryPaths } from '../path-ancestors';

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

  it('normalizes walked parent paths before caching repeated separators', () => {
    const cache = new Map<string, readonly string[]>();

    expect(getAncestorDirectoryPaths('/src//nested/file.ts', { cache, includeRoot: true })).toEqual(
      ['/', '/src', '/src//nested']
    );
    expect(cache.has('/src/')).toBe(false);
    expect(cache.get('/src')).toEqual(['/', '/src']);
  });

  it('returns an empty array for top-level relative paths', () => {
    expect(getAncestorDirectoryPaths('index.ts')).toEqual([]);
  });

  it('builds deep ancestor chains without recursive stack growth', () => {
    const directorySegments = Array.from({ length: 12_000 }, (_, index) => `dir-${index}`);
    const filePath = `/${directorySegments.join('/')}/file.ts`;

    const ancestors = getAncestorDirectoryPaths(filePath, {
      cache: new Map<string, readonly string[]>(),
      includeRoot: true,
    });

    expect(ancestors).toHaveLength(directorySegments.length + 1);
    expect(ancestors.at(0)).toBe('/');
    expect(ancestors.at(-1)).toBe(`/${directorySegments.join('/')}`);
  });

  it('accumulates ancestor directory counts for multiple files', () => {
    const counts = accumulateAncestorDirectoryCounts(
      ['/src/a.ts', '/src/nested/b.ts', '/README.md'],
      {
        cache: new Map<string, readonly string[]>(),
        includeRoot: true,
      }
    );

    expect(counts).toEqual(
      new Map([
        ['/', 3],
        ['/src', 2],
        ['/src/nested', 1],
      ])
    );
  });

  it('supports decrementing ancestor directory counts into an existing map', () => {
    const counts = new Map<string, number>([
      ['/', 3],
      ['/src', 2],
      ['/src/nested', 1],
    ]);

    accumulateAncestorDirectoryCounts(['/src/nested/b.ts'], {
      counts,
      cache: new Map<string, readonly string[]>(),
      delta: -1,
      includeRoot: true,
    });

    expect(counts).toEqual(
      new Map([
        ['/', 2],
        ['/src', 1],
      ])
    );
  });
});
