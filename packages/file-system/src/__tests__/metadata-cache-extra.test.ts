import { describe, expect, it, vi } from 'vitest';
import { MetadataCache } from '../metadata-cache';

describe('MetadataCache extra coverage', () => {
  it('preserves replacement order during batched updates at capacity', () => {
    vi.useFakeTimers();
    try {
      const cache = new MetadataCache({ maxEntries: 2 });

      cache.set('/file-1', { isDirectory: false, mtimeMs: 1, size: 1 });
      cache.set('/file-2', { isDirectory: false, mtimeMs: 2, size: 2 });

      cache.setBatch([
        { metadata: { isDirectory: false, mtimeMs: 20, size: 20 }, path: '/file-2' },
        { metadata: { isDirectory: false, mtimeMs: 3, size: 3 }, path: '/file-3' },
      ]);

      expect(cache.get('/file-1')).toBeUndefined();
      expect(cache.get('/file-2')?.size).toBe(20);
      expect(cache.get('/file-3')?.size).toBe(3);
      expect(cache.getStats().evictions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns zero when invalidating a directory or predicate with no matches', () => {
    const cache = new MetadataCache();

    cache.set('/project/file.ts', { isDirectory: false, mtimeMs: 1, size: 10 });

    expect(cache.invalidateDirectory('/missing')).toBe(0);
    expect(cache.invalidateWhere(() => false)).toBe(0);
    expect(cache.get('/project/file.ts')).toBeDefined();
  });
});
