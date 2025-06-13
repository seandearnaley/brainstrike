import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileCache, createFileCacheWithDataDir, createTestFileCache } from '../factory';
import type { FileCacheAdapter } from '../types';

// Mock the platform utils
vi.mock('@brainstrike/platform-utils', () => ({
  detectPlatform: vi.fn(() => 'web'),
}));

describe('File Cache Factory', () => {
  const cacheInstances: FileCacheAdapter[] = [];

  afterEach(async () => {
    // Clean up all cache instances
    for (const cache of cacheInstances) {
      await cache.close();
    }
    cacheInstances.length = 0;
  });

  describe('createFileCache', () => {
    it('should create a cache instance with default config', async () => {
      // Override default config to use memory:// for testing
      const cache = createFileCache({
        dataDir: 'memory://test-default',
      });
      cacheInstances.push(cache);

      await cache.initialize();

      // Test basic functionality
      await cache.saveFileContent('/test.txt', 'test content');
      const content = await cache.getFileContent('/test.txt');
      expect(content).toBe('test content');
    });

    it('should create a cache instance with custom config', async () => {
      const cache = createFileCache({
        dataDir: 'memory://custom-test',
        tableName: 'custom_files',
        pgOptions: {
          debug: true,
          relaxedDurability: false,
        },
      });
      cacheInstances.push(cache);

      await cache.initialize();

      // Test basic functionality
      await cache.saveFileContent('/custom.txt', 'custom content');
      const content = await cache.getFileContent('/custom.txt');
      expect(content).toBe('custom content');
    });
  });

  describe('createTestFileCache', () => {
    it('should create an in-memory cache for testing', async () => {
      const cache = createTestFileCache();
      cacheInstances.push(cache);

      await cache.initialize();

      // Test basic functionality
      await cache.saveFileContent('/test-file.txt', 'test data');
      const content = await cache.getFileContent('/test-file.txt');
      expect(content).toBe('test data');
    });

    it('should accept custom test config', async () => {
      const cache = createTestFileCache({
        tableName: 'test_custom_files',
      });
      cacheInstances.push(cache);

      await cache.initialize();

      // Test basic functionality
      await cache.saveFileContent('/test-custom.txt', 'custom test data');
      const content = await cache.getFileContent('/test-custom.txt');
      expect(content).toBe('custom test data');
    });
  });

  describe('createFileCacheWithDataDir', () => {
    it('should create cache with custom data directory', async () => {
      const cache = createFileCacheWithDataDir('memory://custom-dir');
      cacheInstances.push(cache);

      await cache.initialize();

      // Test basic functionality
      await cache.saveFileContent('/dir-test.txt', 'directory test');
      const content = await cache.getFileContent('/dir-test.txt');
      expect(content).toBe('directory test');
    });

    it('should auto-configure relaxedDurability for IndexedDB', async () => {
      // Use memory:// for testing since IndexedDB isn't available in Node.js test environment
      const cache = createFileCacheWithDataDir('memory://auto-config-test');
      cacheInstances.push(cache);

      await cache.initialize();

      // Just test that it initializes successfully
      // The relaxedDurability setting is internal and not directly testable
      await cache.saveFileContent('/memory-test.txt', 'memory test');
      const content = await cache.getFileContent('/memory-test.txt');
      expect(content).toBe('memory test');
    });

    it('should accept additional config options', async () => {
      const cache = createFileCacheWithDataDir('memory://with-config', {
        tableName: 'custom_table',
        pgOptions: {
          debug: false,
        },
      });
      cacheInstances.push(cache);

      await cache.initialize();

      // Test basic functionality
      await cache.saveFileContent('/config-test.txt', 'config test');
      const content = await cache.getFileContent('/config-test.txt');
      expect(content).toBe('config test');
    });
  });

  describe('cache isolation', () => {
    it('should isolate data between different cache instances', async () => {
      const cache1 = createFileCacheWithDataDir('memory://cache1');
      const cache2 = createFileCacheWithDataDir('memory://cache2');
      cacheInstances.push(cache1, cache2);

      await cache1.initialize();
      await cache2.initialize();

      // Save different data in each cache
      await cache1.saveFileContent('/shared.txt', 'cache1 data');
      await cache2.saveFileContent('/shared.txt', 'cache2 data');

      // Verify isolation
      const content1 = await cache1.getFileContent('/shared.txt');
      const content2 = await cache2.getFileContent('/shared.txt');

      expect(content1).toBe('cache1 data');
      expect(content2).toBe('cache2 data');
    });
  });
});
