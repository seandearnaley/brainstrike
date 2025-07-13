import type { StorageAdapter } from '../types';

/**
 * Memory Storage Adapter
 *
 * In-memory implementation of StorageAdapter for testing purposes.
 * Data is not persisted between sessions.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private storage = new Map<string, string>();
  private readonly debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  async getItem(key: string): Promise<string | null> {
    if (this.storage.has(key)) {
      const value = this.storage.get(key) as string;
      if (this.debug) {
        console.debug(`MemoryStorageAdapter: getItem(${key}) -> ${value}`);
      }
      return value;
    }
    if (this.debug) {
      console.debug(`MemoryStorageAdapter: getItem(${key}) -> null`);
    }
    return null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.debug) {
      console.debug(`MemoryStorageAdapter: setItem(${key}, ${value})`);
    }
    this.storage.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.storage.delete(key);
  }

  async clear(): Promise<void> {
    this.storage.clear();
  }

  async getAllKeys(): Promise<string[]> {
    return Array.from(this.storage.keys());
  }

  /**
   * Get the current storage size (for testing purposes)
   */
  getSize(): number {
    return this.storage.size;
  }

  /**
   * Check if a key exists (for testing purposes)
   */
  has(key: string): boolean {
    return this.storage.has(key);
  }
}
