import { beforeEach, describe, expect, it } from 'vitest';
import { WebStorageAdapter } from '../adapters/web-storage-adapter.js';

class MockStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    const value = this.store.get(key);
    return value === undefined ? null : value;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('WebStorageAdapter', () => {
  let adapter: WebStorageAdapter;
  let storage: MockStorage;

  beforeEach(() => {
    storage = new MockStorage();
    adapter = new WebStorageAdapter(storage);
  });

  describe('getItem and setItem', () => {
    it('should return null for missing keys', async () => {
      const result = await adapter.getItem('missing');
      expect(result).toBeNull();
    });

    it('should store and retrieve a value', async () => {
      await adapter.setItem('key', 'value');
      const result = await adapter.getItem('key');
      expect(result).toBe('value');
    });
  });

  describe('removeItem', () => {
    it('should remove an existing key', async () => {
      await adapter.setItem('key', 'value');
      await adapter.removeItem('key');
      const result = await adapter.getItem('key');
      expect(result).toBeNull();
    });
  });

  describe('clear', () => {
    it('should clear all keys', async () => {
      await adapter.setItem('key1', 'value1');
      await adapter.setItem('key2', 'value2');
      await adapter.clear();
      expect(await adapter.getAllKeys()).toEqual([]);
    });
  });

  describe('getAllKeys', () => {
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
});
