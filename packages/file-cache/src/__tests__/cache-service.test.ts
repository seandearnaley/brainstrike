import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCacheService } from '../cache-service';
import type { FileCacheConfig } from '../types';

describe('FileCacheService', () => {
  let cacheService: FileCacheService;

  const testConfig: FileCacheConfig = {
    dataDir: 'memory://', // Use in-memory storage for tests
    pgOptions: {
      relaxedDurability: false,
      debug: false,
    },
    tableName: 'test_cached_files',
  };

  beforeEach(async () => {
    cacheService = new FileCacheService(testConfig);
    await cacheService.initialize();
  });

  afterEach(async () => {
    await cacheService.close();
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      const newCacheService = new FileCacheService(testConfig);
      await expect(newCacheService.initialize()).resolves.not.toThrow();
      await newCacheService.close();
    });

    it('should be safe to call initialize multiple times', async () => {
      await expect(cacheService.initialize()).resolves.not.toThrow();
      await expect(cacheService.initialize()).resolves.not.toThrow();
    });
  });

  describe('file caching operations', () => {
    it('should return null for non-existent file', async () => {
      const content = await cacheService.getFileContent('/path/to/nonexistent.txt');
      expect(content).toBeNull();
    });

    it('should save and retrieve file content', async () => {
      const filePath = '/path/to/test.txt';
      const content = 'Hello, world!';

      await cacheService.saveFileContent(filePath, content);
      const retrievedContent = await cacheService.getFileContent(filePath);

      expect(retrievedContent).toBe(content);
    });

    it('should update existing file content', async () => {
      const filePath = '/path/to/test.txt';
      const originalContent = 'Original content';
      const updatedContent = 'Updated content';

      // Save original content
      await cacheService.saveFileContent(filePath, originalContent);
      let retrievedContent = await cacheService.getFileContent(filePath);
      expect(retrievedContent).toBe(originalContent);

      // Update with new content
      await cacheService.saveFileContent(filePath, updatedContent);
      retrievedContent = await cacheService.getFileContent(filePath);
      expect(retrievedContent).toBe(updatedContent);
    });

    it('should handle empty string content', async () => {
      const filePath = '/path/to/empty.txt';
      const content = '';

      await cacheService.saveFileContent(filePath, content);
      const retrievedContent = await cacheService.getFileContent(filePath);

      expect(retrievedContent).toBe(content);
    });

    it('should handle large file content', async () => {
      const filePath = '/path/to/large.txt';
      const content = 'x'.repeat(1000000); // 1MB of 'x' characters

      await cacheService.saveFileContent(filePath, content);
      const retrievedContent = await cacheService.getFileContent(filePath);

      expect(retrievedContent).toBe(content);
    });

    it('should handle unicode content', async () => {
      const filePath = '/path/to/unicode.txt';
      const content = '🚀 Unicode test: αβγ 中文 🎉';

      await cacheService.saveFileContent(filePath, content);
      const retrievedContent = await cacheService.getFileContent(filePath);

      expect(retrievedContent).toBe(content);
    });
  });

  describe('cache management', () => {
    it('should remove file from cache', async () => {
      const filePath = '/path/to/test.txt';
      const content = 'Test content';

      // Save and verify file exists
      await cacheService.saveFileContent(filePath, content);
      expect(await cacheService.getFileContent(filePath)).toBe(content);

      // Remove and verify file is gone
      await cacheService.removeFileContent(filePath);
      expect(await cacheService.getFileContent(filePath)).toBeNull();
    });

    it('should list cached file paths', async () => {
      const files = [
        { path: '/path/to/file1.txt', content: 'Content 1' },
        { path: '/path/to/file2.txt', content: 'Content 2' },
        { path: '/path/to/file3.txt', content: 'Content 3' },
      ];

      // Save multiple files
      for (const file of files) {
        await cacheService.saveFileContent(file.path, file.content);
      }

      // Get cached paths
      const cachedPaths = await cacheService.getCachedFilePaths();

      expect(cachedPaths).toHaveLength(3);
      expect(cachedPaths).toContain('/path/to/file1.txt');
      expect(cachedPaths).toContain('/path/to/file2.txt');
      expect(cachedPaths).toContain('/path/to/file3.txt');
    });

    it('should clear all cached files', async () => {
      // Save multiple files
      await cacheService.saveFileContent('/path/to/file1.txt', 'Content 1');
      await cacheService.saveFileContent('/path/to/file2.txt', 'Content 2');

      // Verify files are cached
      expect(await cacheService.getCachedFilePaths()).toHaveLength(2);

      // Clear cache
      await cacheService.clearCache();

      // Verify cache is empty
      expect(await cacheService.getCachedFilePaths()).toHaveLength(0);
      expect(await cacheService.getFileContent('/path/to/file1.txt')).toBeNull();
      expect(await cacheService.getFileContent('/path/to/file2.txt')).toBeNull();
    });
  });

  describe('cache statistics', () => {
    it('should return correct stats for empty cache', async () => {
      const stats = await cacheService.getStats();

      expect(stats.totalFiles).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });

    it('should return correct stats for cache with files', async () => {
      const files = [
        { path: '/path/to/file1.txt', content: 'Short' },
        { path: '/path/to/file2.txt', content: 'Longer content here' },
      ];

      // Save files
      for (const file of files) {
        await cacheService.saveFileContent(file.path, file.content);
      }

      const stats = await cacheService.getStats();

      expect(stats.totalFiles).toBe(2);
      expect(stats.totalSize).toBe('Short'.length + 'Longer content here'.length);
      expect(stats.oldestEntry).toBeInstanceOf(Date);
      expect(stats.newestEntry).toBeInstanceOf(Date);
    });
  });

  describe('error handling', () => {
    it('should handle get operations gracefully on errors', async () => {
      // Close the service to simulate error condition
      await cacheService.close();

      // Should return null instead of throwing
      const content = await cacheService.getFileContent('/path/to/test.txt');
      expect(content).toBeNull();
    });
  });
});
