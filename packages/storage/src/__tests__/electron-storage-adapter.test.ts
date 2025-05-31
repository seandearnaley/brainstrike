import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronStorageAdapter } from '../adapters/electron-storage-adapter';

let storageFile: string;
let userDataDir: string;
let adapter: ElectronStorageAdapter;

vi.mock('electron', () => ({
  app: {
    whenReady: () => Promise.resolve(),
    getPath: () => userDataDir,
  },
}));

describe('ElectronStorageAdapter', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'userdata-'));
    storageFile = path.join(userDataDir, `store-${Date.now()}.json`);
    vi.doMock('electron', () => ({
      app: {
        whenReady: () => Promise.resolve(),
        getPath: () => userDataDir,
      },
    }));
    adapter = new ElectronStorageAdapter(path.basename(storageFile));
  });

  afterEach(async () => {
    await fsPromises.rm(storageFile, { force: true });
    await fsPromises.rm(userDataDir, { recursive: true, force: true });
  });

  it('should set and get values', async () => {
    await adapter.setItem('key', 'value');
    expect(await adapter.getItem('key')).toBe('value');
  });

  it('should remove values', async () => {
    await adapter.setItem('key', 'value');
    await adapter.removeItem('key');
    expect(await adapter.getItem('key')).toBeNull();
  });

  it('should persist values to disk', async () => {
    await adapter.setItem('key', 'value');
    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));
    expect(await adapter2.getItem('key')).toBe('value');
    expect(fs.existsSync(storageFile)).toBe(true);
  });

  it('should clear storage', async () => {
    await adapter.setItem('key1', 'value1');
    await adapter.setItem('key2', 'value2');
    await adapter.clear();
    expect(await adapter.getAllKeys()).toEqual([]);
  });
});
