import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { StorageAdapter } from '../types';

/**
 * Electron Storage Adapter
 *
 * Simple file based implementation used for testing in lieu of `electron-store`.
 */
export class ElectronStorageAdapter implements StorageAdapter {
  private storePath: string;
  private cache: Record<string, string> = {};

  constructor(storeFile = 'electron-storage.json') {
    this.storePath = path.resolve(storeFile);
    if (fs.existsSync(this.storePath)) {
      try {
        const data = fs.readFileSync(this.storePath, 'utf8');
        this.cache = JSON.parse(data) as Record<string, string>;
      } catch {
        this.cache = {};
      }
    }
  }

  private async persist() {
    await fsPromises.writeFile(this.storePath, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  async getItem(key: string): Promise<string | null> {
    return this.cache[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.cache[key] = value;
    await this.persist();
  }

  async removeItem(key: string): Promise<void> {
    delete this.cache[key];
    await this.persist();
  }

  async clear(): Promise<void> {
    this.cache = {};
    await this.persist();
  }

  async getAllKeys(): Promise<string[]> {
    return Object.keys(this.cache);
  }
}
