import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronStorageAdapter } from '../adapters/electron-storage-adapter';

let storageFile: string;
let userDataDir: string;
let adapter: ElectronStorageAdapter;

// Use a mutable object so the mock can always read the current value
// Initialize with a safe temp path to prevent writing to cwd
const mockState = { userDataDir: '/tmp/electron-storage-test-init' };

// Mock electron at the top level - this is hoisted and always active
vi.mock('electron', () => {
  // The mock module object must be created fresh each time
  return {
    app: {
      whenReady: () => Promise.resolve(),
      getPath: (name: string) => {
        if (name === 'userData') {
          // Access the mockState object which will be mutated by beforeEach
          return mockState.userDataDir;
        }
        return '';
      },
    },
  };
});

describe('ElectronStorageAdapter', () => {
  beforeEach(() => {
    // Create temp directory and update mock state
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'userdata-'));
    storageFile = path.join(userDataDir, `store-${Date.now()}.json`);
    mockState.userDataDir = userDataDir;

    // Create the adapter instance
    adapter = new ElectronStorageAdapter(path.basename(storageFile));
  });

  afterEach(async () => {
    // Clean up files
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

  it('should return all keys', async () => {
    await adapter.setItem('key1', 'value1');
    await adapter.setItem('key2', 'value2');
    await adapter.setItem('key3', 'value3');
    const keys = await adapter.getAllKeys();
    expect(keys.sort()).toEqual(['key1', 'key2', 'key3']);
  });

  it('should return empty array when no keys exist', async () => {
    const keys = await adapter.getAllKeys();
    expect(keys).toEqual([]);
  });

  it('should overwrite existing values', async () => {
    await adapter.setItem('key', 'value1');
    expect(await adapter.getItem('key')).toBe('value1');
    await adapter.setItem('key', 'value2');
    expect(await adapter.getItem('key')).toBe('value2');
  });

  it('should handle special characters in keys', async () => {
    const specialKeys = [
      'key-with-dashes',
      'key_with_underscores',
      'key.with.dots',
      'key:with:colons',
      'key/with/slashes',
      'key with spaces',
    ];
    for (const key of specialKeys) {
      await adapter.setItem(key, `value-${key}`);
    }
    for (const key of specialKeys) {
      expect(await adapter.getItem(key)).toBe(`value-${key}`);
    }
  });

  it('should handle special characters in values', async () => {
    const specialValues = [
      'value with\nnewlines',
      'value with\ttabs',
      'value with "quotes"',
      "value with 'single quotes'",
      'value with \\backslashes',
      '{"json": "value"}',
      '["array", "value"]',
    ];
    for (let i = 0; i < specialValues.length; i++) {
      await adapter.setItem(`key${i}`, specialValues[i] ?? '');
    }
    for (let i = 0; i < specialValues.length; i++) {
      expect(await adapter.getItem(`key${i}`)).toBe(specialValues[i]);
    }
  });

  it('should handle unicode characters', async () => {
    const unicodeKey = '键名';
    const unicodeValue = '值 🚀';
    await adapter.setItem(unicodeKey, unicodeValue);
    expect(await adapter.getItem(unicodeKey)).toBe(unicodeValue);
  });

  it('should handle empty string values', async () => {
    await adapter.setItem('empty', '');
    expect(await adapter.getItem('empty')).toBe('');
  });

  it('should handle very long values', async () => {
    const longValue = 'x'.repeat(10000);
    await adapter.setItem('long', longValue);
    expect(await adapter.getItem('long')).toBe(longValue);
  });

  it('should handle concurrent operations', async () => {
    const operations = [];
    for (let i = 0; i < 10; i++) {
      operations.push(adapter.setItem(`key${i}`, `value${i}`));
    }
    await Promise.all(operations);

    for (let i = 0; i < 10; i++) {
      expect(await adapter.getItem(`key${i}`)).toBe(`value${i}`);
    }
  });

  it('should handle mixed concurrent read/write operations', async () => {
    await adapter.setItem('key1', 'initial');
    const operations = [
      adapter.getItem('key1'),
      adapter.setItem('key2', 'value2'),
      adapter.getItem('key1'),
      adapter.setItem('key3', 'value3'),
      adapter.getAllKeys(),
    ];
    const results = await Promise.all(operations);

    expect(results[0]).toBe('initial');
    expect(results[2]).toBe('initial');
    expect(Array.isArray(results[4])).toBe(true);
  });

  it('should handle corrupted JSON file gracefully', async () => {
    await adapter.setItem('initial', 'value');

    // Write corrupted JSON to the file
    await fsPromises.writeFile(storageFile, 'invalid json {]', 'utf8');

    // Create new adapter that will load the corrupted file
    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));

    // Should handle corruption gracefully and start with empty cache
    const value = await adapter2.getItem('initial');
    expect(value).toBeNull();
  });

  it('should create storage directory if it does not exist', async () => {
    const nestedPath = path.join(userDataDir, 'nested', 'deep', 'storage.json');
    const nestedAdapter = new ElectronStorageAdapter(path.relative(userDataDir, nestedPath));

    await nestedAdapter.setItem('key', 'value');

    expect(fs.existsSync(nestedPath)).toBe(true);
    expect(await nestedAdapter.getItem('key')).toBe('value');

    // Cleanup
    await fsPromises.rm(path.join(userDataDir, 'nested'), { recursive: true, force: true });
  });

  it('should persist after removing items', async () => {
    await adapter.setItem('key1', 'value1');
    await adapter.setItem('key2', 'value2');
    await adapter.removeItem('key1');

    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));
    expect(await adapter2.getItem('key1')).toBeNull();
    expect(await adapter2.getItem('key2')).toBe('value2');
  });

  it('should persist after clear', async () => {
    await adapter.setItem('key1', 'value1');
    await adapter.clear();

    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));
    expect(await adapter2.getAllKeys()).toEqual([]);
  });

  it('should wait for initialization before operations', async () => {
    const adapter3 = new ElectronStorageAdapter(path.basename(storageFile));

    // Operations should wait for ready
    const setPromise = adapter3.setItem('key', 'value');
    const getPromise = adapter3.getItem('key');
    const getAllPromise = adapter3.getAllKeys();

    await Promise.all([setPromise, getPromise, getAllPromise]);

    expect(await adapter3.getItem('key')).toBe('value');
  });

  it('should handle rapid set/remove cycles', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.setItem('cycle', `value${i}`);
      await adapter.removeItem('cycle');
    }
    expect(await adapter.getItem('cycle')).toBeNull();
  });

  it('should maintain data integrity across multiple instances', async () => {
    const adapter1 = new ElectronStorageAdapter(path.basename(storageFile));
    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));

    await adapter1.setItem('shared', 'value1');
    await adapter2.setItem('shared', 'value2');

    // Last write wins
    const finalAdapter = new ElectronStorageAdapter(path.basename(storageFile));
    const value = await finalAdapter.getItem('shared');
    expect(value).toBeTruthy();
  });

  it('should handle empty storage file', async () => {
    // Create empty file
    await fsPromises.writeFile(storageFile, '', 'utf8');

    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));
    expect(await adapter2.getAllKeys()).toEqual([]);
  });

  it('should handle whitespace-only storage file', async () => {
    // Create file with only whitespace
    await fsPromises.writeFile(storageFile, '   \n\t  ', 'utf8');

    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));
    expect(await adapter2.getAllKeys()).toEqual([]);
  });

  it('should case-sensitively store keys', async () => {
    await adapter.setItem('Key', 'value1');
    await adapter.setItem('key', 'value2');
    await adapter.setItem('KEY', 'value3');

    expect(await adapter.getItem('Key')).toBe('value1');
    expect(await adapter.getItem('key')).toBe('value2');
    expect(await adapter.getItem('KEY')).toBe('value3');
    expect((await adapter.getAllKeys()).length).toBe(3);
  });

  it('should return null for non-existent keys', async () => {
    expect(await adapter.getItem('nonexistent')).toBeNull();
  });

  it('should not fail when removing non-existent keys', async () => {
    await expect(adapter.removeItem('nonexistent')).resolves.toBeUndefined();
  });

  it('should handle numeric-like string keys', async () => {
    await adapter.setItem('123', 'numeric key');
    await adapter.setItem('0', 'zero key');
    await adapter.setItem('3.14', 'pi key');

    expect(await adapter.getItem('123')).toBe('numeric key');
    expect(await adapter.getItem('0')).toBe('zero key');
    expect(await adapter.getItem('3.14')).toBe('pi key');
  });

  it('should preserve order of keys (insertion order)', async () => {
    await adapter.setItem('z', 'last');
    await adapter.setItem('a', 'first');
    await adapter.setItem('m', 'middle');

    const keys = await adapter.getAllKeys();
    expect(keys).toEqual(['z', 'a', 'm']);
  });
});
