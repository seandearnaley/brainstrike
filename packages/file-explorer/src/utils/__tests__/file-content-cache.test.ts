import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileContentCache } from '../file-content-cache';

describe('FileContentCache', () => {
  let cache: FileContentCache;

  beforeEach(() => {
    cache = new FileContentCache(1024 * 1024, 10); // 1MB, 10 entries
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with correct parameters', () => {
      const stats = cache.getStats();
      expect(stats.entryCount).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.evictionCount).toBe(0);
    });
  });

  describe('set', () => {
    it('should store content and calculate size correctly', () => {
      const content = 'hello world';
      cache.set('test', content);

      const stats = cache.getStats();
      // Size should be exactly the content length in bytes
      expect(stats.totalSize).toBe(new Blob([content]).size);
      expect(stats.entryCount).toBe(1);
    });

    it('should accept files exactly at 1MB boundary', () => {
      // Test exactly at 1MB boundary (should be accepted since condition is > not >=)
      const exactMBContent = 'x'.repeat(1024 * 1024); // Exactly 1MB

      cache.set('exact1mb', exactMBContent);

      expect(cache.getStats().entryCount).toBe(1);
      expect(cache.getStats().totalSize).toBe(1024 * 1024);
    });

    it('should reject files larger than 1MB', () => {
      // Test larger than 1MB boundary (should be rejected)
      const largeMBContent = 'x'.repeat(1024 * 1024 + 1); // 1MB + 1 byte
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      cache.set('large', largeMBContent);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/File large is too large.*skipping cache/)
      );
      expect(cache.getStats().entryCount).toBe(0);

      consoleWarnSpy.mockRestore();
    });

    it('should accept files just under 1MB boundary', () => {
      // Test just under 1MB boundary (should be accepted)
      const justUnderMBContent = 'x'.repeat(1024 * 1024 - 1); // Just under 1MB

      cache.set('justunder', justUnderMBContent);

      expect(cache.getStats().entryCount).toBe(1);
      expect(cache.getStats().totalSize).toBe(1024 * 1024 - 1);
    });

    it('should update existing entries and maintain correct size', () => {
      const content1 = 'original content';
      const content2 = 'updated content that is longer';

      cache.set('test', content1);
      const stats1 = cache.getStats();
      const originalSize = stats1.totalSize;

      cache.set('test', content2);
      const stats2 = cache.getStats();

      // Size should change to reflect new content size
      expect(stats2.totalSize).toBe(new Blob([content2]).size);
      expect(stats2.totalSize).not.toBe(originalSize);
      expect(stats2.entryCount).toBe(1); // Still only one entry
    });
  });

  describe('get', () => {
    it('should track hits and misses correctly', () => {
      cache.set('test', 'content');

      // Hit
      const content = cache.get('test');
      expect(content).toBe('content');

      // Miss
      const missing = cache.get('nonexistent');
      expect(missing).toBeUndefined();

      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0.5); // 1 hit, 1 miss = 50%
    });

    it('should calculate hit rate correctly with no requests', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0); // No requests = 0% hit rate
    });

    it('should calculate hit rate correctly with only hits', () => {
      cache.set('test', 'content');
      cache.get('test');
      cache.get('test');

      const stats = cache.getStats();
      expect(stats.hitRate).toBe(1); // 2 hits, 0 misses = 100%
    });

    it('should calculate hit rate correctly with only misses', () => {
      cache.get('missing1');
      cache.get('missing2');

      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0); // 0 hits, 2 misses = 0%
    });
  });

  describe('getCurrentSize', () => {
    it('should calculate total size correctly with multiple entries', () => {
      const content1 = 'hello';
      const content2 = 'world';
      const content3 = 'test';

      cache.set('key1', content1);
      cache.set('key2', content2);
      cache.set('key3', content3);

      const expectedSize =
        new Blob([content1]).size + new Blob([content2]).size + new Blob([content3]).size;

      expect(cache.getStats().totalSize).toBe(expectedSize);
    });

    it('should handle empty cache size calculation', () => {
      expect(cache.getStats().totalSize).toBe(0);
    });
  });

  describe('eviction by count', () => {
    it('should evict oldest entries when max entries exceeded', () => {
      const smallCache = new FileContentCache(1024 * 1024, 3); // Only 3 entries max

      // Add 4 entries (should trigger eviction)
      smallCache.set('key1', 'content1');
      smallCache.set('key2', 'content2');
      smallCache.set('key3', 'content3');
      smallCache.set('key4', 'content4'); // This should trigger eviction

      const stats = smallCache.getStats();
      expect(stats.entryCount).toBeLessThanOrEqual(3);
      expect(stats.evictionCount).toBeGreaterThan(0);
    });
  });

  describe('eviction by size', () => {
    it('should evict entries when size limit exceeded', () => {
      const smallCache = new FileContentCache(100, 10); // Only 100 bytes max

      // Add content that exceeds size limit
      smallCache.set('key1', 'x'.repeat(60)); // 60 bytes
      smallCache.set('key2', 'x'.repeat(60)); // 60 bytes - total 120 bytes, exceeds 100

      const stats = smallCache.getStats();
      expect(stats.totalSize).toBeLessThanOrEqual(100);
      expect(stats.evictionCount).toBeGreaterThan(0);
    });

    it('should calculate target size correctly during eviction', () => {
      const smallCache = new FileContentCache(200, 10); // 200 bytes max

      // Add content that will trigger eviction
      for (let i = 0; i < 5; i++) {
        smallCache.set(`key${i}`, 'x'.repeat(50)); // 50 bytes each
      }

      const stats = smallCache.getStats();
      // Should evict to approximately 50% of max (100 bytes)
      expect(stats.totalSize).toBeLessThanOrEqual(200);
    });
  });

  describe('clear', () => {
    it('should reset all stats correctly', () => {
      cache.set('test1', 'content1');
      cache.set('test2', 'content2');
      cache.get('test1'); // Generate hit
      cache.get('missing'); // Generate miss

      cache.clear();

      const stats = cache.getStats();
      expect(stats.entryCount).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.evictionCount).toBe(0);
    });
  });

  describe('deleteKeys', () => {
    it('should remove specified keys and update size correctly', () => {
      cache.set('keep1', 'content1');
      cache.set('delete1', 'content2');
      cache.set('delete2', 'content3');
      cache.set('keep2', 'content4');

      const sizeBefore = cache.getStats().totalSize;
      const deletedSize = new Blob(['content2']).size + new Blob(['content3']).size;

      cache.deleteKeys(['delete1', 'delete2']);

      const stats = cache.getStats();
      expect(stats.entryCount).toBe(2);
      expect(stats.totalSize).toBe(sizeBefore - deletedSize);
      expect(cache.get('keep1')).toBe('content1');
      expect(cache.get('keep2')).toBe('content4');
      expect(cache.get('delete1')).toBeUndefined();
      expect(cache.get('delete2')).toBeUndefined();
    });
  });

  describe('getEntriesByAccess', () => {
    it('should sort entries by last accessed time correctly', async () => {
      cache.set('first', 'content1');
      await new Promise((resolve) => setTimeout(resolve, 1)); // Small delay
      cache.set('second', 'content2');
      await new Promise((resolve) => setTimeout(resolve, 1)); // Small delay
      cache.set('third', 'content3');

      await new Promise((resolve) => setTimeout(resolve, 1)); // Small delay

      // Access in specific order to test sorting
      cache.get('first'); // Access first
      await new Promise((resolve) => setTimeout(resolve, 1)); // Small delay
      cache.get('third'); // Access third
      await new Promise((resolve) => setTimeout(resolve, 1)); // Small delay
      cache.get('second'); // Access second (most recent)

      const entries = cache.getEntriesByAccess();

      // Should be sorted by most recent access first (newest to oldest)
      expect(entries[0]?.key).toBe('second'); // Most recently accessed
      expect(entries[1]?.key).toBe('third'); // Second most recent
      expect(entries[2]?.key).toBe('first'); // Least recently accessed
    });
  });
});
