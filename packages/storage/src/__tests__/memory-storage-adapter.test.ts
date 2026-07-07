import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageAdapter } from '../adapters/memory-storage-adapter';

describe('MemoryStorageAdapter', () => {
  let adapter: MemoryStorageAdapter;

  beforeEach(() => {
    adapter = new MemoryStorageAdapter();
  });

  describe('getItem', () => {
    it('should return null for non-existent keys', async () => {
      const result = await adapter.getItem('non-existent');
      expect(result).toBeNull();
    });

    it('should return stored value for existing keys', async () => {
      await adapter.setItem('test-key', 'test-value');
      const result = await adapter.getItem('test-key');
      expect(result).toBe('test-value');
    });
  });

  describe('setItem', () => {
    it('should store a value', async () => {
      await adapter.setItem('key1', 'value1');
      const result = await adapter.getItem('key1');
      expect(result).toBe('value1');
    });

    it('should overwrite existing values', async () => {
      await adapter.setItem('key1', 'value1');
      await adapter.setItem('key1', 'value2');
      const result = await adapter.getItem('key1');
      expect(result).toBe('value2');
    });

    it('should handle empty strings', async () => {
      await adapter.setItem('empty', '');
      const result = await adapter.getItem('empty');
      expect(result).toBe('');
    });
  });

  describe('removeItem', () => {
    it('should remove an existing item', async () => {
      await adapter.setItem('key1', 'value1');
      await adapter.removeItem('key1');
      const result = await adapter.getItem('key1');
      expect(result).toBeNull();
    });

    it('should not throw when removing non-existent items', async () => {
      await expect(adapter.removeItem('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all items', async () => {
      await adapter.setItem('key1', 'value1');
      await adapter.setItem('key2', 'value2');
      await adapter.clear();

      expect(await adapter.getItem('key1')).toBeNull();
      expect(await adapter.getItem('key2')).toBeNull();
      expect(adapter.getSize()).toBe(0);
    });
  });

  describe('getAllKeys', () => {
    it('should return empty array when no items stored', async () => {
      const keys = await adapter.getAllKeys();
      expect(keys).toEqual([]);
    });

    it('should return all stored keys', async () => {
      await adapter.setItem('key1', 'value1');
      await adapter.setItem('key2', 'value2');
      await adapter.setItem('key3', 'value3');

      const keys = await adapter.getAllKeys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).toContain('key3');
    });
  });

  describe('getSize', () => {
    it('should return 0 for empty storage', () => {
      expect(adapter.getSize()).toBe(0);
    });

    it('should return correct size after adding items', async () => {
      await adapter.setItem('key1', 'value1');
      expect(adapter.getSize()).toBe(1);

      await adapter.setItem('key2', 'value2');
      expect(adapter.getSize()).toBe(2);
    });

    it('should decrease size after removing items', async () => {
      await adapter.setItem('key1', 'value1');
      await adapter.setItem('key2', 'value2');
      expect(adapter.getSize()).toBe(2);

      await adapter.removeItem('key1');
      expect(adapter.getSize()).toBe(1);
    });
  });

  describe('has', () => {
    it('should return false for non-existent keys', () => {
      expect(adapter.has('non-existent')).toBe(false);
    });

    it('should return true for existing keys', async () => {
      await adapter.setItem('key1', 'value1');
      expect(adapter.has('key1')).toBe(true);
    });

    it('should return false after removing a key', async () => {
      await adapter.setItem('key1', 'value1');
      expect(adapter.has('key1')).toBe(true);

      await adapter.removeItem('key1');
      expect(adapter.has('key1')).toBe(false);
    });
  });

  describe('complex scenarios', () => {
    it('should handle JSON data correctly', async () => {
      const testData = { name: 'test', nested: { prop: 'value' }, value: 123 };
      const jsonString = JSON.stringify(testData);

      await adapter.setItem('json-data', jsonString);
      const result = await adapter.getItem('json-data');

      expect(result).toBe(jsonString);
      expect(result).not.toBeNull();
      expect(JSON.parse(result as string)).toEqual(testData);
    });

    it('should maintain data isolation between instances', async () => {
      const adapter1 = new MemoryStorageAdapter();
      const adapter2 = new MemoryStorageAdapter();

      await adapter1.setItem('key1', 'value1');
      await adapter2.setItem('key1', 'value2');

      expect(await adapter1.getItem('key1')).toBe('value1');
      expect(await adapter2.getItem('key1')).toBe('value2');
    });

    it('should handle large amounts of data', async () => {
      const largeData = 'x'.repeat(10_000);
      await adapter.setItem('large-key', largeData);

      const result = await adapter.getItem('large-key');
      expect(result).toBe(largeData);
      expect(result?.length).toBe(10_000);
    });
  });

  describe('debug logging', () => {
    it('should not log by default', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const defaultAdapter = new MemoryStorageAdapter();
      await defaultAdapter.setItem('key', 'value');
      await defaultAdapter.getItem('key');
      expect(debugSpy).not.toHaveBeenCalled();
      debugSpy.mockRestore();
    });

    it('should log when enabled', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const debugAdapter = new MemoryStorageAdapter(true);
      await debugAdapter.setItem('key', 'value');
      await debugAdapter.getItem('key');
      expect(debugSpy).toHaveBeenCalled();
      debugSpy.mockRestore();
    });
  });
});
