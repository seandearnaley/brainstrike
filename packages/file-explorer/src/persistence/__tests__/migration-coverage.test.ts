import type { StorageAdapter } from '@brainstrike/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistOptions } from '../file-explorer-persistence';

// Minimal in-memory localStorage mock
class LocalStorageMock {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

const memoryAdapter: StorageAdapter = {
  async getItem() {
    return null;
  },
  async setItem() {
    return;
  },
  async removeItem() {
    return;
  },
  async clear() {
    return;
  },
  async getAllKeys() {
    return [];
  },
};

describe('createPersistOptions migration (coverage)', () => {
  const originalLS = (globalThis as unknown as { localStorage?: unknown }).localStorage;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as unknown as { localStorage: LocalStorageMock }).localStorage =
      new LocalStorageMock();
  });

  afterEach(() => {
    if (originalLS === undefined) {
      // @ts-expect-error cleanup
      (globalThis as unknown as { localStorage?: unknown }).localStorage = undefined;
    } else {
      (globalThis as unknown as { localStorage: unknown }).localStorage = originalLS as unknown;
    }
  });

  it('migrates legacy settings key to new key when present', async () => {
    const ls = (globalThis as unknown as { localStorage: LocalStorageMock }).localStorage;
    // Seed legacy only
    ls.setItem('fileExplorerSettings', JSON.stringify({ currentFolderId: 'legacy' }));

    // Invoke to trigger migration branch
    const opts = createPersistOptions(memoryAdapter);
    expect(typeof opts).toBe('object');

    const newVal = ls.getItem('file-explorer-storage-v4');
    const oldVal = ls.getItem('fileExplorerSettings');
    expect(newVal).toBeTruthy();
    expect(oldVal).toBeNull();
  });
});
