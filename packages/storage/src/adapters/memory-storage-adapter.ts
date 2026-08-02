import { createLogger } from '@brainstrike/logging';
import type { StorageAdapter } from '../types.js';

/**
 * Memory Storage Adapter
 *
 * In-memory implementation of StorageAdapter for testing purposes.
 * Data is not persisted between sessions.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly storage = new Map<string, string>();
  private readonly debug: boolean;
  private readonly logger = createLogger('MemoryStorageAdapter');

  constructor(debug = false) {
    this.debug = debug;
  }

  private logDebug(message: string): void {
    this.logger.debug(message);
    // biome-ignore lint/suspicious/noConsole: needed so tests can detect debug logging.
    console.debug(message);
  }

  async getItem(key: string): Promise<string | null> {
    if (this.storage.has(key)) {
      const value = this.storage.get(key) as string;
      if (this.debug) {
        this.logDebug(`MemoryStorageAdapter: getItem(${key}) -> ${value}`);
      }
      return value;
    }
    if (this.debug) {
      this.logDebug(`MemoryStorageAdapter: getItem(${key}) -> null`);
    }
    return null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.debug) {
      this.logDebug(`MemoryStorageAdapter: setItem(${key}, ${value})`);
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
