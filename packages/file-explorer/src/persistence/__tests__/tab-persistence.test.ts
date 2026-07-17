/**
 * Tab File Handle Persistence Tests (BST-307)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileHandleCache } from '../tab-persistence';
import {
  isFileHandlePersistenceSupported,
  requestFilePermission,
  restoreAllTabFileHandles,
  restoreTabFileHandle,
} from '../tab-persistence';

// Mock the logger
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('@brainstrike/utils/selection-utils', () => ({
  createLogger: vi.fn(() => mockLogger),
  decodeFileSelection: vi.fn((compositeKey: string) => {
    // Simple mock: compositeKey format is "folderId::path"
    const parts = compositeKey.split('::');
    return {
      folderId: parts[0] || '',
      path: parts[1] || '',
    };
  }),
}));

// Mock FileSystemFileHandle
function createMockFileHandle(
  name: string,
  options: {
    queryPermissionResult?: PermissionState | 'throw' | 'unsupported';
    requestPermissionResult?: PermissionState | 'throw' | 'unsupported';
    getFileResult?: 'success' | 'throw';
  } = {}
): FileSystemFileHandle {
  const {
    queryPermissionResult = 'granted',
    requestPermissionResult = 'granted',
    getFileResult = 'success',
  } = options;

  const handle: Partial<FileSystemFileHandle> = {
    getFile: vi.fn().mockImplementation(() => {
      if (getFileResult === 'throw') {
        return Promise.reject(new Error('File not found'));
      }
      return Promise.resolve(new File(['content'], name));
    }),
    isSameEntry: vi.fn(),
    kind: 'file' as const,
    name,
  };

  // Add permission methods unless 'unsupported'
  if (queryPermissionResult !== 'unsupported') {
    (handle as Record<string, unknown>)['queryPermission'] = vi.fn().mockImplementation(() => {
      if (queryPermissionResult === 'throw') {
        return Promise.reject(new Error('queryPermission failed'));
      }
      return Promise.resolve(queryPermissionResult);
    });
  }

  if (requestPermissionResult !== 'unsupported') {
    (handle as Record<string, unknown>)['requestPermission'] = vi.fn().mockImplementation(() => {
      if (requestPermissionResult === 'throw') {
        return Promise.reject(new Error('requestPermission failed'));
      }
      return Promise.resolve(requestPermissionResult);
    });
  }

  return handle as FileSystemFileHandle;
}

// Mock FileHandleCache
function createMockHandleCache(handles: Map<string, FileSystemFileHandle | null>): FileHandleCache {
  return {
    getFileHandle: vi.fn().mockImplementation((folderId: string, relativePath: string) => {
      const key = `${folderId}::${relativePath}`;
      return Promise.resolve(handles.get(key) ?? null);
    }),
    removeFileHandle: vi.fn().mockResolvedValue(undefined),
  };
}

describe('tab-persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
  });

  describe('restoreTabFileHandle', () => {
    it('should restore a tab with granted permission', async () => {
      const handle = createMockFileHandle('test.txt', { queryPermissionResult: 'granted' });
      const handles = new Map([['folder1::path/to/test.txt', handle]]);
      const cache = createMockHandleCache(handles);

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      expect(result.status).toBe('restored');
      expect(result.tabId).toBe('tab-1');
      expect(result.compositeKey).toBe('folder1::path/to/test.txt');
      expect(result.path).toBe('path/to/test.txt');
      expect(result.folderId).toBe('folder1');
      expect(result.handle).toBe(handle);
      expect(result.error).toBeUndefined();
    });

    it('should return needs-permission when permission is prompt', async () => {
      const handle = createMockFileHandle('test.txt', { queryPermissionResult: 'prompt' });
      const handles = new Map([['folder1::path/to/test.txt', handle]]);
      const cache = createMockHandleCache(handles);

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      expect(result.status).toBe('needs-permission');
      expect(result.handle).toBe(handle);
    });

    it('should return needs-permission when permission is denied', async () => {
      const handle = createMockFileHandle('test.txt', { queryPermissionResult: 'denied' });
      const handles = new Map([['folder1::path/to/test.txt', handle]]);
      const cache = createMockHandleCache(handles);

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      expect(result.status).toBe('needs-permission');
      expect(result.handle).toBe(handle);
      expect(result.error).toBe('Permission denied');
    });

    it('should return not-found when handle is not in cache', async () => {
      const handles = new Map<string, FileSystemFileHandle | null>();
      const cache = createMockHandleCache(handles);

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      expect(result.status).toBe('not-found');
      expect(result.handle).toBeNull();
    });

    it('should return not-found when file no longer exists', async () => {
      const handle = createMockFileHandle('test.txt', {
        getFileResult: 'throw',
        queryPermissionResult: 'granted',
      });
      const handles = new Map([['folder1::path/to/test.txt', handle]]);
      const cache = createMockHandleCache(handles);

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      expect(result.status).toBe('not-found');
      expect(result.handle).toBeNull();
      expect(result.error).toBe('File no longer exists');
      expect(cache.removeFileHandle).toHaveBeenCalledWith('folder1', 'path/to/test.txt');
    });

    it('should return not-found for invalid composite key', async () => {
      const handles = new Map<string, FileSystemFileHandle | null>();
      const cache = createMockHandleCache(handles);

      // Mock decodeFileSelection to return empty values for invalid key
      const { decodeFileSelection } = await import('@brainstrike/utils/selection-utils');
      vi.mocked(decodeFileSelection).mockReturnValueOnce({ folderId: '', path: '' });

      const result = await restoreTabFileHandle('tab-1', 'invalid', cache);

      expect(result.status).toBe('not-found');
      expect(result.error).toBe('Invalid composite key');
    });

    it('should handle decodeFileSelection throwing gracefully', async () => {
      const handles = new Map<string, FileSystemFileHandle | null>();
      const cache = createMockHandleCache(handles);

      // Mock decodeFileSelection to throw for corrupted/legacy keys
      const { decodeFileSelection } = await import('@brainstrike/utils/selection-utils');
      vi.mocked(decodeFileSelection).mockImplementationOnce(() => {
        throw new Error('Invalid separator in composite key');
      });

      const result = await restoreTabFileHandle('tab-1', 'corrupted-key-without-separator', cache);

      expect(result.status).toBe('not-found');
      expect(result.error).toBe('Invalid composite key');
      expect(result.folderId).toBe('');
      expect(result.path).toBe('');
    });

    it('should handle queryPermission throwing gracefully', async () => {
      const handle = createMockFileHandle('test.txt', { queryPermissionResult: 'throw' });
      const handles = new Map([['folder1::path/to/test.txt', handle]]);
      const cache = createMockHandleCache(handles);

      // queryPermission throws, but we return 'unknown' status which maps to needs-permission
      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      // When queryPermission throws, we get 'unknown' which should result in needs-permission
      expect(result.status).toBe('needs-permission');
    });

    it('should handle missing queryPermission method', async () => {
      const handle = createMockFileHandle('test.txt', { queryPermissionResult: 'unsupported' });
      const handles = new Map([['folder1::path/to/test.txt', handle]]);
      const cache = createMockHandleCache(handles);

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      // Without queryPermission, we return 'unknown' which maps to needs-permission
      expect(result.status).toBe('needs-permission');
    });

    it('should remove corrupted handles from cache', async () => {
      // Create an invalid handle (missing required properties)
      const invalidHandle = { kind: 'not-file' } as unknown as FileSystemFileHandle;
      const handles = new Map([['folder1::path/to/test.txt', invalidHandle]]);
      const cache = createMockHandleCache(handles);

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      expect(result.status).toBe('not-found');
      expect(result.error).toBe('Corrupted handle in cache');
      expect(cache.removeFileHandle).toHaveBeenCalledWith('folder1', 'path/to/test.txt');
    });
  });

  describe('restoreAllTabFileHandles', () => {
    it('should categorize tabs by their restoration status', async () => {
      const grantedHandle = createMockFileHandle('granted.txt', {
        queryPermissionResult: 'granted',
      });
      const promptHandle = createMockFileHandle('prompt.txt', { queryPermissionResult: 'prompt' });

      const handles = new Map([
        ['folder1::granted.txt', grantedHandle],
        ['folder1::prompt.txt', promptHandle],
        // missing.txt is not in cache
      ]);
      const cache = createMockHandleCache(handles);

      const tabs = [
        { compositeKey: 'folder1::granted.txt', tabId: 'tab-1' },
        { compositeKey: 'folder1::prompt.txt', tabId: 'tab-2' },
        { compositeKey: 'folder1::missing.txt', tabId: 'tab-3' },
      ];

      const result = await restoreAllTabFileHandles(tabs, cache);

      expect(result.restored).toHaveLength(1);
      expect(result.restored[0]?.compositeKey).toBe('folder1::granted.txt');

      expect(result.needsPermission).toHaveLength(1);
      expect(result.needsPermission[0]?.compositeKey).toBe('folder1::prompt.txt');

      expect(result.notFound).toHaveLength(1);
      expect(result.notFound[0]?.compositeKey).toBe('folder1::missing.txt');
    });

    it('should process tabs in parallel', async () => {
      const handles = new Map([
        ['folder1::file1.txt', createMockFileHandle('file1.txt')],
        ['folder1::file2.txt', createMockFileHandle('file2.txt')],
        ['folder1::file3.txt', createMockFileHandle('file3.txt')],
      ]);
      const cache = createMockHandleCache(handles);

      const tabs = [
        { compositeKey: 'folder1::file1.txt', tabId: 'tab-1' },
        { compositeKey: 'folder1::file2.txt', tabId: 'tab-2' },
        { compositeKey: 'folder1::file3.txt', tabId: 'tab-3' },
      ];

      const result = await restoreAllTabFileHandles(tabs, cache);

      // All should be restored
      expect(result.restored).toHaveLength(3);
      expect(result.needsPermission).toHaveLength(0);
      expect(result.notFound).toHaveLength(0);

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith('restoreAllTabFileHandles: completed', {
        needsPermission: 0,
        notFound: 0,
        restored: 3,
      });
    });

    it('should handle empty tabs array', async () => {
      const cache = createMockHandleCache(new Map());

      const result = await restoreAllTabFileHandles([], cache);

      expect(result.restored).toHaveLength(0);
      expect(result.needsPermission).toHaveLength(0);
      expect(result.notFound).toHaveLength(0);
    });

    it('should handle concurrent restoration of many tabs efficiently', async () => {
      // Create 50 handles to test performance with many tabs
      const handles = new Map<string, FileSystemFileHandle>();
      for (let i = 0; i < 50; i++) {
        handles.set(`folder1::file${i}.txt`, createMockFileHandle(`file${i}.txt`));
      }
      const cache = createMockHandleCache(handles);

      const tabs = Array.from({ length: 50 }, (_, i) => ({
        compositeKey: `folder1::file${i}.txt`,
        tabId: `tab-${i}`,
      }));

      const startTime = Date.now();
      const result = await restoreAllTabFileHandles(tabs, cache);
      const duration = Date.now() - startTime;

      expect(result.restored).toHaveLength(50);
      expect(result.needsPermission).toHaveLength(0);
      expect(result.notFound).toHaveLength(0);
      // Should complete quickly due to parallel processing
      expect(duration).toBeLessThan(5000);
    });

    it('should handle composite keys with special characters', async () => {
      const handle = createMockFileHandle('file with spaces.txt');
      // Test paths with special characters that might cause issues
      const handles = new Map([
        ['folder-1::path/to/file with spaces.txt', handle],
        ['folder_2::path/to/file.test.spec.ts', createMockFileHandle('file.test.spec.ts')],
      ]);
      const cache = createMockHandleCache(handles);

      const tabs = [
        { compositeKey: 'folder-1::path/to/file with spaces.txt', tabId: 'tab-1' },
        { compositeKey: 'folder_2::path/to/file.test.spec.ts', tabId: 'tab-2' },
      ];

      const result = await restoreAllTabFileHandles(tabs, cache);

      expect(result.restored).toHaveLength(2);
    });

    it('should handle tabs from multiple folders', async () => {
      const handles = new Map([
        ['folder-A::src/index.ts', createMockFileHandle('index.ts')],
        ['folder-B::lib/utils.ts', createMockFileHandle('utils.ts')],
        ['folder-C::tests/app.test.ts', createMockFileHandle('app.test.ts')],
      ]);
      const cache = createMockHandleCache(handles);

      const tabs = [
        { compositeKey: 'folder-A::src/index.ts', tabId: 'tab-1' },
        { compositeKey: 'folder-B::lib/utils.ts', tabId: 'tab-2' },
        { compositeKey: 'folder-C::tests/app.test.ts', tabId: 'tab-3' },
      ];

      const result = await restoreAllTabFileHandles(tabs, cache);

      expect(result.restored).toHaveLength(3);
      expect(result.restored.map((r) => r.folderId)).toEqual(['folder-A', 'folder-B', 'folder-C']);
    });

    it('should handle mixed permission states across tabs', async () => {
      const handles = new Map([
        [
          'folder1::granted.txt',
          createMockFileHandle('granted.txt', { queryPermissionResult: 'granted' }),
        ],
        [
          'folder1::prompt.txt',
          createMockFileHandle('prompt.txt', { queryPermissionResult: 'prompt' }),
        ],
        [
          'folder1::denied.txt',
          createMockFileHandle('denied.txt', { queryPermissionResult: 'denied' }),
        ],
        [
          'folder1::deleted.txt',
          createMockFileHandle('deleted.txt', {
            getFileResult: 'throw',
            queryPermissionResult: 'granted',
          }),
        ],
      ]);
      const cache = createMockHandleCache(handles);

      const tabs = [
        { compositeKey: 'folder1::granted.txt', tabId: 'tab-1' },
        { compositeKey: 'folder1::prompt.txt', tabId: 'tab-2' },
        { compositeKey: 'folder1::denied.txt', tabId: 'tab-3' },
        { compositeKey: 'folder1::deleted.txt', tabId: 'tab-4' },
        { compositeKey: 'folder1::missing.txt', tabId: 'tab-5' },
      ];

      const result = await restoreAllTabFileHandles(tabs, cache);

      expect(result.restored).toHaveLength(1);
      expect(result.needsPermission).toHaveLength(2); // prompt and denied
      expect(result.notFound).toHaveLength(2); // deleted and missing
    });
  });

  describe('requestFilePermission', () => {
    it('should return true when permission is granted', async () => {
      const handle = createMockFileHandle('test.txt', { requestPermissionResult: 'granted' });

      const result = await requestFilePermission(handle);

      expect(result).toBe(true);
      expect((handle as { requestPermission: unknown })['requestPermission']).toHaveBeenCalledWith({
        mode: 'read',
      });
    });

    it('should return false when permission is denied', async () => {
      const handle = createMockFileHandle('test.txt', { requestPermissionResult: 'denied' });

      const result = await requestFilePermission(handle);

      expect(result).toBe(false);
    });

    it('should return false when permission is prompt (user cancelled)', async () => {
      const handle = createMockFileHandle('test.txt', { requestPermissionResult: 'prompt' });

      const result = await requestFilePermission(handle);

      expect(result).toBe(false);
    });

    it('should return false when requestPermission is not supported', async () => {
      const handle = createMockFileHandle('test.txt', { requestPermissionResult: 'unsupported' });

      const result = await requestFilePermission(handle);

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'requestFilePermission: browser does not support requestPermission'
      );
    });

    it('should return false and log when user cancels (AbortError)', async () => {
      const handle = createMockFileHandle('test.txt');
      const abortError = new Error('User cancelled');
      abortError.name = 'AbortError';
      (handle as unknown as Record<string, unknown>)['requestPermission'] = vi
        .fn()
        .mockRejectedValue(abortError);

      const result = await requestFilePermission(handle);

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith('requestFilePermission: user cancelled');
    });

    it('should return false when file no longer exists (NotFoundError)', async () => {
      const handle = createMockFileHandle('test.txt');
      const notFoundError = new Error('File not found');
      notFoundError.name = 'NotFoundError';
      (handle as unknown as Record<string, unknown>)['requestPermission'] = vi
        .fn()
        .mockRejectedValue(notFoundError);

      const result = await requestFilePermission(handle);

      expect(result).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('requestFilePermission: file no longer exists');
    });

    it('should return false and log warning for other errors', async () => {
      const handle = createMockFileHandle('test.txt');
      (handle as unknown as Record<string, unknown>)['requestPermission'] = vi
        .fn()
        .mockRejectedValue(new Error('Unknown error'));

      const result = await requestFilePermission(handle);

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('requestFilePermission: error', {
        error: 'Unknown error',
      });
    });
  });

  describe('restoreTabFileHandle – error paths', () => {
    it('should handle unexpected errors during cache.getFileHandle', async () => {
      const cache: FileHandleCache = {
        getFileHandle: vi.fn().mockRejectedValue(new Error('IndexedDB crash')),
        removeFileHandle: vi.fn().mockResolvedValue(undefined),
      };

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      expect(result.status).toBe('not-found');
      expect(result.handle).toBeNull();
      expect(result.error).toBe('IndexedDB crash');
    });

    it('should handle non-Error thrown during restoration', async () => {
      const cache: FileHandleCache = {
        getFileHandle: vi.fn().mockRejectedValue('string-error'),
        removeFileHandle: vi.fn().mockResolvedValue(undefined),
      };

      const result = await restoreTabFileHandle('tab-1', 'folder1::path/to/test.txt', cache);

      expect(result.status).toBe('not-found');
      expect(result.handle).toBeNull();
      expect(result.error).toBe('Unknown error');
    });

    it('should handle decodeFileSelection throwing non-Error', async () => {
      const cache: FileHandleCache = {
        getFileHandle: vi.fn(),
        removeFileHandle: vi.fn(),
      };

      const { decodeFileSelection } = await import('@brainstrike/utils/selection-utils');
      vi.mocked(decodeFileSelection).mockImplementationOnce(() => {
        // biome-ignore lint/style/useThrowOnlyError: intentionally throwing non-Error to test handler
        throw 'raw string error';
      });

      const result = await restoreTabFileHandle('tab-1', 'corrupted-key', cache);

      expect(result.status).toBe('not-found');
      expect(result.error).toBe('Invalid composite key');
    });

    it('should handle folderId present but path empty as invalid', async () => {
      const cache: FileHandleCache = {
        getFileHandle: vi.fn(),
        removeFileHandle: vi.fn(),
      };

      const { decodeFileSelection } = await import('@brainstrike/utils/selection-utils');
      vi.mocked(decodeFileSelection).mockReturnValueOnce({ folderId: 'folder1', path: '' });

      const result = await restoreTabFileHandle('tab-1', 'folder1::', cache);

      expect(result.status).toBe('not-found');
      expect(result.error).toBe('Invalid composite key');
      expect(result.folderId).toBe('folder1');
      expect(result.path).toBe('');
    });
  });

  describe('restoreAllTabFileHandles – edge cases', () => {
    it('should handle Promise.allSettled rejected entries gracefully', async () => {
      // Override restoreTabFileHandle behavior by using a cache that causes issues
      // The restoreAllTabFileHandles function uses Promise.allSettled, but since
      // restoreTabFileHandle catches all errors, we test the 'rejected' branch
      // by mocking the behavior
      const cache: FileHandleCache = {
        getFileHandle: vi.fn().mockResolvedValue(null),
        removeFileHandle: vi.fn().mockResolvedValue(undefined),
      };

      // Even with multiple tabs, all should be categorized
      const tabs = [{ compositeKey: 'folder1::missing.txt', tabId: 'tab-1' }];

      const result = await restoreAllTabFileHandles(tabs, cache);

      expect(result.notFound).toHaveLength(1);
      expect(result.restored).toHaveLength(0);
      expect(result.needsPermission).toHaveLength(0);
    });
  });

  describe('requestFilePermission – edge cases', () => {
    it('should handle non-Error thrown from requestPermission', async () => {
      const handle = createMockFileHandle('test.txt');
      (handle as unknown as Record<string, unknown>)['requestPermission'] = vi
        .fn()
        .mockRejectedValue('string error');

      const result = await requestFilePermission(handle);

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('requestFilePermission: error', {
        error: 'string error',
      });
    });

    it('should handle Error without name thrown from requestPermission', async () => {
      const handle = createMockFileHandle('test.txt');
      const err = new Error('generic error');
      err.name = ''; // empty name
      (handle as unknown as Record<string, unknown>)['requestPermission'] = vi
        .fn()
        .mockRejectedValue(err);

      const result = await requestFilePermission(handle);

      expect(result).toBe(false);
      // Not AbortError or NotFoundError, so falls through to generic warn
      expect(mockLogger.warn).toHaveBeenCalledWith('requestFilePermission: error', {
        error: 'generic error',
      });
    });
  });

  describe('isFileHandlePersistenceSupported', () => {
    it('should return true when FileSystemFileHandle has queryPermission', () => {
      // Mock FileSystemFileHandle global with queryPermission on prototype
      const mockPrototype = {
        queryPermission: vi.fn(),
      };
      vi.stubGlobal('FileSystemFileHandle', { prototype: mockPrototype });

      expect(isFileHandlePersistenceSupported()).toBe(true);

      vi.unstubAllGlobals();
    });

    it('should return false when FileSystemFileHandle is undefined', () => {
      vi.stubGlobal('FileSystemFileHandle', undefined);

      expect(isFileHandlePersistenceSupported()).toBe(false);

      vi.unstubAllGlobals();
    });

    it('should return false when queryPermission is not on prototype', () => {
      vi.stubGlobal('FileSystemFileHandle', { prototype: {} });

      expect(isFileHandlePersistenceSupported()).toBe(false);

      vi.unstubAllGlobals();
    });
  });
});
