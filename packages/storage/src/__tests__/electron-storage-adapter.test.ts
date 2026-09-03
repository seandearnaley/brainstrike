import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ElectronStorageAdapter,
  InvalidUserDataPathError,
  StorageFileLoadError,
} from '../adapters/electron-storage-adapter.js';

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
      getPath: (name: string) => {
        if (name === 'userData') {
          // Access the mockState object which will be mutated by beforeEach
          return mockState.userDataDir;
        }
        return '';
      },
      whenReady: () => Promise.resolve(),
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
    vi.restoreAllMocks();

    // Clean up files
    await fsPromises.rm(storageFile, { force: true });
    await fsPromises.rm(userDataDir, { force: true, recursive: true });
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

  it('should atomically clear every key except an explicit preserved set', async () => {
    await adapter.setItem('renderer-preference', 'value');
    await adapter.setItem('rootsList', 'main-owned');
    await adapter.setItem('notesVaultRoots', 'main-owned');

    await adapter.clearExcept(['rootsList', 'notesVaultRoots']);

    expect(await adapter.getItem('renderer-preference')).toBeNull();
    expect(await adapter.getItem('rootsList')).toBe('main-owned');
    expect(await adapter.getItem('notesVaultRoots')).toBe('main-owned');
    expect(JSON.parse(await fsPromises.readFile(storageFile, 'utf8'))).toEqual({
      notesVaultRoots: 'main-owned',
      rootsList: 'main-owned',
    });
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
    const longValue = 'x'.repeat(10_000);
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

  it('should reject operations when the durable storage file is corrupted', async () => {
    await adapter.getAllKeys();

    // Write corrupted JSON to the file
    const corruptedContent = 'invalid json {]';
    await fsPromises.writeFile(storageFile, corruptedContent, 'utf8');

    // Create new adapter that will load the corrupted file
    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));

    await expect(adapter2.getItem('initial')).rejects.toThrow(StorageFileLoadError);
    await expect(adapter2.setItem('new', 'value')).rejects.toThrow(StorageFileLoadError);
    await expect(fsPromises.readFile(storageFile, 'utf8')).resolves.toBe(corruptedContent);
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a scalar', '"value"'],
    ['an object with a non-string value', '{"valid":"value","invalid":42}'],
  ])('should reject durable storage containing %s', async (_description, content) => {
    await adapter.getAllKeys();
    await fsPromises.writeFile(storageFile, content, 'utf8');

    const invalidAdapter = new ElectronStorageAdapter(path.basename(storageFile));

    await expect(invalidAdapter.getAllKeys()).rejects.toThrow(StorageFileLoadError);
    await expect(fsPromises.readFile(storageFile, 'utf8')).resolves.toBe(content);
  });

  it('should allow clear to explicitly recover a corrupted durable storage file', async () => {
    await adapter.getAllKeys();
    await fsPromises.writeFile(storageFile, 'invalid json {]', 'utf8');

    const corruptedAdapter = new ElectronStorageAdapter(path.basename(storageFile));

    await expect(corruptedAdapter.clear()).resolves.toBeUndefined();
    await expect(corruptedAdapter.getAllKeys()).resolves.toEqual([]);
    await expect(fsPromises.readFile(storageFile, 'utf8')).resolves.toBe('{}');
    await expect(corruptedAdapter.setItem('recovered', 'value')).resolves.toBeUndefined();
  });

  it('should refuse clearExcept when protected records could not be loaded', async () => {
    await adapter.getAllKeys();
    const invalidContent = '{"rootsList":"main-owned","invalid":42}';
    await fsPromises.writeFile(storageFile, invalidContent, 'utf8');
    const invalidAdapter = new ElectronStorageAdapter(path.basename(storageFile));

    await expect(invalidAdapter.clearExcept(['rootsList'])).rejects.toThrow(StorageFileLoadError);
    await expect(fsPromises.readFile(storageFile, 'utf8')).resolves.toBe(invalidContent);
  });

  it('should create storage directory if it does not exist', async () => {
    // Use a relative path (relative to userDataDir, which is set in mockState)
    const relativePath = 'nested/deep/storage.json';

    // Debug: log what the mock returns
    const { app } = await import('electron');
    const actualUserDataPath = app.getPath('userData');

    const nestedAdapter = new ElectronStorageAdapter(relativePath);

    await nestedAdapter.setItem('key', 'value');

    // Verify the persisted value remains readable through the adapter.
    expect(await nestedAdapter.getItem('key')).toBe('value');

    // The adapter uses userDataDir + relativePath
    // Note: This test verifies that nested directories can be created
    // The actual file path depends on the mockState.userDataDir
    const expectedPath = path.join(actualUserDataPath, relativePath);
    const parentDir = path.dirname(expectedPath);

    // Check both the directory and file existence
    const dirExists = fs.existsSync(parentDir);
    const fileExists = fs.existsSync(expectedPath);

    // The adapter should create the directory structure and persist the file
    expect(dirExists || fileExists).toBe(true);

    // Cleanup - use the actual path from mock
    await fsPromises.rm(path.join(actualUserDataPath, 'nested'), {
      force: true,
      recursive: true,
    });
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

  it('should surface storage directory initialization failures', async () => {
    await adapter.getAllKeys();
    vi.spyOn(fsPromises, 'mkdir').mockRejectedValueOnce(new Error('Permission denied'));

    const failedAdapter = new ElectronStorageAdapter('cannot-initialize.json');

    await expect(failedAdapter.getItem('key')).rejects.toThrow('Permission denied');
    await expect(failedAdapter.clear()).rejects.toThrow('Permission denied');
  });

  it('should reject an invalid Electron userData path', async () => {
    await adapter.getAllKeys();
    mockState.userDataDir = process.cwd();

    const invalidPathAdapter = new ElectronStorageAdapter('invalid-user-data.json');

    await expect(invalidPathAdapter.getItem('key')).rejects.toThrow(InvalidUserDataPathError);
    await expect(invalidPathAdapter.clear()).rejects.toThrow(InvalidUserDataPathError);
  });

  it('should handle rapid set/remove cycles', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.setItem('cycle', `value${i}`);
      await adapter.removeItem('cycle');
    }
    expect(await adapter.getItem('cycle')).toBeNull();
  });

  it('should maintain data integrity across multiple instances', async () => {
    // Test sequential writes to shared file using sequential adapter creation
    const filename = path.basename(storageFile);

    // First adapter writes
    const adapter1 = new ElectronStorageAdapter(filename);
    await adapter1.setItem('shared', 'value1');

    // Second adapter writes (overwrites)
    const adapter2 = new ElectronStorageAdapter(filename);
    await adapter2.setItem('shared', 'value2');

    // Final adapter reads - should see the last written value
    const finalAdapter = new ElectronStorageAdapter(filename);
    const value = await finalAdapter.getItem('shared');
    expect(value).toBeTruthy();
  });

  it('should reject operations when the storage file is empty', async () => {
    await adapter.getAllKeys();

    // Create empty file
    await fsPromises.writeFile(storageFile, '', 'utf8');

    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));
    await expect(adapter2.getAllKeys()).rejects.toThrow(StorageFileLoadError);
  });

  it('should reject operations when the storage file is whitespace-only', async () => {
    await adapter.getAllKeys();

    // Create file with only whitespace
    await fsPromises.writeFile(storageFile, '   \n\t  ', 'utf8');

    const adapter2 = new ElectronStorageAdapter(path.basename(storageFile));
    await expect(adapter2.getAllKeys()).rejects.toThrow(StorageFileLoadError);
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

  describe('atomic writes', () => {
    it('should use atomic write pattern (temp file + rename)', async () => {
      // Spy on fs operations to verify atomic write pattern
      const writeFileSpy = vi.spyOn(fsPromises, 'writeFile');
      const renameSpy = vi.spyOn(fsPromises, 'rename');

      await adapter.setItem('atomic-test', 'value');

      // Should write to a temp file first
      expect(writeFileSpy).toHaveBeenCalled();
      const writeCall = writeFileSpy.mock.calls[0];
      const writePath = writeCall?.[0] as string;
      expect(writePath).toMatch(/\.tmp$/);

      // Should rename temp file to final path
      expect(renameSpy).toHaveBeenCalled();
      const renameCall = renameSpy.mock.calls[0];
      const renameSrc = renameCall?.[0] as string;
      const renameDest = renameCall?.[1] as string;
      expect(renameSrc).toMatch(/\.tmp$/);
      expect(renameDest).toBe(storageFile);

      writeFileSpy.mockRestore();
      renameSpy.mockRestore();
    });

    it('should clean up temp files on write failure', async () => {
      const writeFileSpy = vi
        .spyOn(fsPromises, 'writeFile')
        .mockRejectedValueOnce(new Error('Disk full'));
      const unlinkSpy = vi.spyOn(fsPromises, 'unlink').mockResolvedValue();

      await expect(adapter.setItem('fail-test', 'value')).rejects.toThrow('Disk full');

      // Should attempt to clean up temp file
      expect(unlinkSpy).toHaveBeenCalled();

      writeFileSpy.mockRestore();
      unlinkSpy.mockRestore();
    });

    it('should attempt a later persist after a write failure', async () => {
      await adapter.getAllKeys();
      const writeFileSpy = vi
        .spyOn(fsPromises, 'writeFile')
        .mockRejectedValueOnce(new Error('Disk full'));

      await expect(adapter.setItem('first', 'value1')).rejects.toThrow('Disk full');
      await expect(adapter.getItem('first')).resolves.toBeNull();
      await expect(adapter.setItem('second', 'value2')).resolves.toBeUndefined();
      expect(writeFileSpy).toHaveBeenCalledTimes(2);

      const reloadedAdapter = new ElectronStorageAdapter(path.basename(storageFile));
      await expect(reloadedAdapter.getItem('first')).resolves.toBeNull();
      await expect(reloadedAdapter.getItem('second')).resolves.toBe('value2');
    });

    it('should retain a removed value when its durable write fails', async () => {
      await adapter.setItem('retained', 'value');
      vi.spyOn(fsPromises, 'writeFile').mockRejectedValueOnce(new Error('Disk full'));

      await expect(adapter.removeItem('retained')).rejects.toThrow('Disk full');
      await expect(adapter.getItem('retained')).resolves.toBe('value');

      await adapter.setItem('later', 'value2');
      const reloadedAdapter = new ElectronStorageAdapter(path.basename(storageFile));
      await expect(reloadedAdapter.getItem('retained')).resolves.toBe('value');
    });

    it('should retain cleared values when the durable write fails', async () => {
      await adapter.setItem('retained', 'value');
      vi.spyOn(fsPromises, 'writeFile').mockRejectedValueOnce(new Error('Disk full'));

      await expect(adapter.clear()).rejects.toThrow('Disk full');
      await expect(adapter.getItem('retained')).resolves.toBe('value');

      await adapter.setItem('later', 'value2');
      const reloadedAdapter = new ElectronStorageAdapter(path.basename(storageFile));
      await expect(reloadedAdapter.getItem('retained')).resolves.toBe('value');
    });

    it('should serialize concurrent mutations in invocation order', async () => {
      await adapter.getAllKeys();
      const writeFileSpy = vi.spyOn(fsPromises, 'writeFile');

      await Promise.all([
        adapter.setItem('ordered', 'first'),
        adapter.setItem('ordered', 'second'),
      ]);

      const writtenValues = writeFileSpy.mock.calls.map(([, data]) => {
        const parsed = JSON.parse(String(data)) as Record<string, string>;
        return parsed['ordered'];
      });
      expect(writtenValues).toEqual(['first', 'second']);
    });

    it('should not leave temp files on successful write', async () => {
      await adapter.setItem('temp-check', 'value');

      // List all files in the directory
      const files = await fsPromises.readdir(userDataDir);

      // Should not have any .tmp files
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toEqual([]);
    });
  });

  describe('path containment', () => {
    it('should reject path traversal attempts with ../', async () => {
      // Import PathTraversalError for this test
      const { PathTraversalError } = await import('../adapters/electron-storage-adapter.js');

      const maliciousPath = '../../../etc/passwd';
      const maliciousAdapter = new ElectronStorageAdapter(maliciousPath);

      // The adapter initialization should fail due to path traversal
      // We need to trigger a method to wait for the ready promise
      await expect(maliciousAdapter.getItem('test')).rejects.toThrow(PathTraversalError);
    });

    it('should reject absolute path traversal attempts', async () => {
      const { PathTraversalError } = await import('../adapters/electron-storage-adapter.js');

      // This absolute path is outside userDataDir
      const absolutePath = '/etc/passwd';
      const maliciousAdapter = new ElectronStorageAdapter(absolutePath);

      await expect(maliciousAdapter.getItem('test')).rejects.toThrow(PathTraversalError);
    });

    it('should reject path with mixed traversal sequences', async () => {
      // path.resolve handles various traversal patterns
      const { PathTraversalError } = await import('../adapters/electron-storage-adapter.js');

      // These paths, when resolved, should escape the userDataDir
      // Note: Backslash traversal only works on Windows; on Unix backslash is a valid filename char
      const maliciousPaths = [
        'foo/../../../etc/passwd', // Mixed with valid prefix then escape
        './../../etc/passwd', // Starting with current dir then escape
        'subdir/../.././../etc/passwd', // Complex traversal pattern
      ];

      for (const maliciousPath of maliciousPaths) {
        const maliciousAdapter = new ElectronStorageAdapter(maliciousPath);
        await expect(maliciousAdapter.getItem('test')).rejects.toThrow(PathTraversalError);
      }
    });

    it('should reject paths that escape via symlink-like patterns', async () => {
      const { PathTraversalError } = await import('../adapters/electron-storage-adapter.js');

      // Paths that might try to escape through various means
      const maliciousPaths = [
        '../userdata-sibling/secret.json', // Try to access sibling directory
        '../../secret.json', // Simple parent escape
      ];

      for (const maliciousPath of maliciousPaths) {
        const maliciousAdapter = new ElectronStorageAdapter(maliciousPath);
        await expect(maliciousAdapter.getItem('test')).rejects.toThrow(PathTraversalError);
      }
    });

    it('should allow valid nested paths within userData', async () => {
      const validPath = 'config/settings/storage.json';
      const validAdapter = new ElectronStorageAdapter(validPath);

      // Should not throw
      await validAdapter.setItem('key', 'value');
      expect(await validAdapter.getItem('key')).toBe('value');

      // Cleanup
      await fsPromises.rm(path.join(userDataDir, 'config'), {
        force: true,
        recursive: true,
      });
    });

    it('should allow simple filenames', async () => {
      const simpleFilename = 'my-storage.json';
      const simpleAdapter = new ElectronStorageAdapter(simpleFilename);

      await simpleAdapter.setItem('simple', 'value');
      expect(await simpleAdapter.getItem('simple')).toBe('value');

      // Cleanup
      await fsPromises.rm(path.join(userDataDir, simpleFilename), { force: true });
    });

    it('should handle paths with special characters safely', async () => {
      // These should either work (if they stay within userData) or be rejected
      const safePaths = [
        'storage-file.json', // Hyphens are fine
        'storage_file.json', // Underscores are fine
        'storage.backup.json', // Multiple dots are fine
      ];

      for (const safePath of safePaths) {
        const safeAdapter = new ElectronStorageAdapter(safePath);
        await safeAdapter.setItem('test', 'value');
        expect(await safeAdapter.getItem('test')).toBe('value');

        // Cleanup
        await fsPromises.rm(path.join(userDataDir, safePath), { force: true });
      }
    });
  });

  describe('failure behavior', () => {
    it('should preserve the parse failure as the storage load error cause', async () => {
      await adapter.getAllKeys();

      // Write corrupted JSON to the file
      const corruptedContent = 'invalid json {]';
      await fsPromises.writeFile(storageFile, corruptedContent, 'utf8');

      const corruptedAdapter = new ElectronStorageAdapter(path.basename(storageFile));

      await expect(corruptedAdapter.getItem('test')).rejects.toMatchObject({
        cause: expect.any(SyntaxError),
        name: 'StorageFileLoadError',
      });
      await expect(fsPromises.readFile(storageFile, 'utf8')).resolves.toBe(corruptedContent);
    });
  });
});
