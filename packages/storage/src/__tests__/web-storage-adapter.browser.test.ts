/**
 * Browser-based tests for WebStorageAdapter using Vitest 4 Browser Mode
 *
 * These tests run in a real Chromium browser to validate:
 * - Real localStorage API behavior
 * - Proper persistence across operations
 * - Storage quota handling
 * - Browser-specific edge cases
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebStorageAdapter } from '../adapters/web-storage-adapter.js';

describe('WebStorageAdapter (Browser Mode)', () => {
  let adapter: WebStorageAdapter;
  const TEST_PREFIX = 'vitest-browser-test-';

  beforeEach(() => {
    adapter = new WebStorageAdapter();
    // Clear any test data from previous runs
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(TEST_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  });

  afterEach(() => {
    // Cleanup test data
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(TEST_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  });

  describe('Real localStorage API', () => {
    it('should use real browser localStorage', () => {
      expect(typeof window).toBe('object');
      expect(typeof window.localStorage).toBe('object');
      expect(window.localStorage).toBe(localStorage);
    });

    it('should set and get string values', async () => {
      const key = `${TEST_PREFIX}string-test`;
      const value = 'hello world';

      await adapter.setItem(key, value);
      const result = await adapter.getItem(key);

      expect(result).toBe(value);
      // Verify it's actually in localStorage
      expect(localStorage.getItem(key)).toBe(value);
    });

    it('should set and get JSON values', async () => {
      const key = `${TEST_PREFIX}object-test`;
      const value = { count: 42, name: 'test', nested: { a: 1 } };

      await adapter.setItem(key, JSON.stringify(value));
      const result = await adapter.getItem(key);

      expect(JSON.parse(result!)).toEqual(value);
    });

    it('should set and get array values as JSON', async () => {
      const key = `${TEST_PREFIX}array-test`;
      const value = [1, 'two', { three: 3 }, [4, 5]];

      await adapter.setItem(key, JSON.stringify(value));
      const result = await adapter.getItem(key);

      expect(JSON.parse(result!)).toEqual(value);
    });

    it('should return null for missing keys', async () => {
      const key = `${TEST_PREFIX}missing-key`;
      const result = await adapter.getItem(key);
      expect(result).toBeNull();
    });

    it('should remove values', async () => {
      const key = `${TEST_PREFIX}delete-test`;
      await adapter.setItem(key, 'to be deleted');

      expect(await adapter.getItem(key)).toBe('to be deleted');

      await adapter.removeItem(key);

      expect(await adapter.getItem(key)).toBeNull();
      expect(localStorage.getItem(key)).toBeNull();
    });

    it('should persist data across adapter instances', async () => {
      const key = `${TEST_PREFIX}persist-test`;
      const value = JSON.stringify({ persisted: true });

      await adapter.setItem(key, value);

      // Create new adapter instance
      const newAdapter = new WebStorageAdapter();
      const result = await newAdapter.getItem(key);

      expect(result).toEqual(value);
    });

    it('should get all keys', async () => {
      const key1 = `${TEST_PREFIX}keys-1`;
      const key2 = `${TEST_PREFIX}keys-2`;

      await adapter.setItem(key1, 'value1');
      await adapter.setItem(key2, 'value2');

      const allKeys = await adapter.getAllKeys();

      expect(allKeys).toContain(key1);
      expect(allKeys).toContain(key2);
    });
  });

  describe('Edge cases', () => {
    it('should handle special characters in keys', async () => {
      const key = `${TEST_PREFIX}special:key/with.dots~and-dashes`;
      const value = 'special key value';

      await adapter.setItem(key, value);
      const result = await adapter.getItem(key);

      expect(result).toBe(value);
    });

    it('should handle unicode in values', async () => {
      const key = `${TEST_PREFIX}unicode-test`;
      const value = '你好世界 🌍 مرحبا';

      await adapter.setItem(key, value);
      const result = await adapter.getItem(key);

      expect(result).toBe(value);
    });

    it('should handle empty string values', async () => {
      const key = `${TEST_PREFIX}empty-test`;

      await adapter.setItem(key, '');
      const result = await adapter.getItem(key);

      expect(result).toBe('');
    });

    it('should handle large values', async () => {
      const key = `${TEST_PREFIX}large-value-test`;
      // Create a ~100KB string
      const largeValue = 'x'.repeat(100_000);

      await adapter.setItem(key, largeValue);
      const result = await adapter.getItem(key);

      expect(result).toBe(largeValue);
      expect(result?.length).toBe(100_000);
    });
  });

  describe('Performance baseline', () => {
    it('should handle many rapid operations', async () => {
      const count = 100;
      const keys: string[] = [];

      const startWrite = performance.now();
      for (let i = 0; i < count; i++) {
        const key = `${TEST_PREFIX}perf-${i}`;
        keys.push(key);
        await adapter.setItem(key, JSON.stringify({ data: `value-${i}`, index: i }));
      }
      const writeTime = performance.now() - startWrite;

      const startRead = performance.now();
      for (const key of keys) {
        await adapter.getItem(key);
      }
      const readTime = performance.now() - startRead;

      // Log performance metrics
      console.log(`Write ${count} items: ${writeTime.toFixed(2)}ms`);
      console.log(`Read ${count} items: ${readTime.toFixed(2)}ms`);

      // Sanity check - should complete in reasonable time
      expect(writeTime).toBeLessThan(5000);
      expect(readTime).toBeLessThan(5000);
    });
  });
});
