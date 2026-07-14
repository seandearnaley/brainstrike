import type { StorageAdapter } from '@brainstrike/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistOptions } from '../file-explorer-persistence';

// Minimal in-memory localStorage mock
class LocalStorageMock {
  private readonly store = new Map<string, string>();
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
  async clear() {},
  async getAllKeys() {
    return [];
  },
  async getItem() {
    return null;
  },
  async removeItem() {},
  async setItem() {},
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

    const newVal = ls.getItem('file-explorer-storage-v5');
    const oldVal = ls.getItem('fileExplorerSettings');
    expect(newVal).toBeTruthy();
    expect(oldVal).toBeNull();
  });

  it('stale v4 localStorage data is never read — boot proceeds with empty state, no crash', async () => {
    const ls = (globalThis as unknown as { localStorage: LocalStorageMock }).localStorage;

    // Seed junk under the OLD v4 key (simulates a user upgrading from phase 4 to phase 5)
    const staleV4State = JSON.stringify({
      state: {
        currentFolderId: '/some/stale/path',
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: ['/some/stale/path'],
        folderStates: { '/some/stale/path': { lastAccessed: 1 } },
        folderSummaryThreshold: 5,
        includeFilters: [],
        includeProjectTree: true,
        lastActiveTab: 'files',
        maxSelectionCount: 10,
        selectedFilePaths: ['/some/stale/path|@|file.ts'],
        useRegex: false,
      },
      version: 4,
    });
    ls.setItem('file-explorer-storage-v4', staleV4State);

    // Invoking createPersistOptions must NOT crash when v4 data is present.
    // The new key is 'file-explorer-storage-v5' — the v4 entry is simply invisible.
    expect(() => createPersistOptions(memoryAdapter)).not.toThrow();

    // The v5 key must NOT exist (v4 data was never migrated into it)
    expect(ls.getItem('file-explorer-storage-v5')).toBeNull();

    // The v4 entry must remain untouched (no migration, no deletion by createPersistOptions)
    expect(ls.getItem('file-explorer-storage-v4')).toBe(staleV4State);
  });
});
