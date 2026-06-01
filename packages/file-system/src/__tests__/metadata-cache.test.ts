/**
 * Tests for MetadataCache (BST-146)
 *
 * Tests LRU eviction, TTL expiration, and invalidation strategies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetadataCache, MetadataCache } from '../metadata-cache';

const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  Object.defineProperty(process, 'platform', {
    ...processPlatformDescriptor,
    value: platform,
  });

  try {
    return callback();
  } finally {
    if (processPlatformDescriptor) {
      Object.defineProperty(process, 'platform', processPlatformDescriptor);
    }
  }
}

describe('MetadataCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic operations', () => {
    it('should set and get an entry', () => {
      const cache = new MetadataCache();

      cache.set('/path/to/file.ts', { size: 1024, mtimeMs: 1000, isDirectory: false });

      const entry = cache.get('/path/to/file.ts');
      expect(entry).toBeDefined();
      expect(entry?.size).toBe(1024);
      expect(entry?.mtimeMs).toBe(1000);
      expect(entry?.isDirectory).toBe(false);
    });

    it('should return undefined for missing entries', () => {
      const cache = new MetadataCache();

      const entry = cache.get('/nonexistent');
      expect(entry).toBeUndefined();
    });

    it('should overwrite existing entries', () => {
      const cache = new MetadataCache();

      cache.set('/path/to/file.ts', { size: 1024, mtimeMs: 1000, isDirectory: false });
      cache.set('/path/to/file.ts', { size: 2048, mtimeMs: 2000, isDirectory: false });

      const entry = cache.get('/path/to/file.ts');
      expect(entry?.size).toBe(2048);
      expect(entry?.mtimeMs).toBe(2000);
    });

    it('should check existence with has()', () => {
      const cache = new MetadataCache();

      cache.set('/path/to/file.ts', { size: 1024, mtimeMs: 1000, isDirectory: false });

      expect(cache.has('/path/to/file.ts')).toBe(true);
      expect(cache.has('/nonexistent')).toBe(false);
    });

    it('should support batch set operations', () => {
      const cache = new MetadataCache();

      cache.setBatch([
        { path: '/file1.ts', metadata: { size: 100, mtimeMs: 1000, isDirectory: false } },
        { path: '/file2.ts', metadata: { size: 200, mtimeMs: 2000, isDirectory: false } },
        { path: '/dir', metadata: { size: 0, mtimeMs: 3000, isDirectory: true } },
      ]);

      expect(cache.get('/file1.ts')?.size).toBe(100);
      expect(cache.get('/file2.ts')?.size).toBe(200);
      expect(cache.get('/dir')?.isDirectory).toBe(true);
    });

    it('keeps literal POSIX backslash paths distinct from path separators', () => {
      if (process.platform === 'win32') {
        return;
      }

      const cache = new MetadataCache();

      cache.set('/project/a\\b.txt', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/project/a/b.txt', { size: 200, mtimeMs: 2000, isDirectory: false });

      expect(cache.get('/project/a\\b.txt')?.size).toBe(100);
      expect(cache.get('/project/a/b.txt')?.size).toBe(200);
    });

    it('should clear all entries', () => {
      const cache = new MetadataCache();

      cache.set('/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/file2.ts', { size: 200, mtimeMs: 2000, isDirectory: false });

      cache.clear();

      expect(cache.get('/file1.ts')).toBeUndefined();
      expect(cache.get('/file2.ts')).toBeUndefined();
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entries when at capacity', () => {
      const cache = new MetadataCache({ maxEntries: 3 });

      cache.set('/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/file2.ts', { size: 200, mtimeMs: 2000, isDirectory: false });
      cache.set('/file3.ts', { size: 300, mtimeMs: 3000, isDirectory: false });

      // Adding 4th entry should evict the oldest (file1)
      cache.set('/file4.ts', { size: 400, mtimeMs: 4000, isDirectory: false });

      expect(cache.get('/file1.ts')).toBeUndefined();
      expect(cache.get('/file2.ts')).toBeDefined();
      expect(cache.get('/file3.ts')).toBeDefined();
      expect(cache.get('/file4.ts')).toBeDefined();
    });

    it('should update LRU order on get()', () => {
      const cache = new MetadataCache({ maxEntries: 3 });

      cache.set('/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/file2.ts', { size: 200, mtimeMs: 2000, isDirectory: false });
      cache.set('/file3.ts', { size: 300, mtimeMs: 3000, isDirectory: false });

      // Access file1 to move it to the end
      cache.get('/file1.ts');

      // Adding 4th entry should now evict file2 (now the oldest)
      cache.set('/file4.ts', { size: 400, mtimeMs: 4000, isDirectory: false });

      expect(cache.get('/file1.ts')).toBeDefined();
      expect(cache.get('/file2.ts')).toBeUndefined();
      expect(cache.get('/file3.ts')).toBeDefined();
      expect(cache.get('/file4.ts')).toBeDefined();
    });

    it('should track eviction count in stats', () => {
      const cache = new MetadataCache({ maxEntries: 2 });

      cache.set('/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/file2.ts', { size: 200, mtimeMs: 2000, isDirectory: false });
      cache.set('/file3.ts', { size: 300, mtimeMs: 3000, isDirectory: false });
      cache.set('/file4.ts', { size: 400, mtimeMs: 4000, isDirectory: false });

      const stats = cache.getStats();
      expect(stats.evictions).toBe(2);
      expect(stats.size).toBe(2);
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', () => {
      const cache = new MetadataCache({ ttlMs: 1000 });

      cache.set('/file.ts', { size: 100, mtimeMs: 1000, isDirectory: false });

      // Entry should be valid initially
      expect(cache.get('/file.ts')).toBeDefined();

      // Advance time past TTL
      vi.advanceTimersByTime(1001);

      // Entry should now be expired
      expect(cache.get('/file.ts')).toBeUndefined();
    });

    it('should track expiration count in stats', () => {
      const cache = new MetadataCache({ ttlMs: 1000 });

      cache.set('/file.ts', { size: 100, mtimeMs: 1000, isDirectory: false });

      vi.advanceTimersByTime(1001);
      cache.get('/file.ts'); // Trigger expiration check

      const stats = cache.getStats();
      expect(stats.expirations).toBe(1);
    });

    it('should expire entries on has() check', () => {
      const cache = new MetadataCache({ ttlMs: 1000 });

      cache.set('/file.ts', { size: 100, mtimeMs: 1000, isDirectory: false });

      expect(cache.has('/file.ts')).toBe(true);

      vi.advanceTimersByTime(1001);

      expect(cache.has('/file.ts')).toBe(false);
    });

    it('should prune expired entries proactively', () => {
      const cache = new MetadataCache({ ttlMs: 1000 });

      cache.set('/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/file2.ts', { size: 200, mtimeMs: 2000, isDirectory: false });

      vi.advanceTimersByTime(1001);

      const pruned = cache.pruneExpired();
      expect(pruned).toBe(2);
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('invalidation', () => {
    it('should invalidate a specific path', () => {
      const cache = new MetadataCache();

      cache.set('/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/file2.ts', { size: 200, mtimeMs: 2000, isDirectory: false });

      const result = cache.invalidatePath('/file1.ts');

      expect(result).toBe(true);
      expect(cache.get('/file1.ts')).toBeUndefined();
      expect(cache.get('/file2.ts')).toBeDefined();
    });

    it('should return false when invalidating nonexistent path', () => {
      const cache = new MetadataCache();

      const result = cache.invalidatePath('/nonexistent');
      expect(result).toBe(false);
    });

    it('should invalidate all entries under a directory', () => {
      const cache = new MetadataCache();

      cache.set('/project/src/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/project/src/file2.ts', { size: 200, mtimeMs: 2000, isDirectory: false });
      cache.set('/project/src/nested/file3.ts', { size: 300, mtimeMs: 3000, isDirectory: false });
      cache.set('/project/other/file4.ts', { size: 400, mtimeMs: 4000, isDirectory: false });

      const count = cache.invalidateDirectory('/project/src');

      expect(count).toBe(3);
      expect(cache.get('/project/src/file1.ts')).toBeUndefined();
      expect(cache.get('/project/src/file2.ts')).toBeUndefined();
      expect(cache.get('/project/src/nested/file3.ts')).toBeUndefined();
      expect(cache.get('/project/other/file4.ts')).toBeDefined();
    });

    it('should invalidate the directory itself', () => {
      const cache = new MetadataCache();

      cache.set('/project/src', { size: 0, mtimeMs: 1000, isDirectory: true });
      cache.set('/project/src/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });

      const count = cache.invalidateDirectory('/project/src');

      expect(count).toBe(2);
      expect(cache.get('/project/src')).toBeUndefined();
    });

    it('should handle directory paths with trailing slash', () => {
      const cache = new MetadataCache();

      cache.set('/project/src/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });

      const count = cache.invalidateDirectory('/project/src/');

      expect(count).toBe(1);
      expect(cache.get('/project/src/file1.ts')).toBeUndefined();
    });

    it('should invalidate entries matching a predicate', () => {
      const cache = new MetadataCache();

      cache.set('/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/file2.ts', { size: 2000, mtimeMs: 2000, isDirectory: false });
      cache.set('/file3.ts', { size: 300, mtimeMs: 3000, isDirectory: false });

      // Invalidate entries larger than 500 bytes
      const count = cache.invalidateWhere((_, entry) => entry.size > 500);

      expect(count).toBe(1);
      expect(cache.get('/file1.ts')).toBeDefined();
      expect(cache.get('/file2.ts')).toBeUndefined();
      expect(cache.get('/file3.ts')).toBeDefined();
    });

    it('should expose native Windows paths to invalidateWhere predicates', () => {
      withPlatform('win32', () => {
        const cache = new MetadataCache();

        cache.set('C:\\project\\src\\file.ts', {
          size: 100,
          mtimeMs: 1000,
          isDirectory: false,
        });

        const count = cache.invalidateWhere((path) => path === 'C:\\project\\src\\file.ts');

        expect(count).toBe(1);
        expect(cache.get('C:\\project\\src\\file.ts')).toBeUndefined();
      });
    });
  });

  describe('statistics', () => {
    it('should track hits and misses', () => {
      const cache = new MetadataCache();

      cache.set('/file.ts', { size: 100, mtimeMs: 1000, isDirectory: false });

      cache.get('/file.ts'); // hit
      cache.get('/file.ts'); // hit
      cache.get('/nonexistent'); // miss
      cache.get('/another'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBe(50);
    });

    it('should calculate hit rate correctly', () => {
      const cache = new MetadataCache();

      cache.set('/file.ts', { size: 100, mtimeMs: 1000, isDirectory: false });

      // 3 hits, 1 miss = 75% hit rate
      cache.get('/file.ts');
      cache.get('/file.ts');
      cache.get('/file.ts');
      cache.get('/nonexistent');

      const stats = cache.getStats();
      expect(stats.hitRate).toBe(75);
    });

    it('should return 0 hit rate when no operations', () => {
      const cache = new MetadataCache();
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });

    it('should reset statistics', () => {
      const cache = new MetadataCache();

      cache.set('/file.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.get('/file.ts');
      cache.get('/nonexistent');

      cache.resetStats();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
      expect(stats.expirations).toBe(0);
    });
  });

  describe('getPaths', () => {
    it('should return all cached paths', () => {
      const cache = new MetadataCache();

      cache.set('/file1.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      cache.set('/file2.ts', { size: 200, mtimeMs: 2000, isDirectory: false });
      cache.set('/dir', { size: 0, mtimeMs: 3000, isDirectory: true });

      const paths = cache.getPaths();
      expect(paths).toHaveLength(3);
      expect(paths).toContain('/file1.ts');
      expect(paths).toContain('/file2.ts');
      expect(paths).toContain('/dir');
    });

    it('should return native Windows paths after internal normalization', () => {
      withPlatform('win32', () => {
        const cache = new MetadataCache();

        cache.set('C:\\project\\src\\file.ts', {
          size: 100,
          mtimeMs: 1000,
          isDirectory: false,
        });

        expect(cache.getPaths()).toEqual(['C:\\project\\src\\file.ts']);
      });
    });
  });

  describe('createMetadataCache factory', () => {
    it('should create a cache with default config', () => {
      const cache = createMetadataCache();

      cache.set('/file.ts', { size: 100, mtimeMs: 1000, isDirectory: false });
      expect(cache.get('/file.ts')).toBeDefined();
    });

    it('should create a cache with custom config', () => {
      const cache = createMetadataCache({ maxEntries: 5, ttlMs: 5000 });

      const stats = cache.getStats();
      expect(stats.maxEntries).toBe(5);
    });
  });
});
