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
  private storePath = '';
  private cache: Record<string, string> = {};
  private readonly ready: Promise<void>;

  constructor(storeFile = 'electron-storage.json') {
    this.ready = import('electron')
      .then(async ({ app }) => {
        await app.whenReady();
        const fullPath = path.resolve(app.getPath('userData'), storeFile);
        await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
        this.storePath = fullPath;
        if (fs.existsSync(this.storePath)) {
          try {
            const data = await fsPromises.readFile(this.storePath, 'utf8');
            this.cache = JSON.parse(data) as Record<string, string>;
          } catch {
            this.cache = {};
          }
        }
      })
      .catch(() => {
        this.cache = {};
      });
  }

  private async persist() {
    await this.ready;
    // Skip persistence if storePath wasn't initialized (e.g., electron not available)
    if (!this.storePath) {
      return;
    }
    await fsPromises.writeFile(this.storePath, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  async getItem(key: string): Promise<string | null> {
    await this.ready;
    return this.cache[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.ready;
    this.cache[key] = value;
    await this.persist();
  }

  async removeItem(key: string): Promise<void> {
    await this.ready;
    delete this.cache[key];
    await this.persist();
  }

  async clear(): Promise<void> {
    await this.ready;
    this.cache = {};
    await this.persist();
  }

  async getAllKeys(): Promise<string[]> {
    await this.ready;
    return Object.keys(this.cache);
  }
}
