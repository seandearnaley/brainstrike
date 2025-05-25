import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ElectronStorageAdapter } from '../adapters/electron-storage-adapter';

let storageFile: string;
let adapter: ElectronStorageAdapter;

describe('ElectronStorageAdapter', () => {
  beforeEach(() => {
    storageFile = path.join(os.tmpdir(), `store-${Date.now()}.json`);
    adapter = new ElectronStorageAdapter(storageFile);
  });

  afterEach(async () => {
    await fs.rm(storageFile, { force: true });
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
    const adapter2 = new ElectronStorageAdapter(storageFile);
    expect(await adapter2.getItem('key')).toBe('value');
  });

  it('should clear storage', async () => {
    await adapter.setItem('key1', 'value1');
    await adapter.setItem('key2', 'value2');
    await adapter.clear();
    expect(await adapter.getAllKeys()).toEqual([]);
  });
});
