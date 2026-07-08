import type { StorageAdapter } from '@brainstrike/storage';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageWrapper } from '../storage-wrapper';
import type { WorkerStorage } from '../worker-storage';

// Mock the logger
const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

describe('StorageWrapper', () => {
  let mockStorage: StorageAdapter;
  let errorStorage: StorageAdapter;
  let mockWorkerStorage: Pick<WorkerStorage, 'getItem' | 'setItem'>;

  beforeEach(() => {
    mockStorage = new MemoryStorageAdapter();

    // Create a storage adapter that always throws errors
    errorStorage = {
      clear: vi.fn().mockRejectedValue(new Error('Clear error')),
      getAllKeys: vi.fn().mockRejectedValue(new Error('GetAllKeys error')),
      getItem: vi.fn().mockRejectedValue(new Error('Get error')),
      removeItem: vi.fn().mockRejectedValue(new Error('Remove error')),
      setItem: vi.fn().mockRejectedValue(new Error('Set error')),
    };

    mockWorkerStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
    };

    mockLogger.error.mockClear();
  });

  describe('getItem with shouldLog=true', () => {
    it('should log errors when storage fails and shouldLog=true', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, true);

      const result = await wrapper.getItem('test-key');

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error getting item from storage:',
        expect.any(Error)
      );
    });

    it('should not log errors when storage fails and shouldLog=false', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, false);

      const result = await wrapper.getItem('test-key');

      expect(result).toBeNull();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should return correct value when storage succeeds regardless of shouldLog', async () => {
      // Storage wrapper does JSON serialization, so we need to store JSON
      await mockStorage.setItem('test-key', JSON.stringify('test-value'));

      const wrapperWithLog = createStorageWrapper(mockStorage, false, null, true);
      const wrapperWithoutLog = createStorageWrapper(mockStorage, false, null, false);

      const result1 = await wrapperWithLog.getItem('test-key');
      const result2 = await wrapperWithoutLog.getItem('test-key');

      expect(result1).toBe('test-value');
      expect(result2).toBe('test-value');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('uses worker storage when enabled and parses worker JSON strings', async () => {
      vi.mocked(mockWorkerStorage.getItem).mockResolvedValueOnce(JSON.stringify({ ok: true }));
      const wrapper = createStorageWrapper(
        mockStorage,
        true,
        mockWorkerStorage as WorkerStorage,
        true
      );

      const result = await wrapper.getItem('test-key');

      expect(result).toEqual({ ok: true });
      expect(mockWorkerStorage.getItem).toHaveBeenCalledWith('test-key');
    });

    it('falls back to adapter storage when worker getItem throws', async () => {
      await mockStorage.setItem('test-key', JSON.stringify({ source: 'adapter' }));
      vi.mocked(mockWorkerStorage.getItem).mockRejectedValueOnce(new Error('worker failed'));
      const wrapper = createStorageWrapper(
        mockStorage,
        true,
        mockWorkerStorage as WorkerStorage,
        true
      );

      const result = await wrapper.getItem('test-key');

      expect(result).toEqual({ source: 'adapter' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Worker getItem failed, falling back to main thread:',
        expect.any(Error)
      );
    });

    it('clears invalid adapter JSON and logs the parse failure', async () => {
      await mockStorage.setItem('bad-json', '{not valid json');
      const wrapper = createStorageWrapper(mockStorage, false, null, true);

      const result = await wrapper.getItem('bad-json');

      expect(result).toBeNull();
      expect(await mockStorage.getItem('bad-json')).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Invalid JSON from storage adapter; clearing value',
        expect.objectContaining({ error: expect.any(SyntaxError), name: 'bad-json' })
      );
    });

    it('logs when invalid adapter JSON cannot be removed', async () => {
      const removeFailingStorage: StorageAdapter = {
        ...mockStorage,
        getItem: vi.fn().mockResolvedValue('{invalid'),
        removeItem: vi.fn().mockRejectedValue(new Error('remove failed')),
      };
      const wrapper = createStorageWrapper(removeFailingStorage, false, null, true);

      const result = await wrapper.getItem('bad-json');

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to remove invalid storage entry',
        expect.objectContaining({ error: expect.any(Error), name: 'bad-json' })
      );
    });

    it('returns null for invalid worker JSON and logs the parse failure', async () => {
      vi.mocked(mockWorkerStorage.getItem).mockResolvedValueOnce('{nope');
      const wrapper = createStorageWrapper(
        mockStorage,
        true,
        mockWorkerStorage as WorkerStorage,
        true
      );

      const result = await wrapper.getItem('bad-json');

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Invalid JSON from worker storage; ignoring value',
        expect.objectContaining({ error: expect.any(SyntaxError), name: 'bad-json' })
      );
    });
  });

  describe('setItem with shouldLog=true', () => {
    it('should log errors when storage fails and shouldLog=true', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, true);

      const result = await wrapper.setItem('test-key', 'test-value');

      expect(result.success).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error setting item in storage:',
        expect.any(Error)
      );
    });

    it('should not log errors when storage fails and shouldLog=false', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, false);

      const result = await wrapper.setItem('test-key', 'test-value');

      expect(result.success).toBe(false);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should complete successfully when storage works regardless of shouldLog', async () => {
      const wrapperWithLog = createStorageWrapper(mockStorage, false, null, true);
      const wrapperWithoutLog = createStorageWrapper(mockStorage, false, null, false);

      const resultWithLog = await wrapperWithLog.setItem('key1', 'value1');
      const resultWithoutLog = await wrapperWithoutLog.setItem('key2', 'value2');

      // Storage wrapper JSON stringifies values when storing
      expect(resultWithLog.success).toBe(true);
      expect(resultWithoutLog.success).toBe(true);
      expect(await mockStorage.getItem('key1')).toBe(JSON.stringify('value1'));
      expect(await mockStorage.getItem('key2')).toBe(JSON.stringify('value2'));
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('uses worker storage when enabled and returns success', async () => {
      vi.mocked(mockWorkerStorage.setItem).mockResolvedValueOnce(undefined);
      const wrapper = createStorageWrapper(
        mockStorage,
        true,
        mockWorkerStorage as WorkerStorage,
        true
      );

      const result = await wrapper.setItem('test-key', { ok: true });

      expect(result).toEqual({ success: true });
      expect(mockWorkerStorage.setItem).toHaveBeenCalledWith('test-key', { ok: true });
    });

    it('falls back to adapter storage when worker setItem throws', async () => {
      vi.mocked(mockWorkerStorage.setItem).mockRejectedValueOnce(new Error('worker failed'));
      const wrapper = createStorageWrapper(
        mockStorage,
        true,
        mockWorkerStorage as WorkerStorage,
        true
      );

      const result = await wrapper.setItem('test-key', { ok: true });

      expect(result).toEqual({ success: true });
      expect(await mockStorage.getItem('test-key')).toBe(JSON.stringify({ ok: true }));
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Worker setItem failed, falling back to immediate approach:',
        expect.any(Error)
      );
    });

    it('returns a failure result when worker and adapter setItem both fail', async () => {
      vi.mocked(mockWorkerStorage.setItem).mockRejectedValueOnce(new Error('worker failed'));
      const wrapper = createStorageWrapper(
        errorStorage,
        true,
        mockWorkerStorage as WorkerStorage,
        true
      );

      const result = await wrapper.setItem('test-key', { ok: true });

      expect(result).toEqual({
        error: expect.any(Error),
        message: 'Set error',
        success: false,
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error setting item in storage:',
        expect.any(Error)
      );
    });
  });

  describe('removeItem with shouldLog=true', () => {
    it('should log errors when storage fails and shouldLog=true', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, true);

      const result = await wrapper.removeItem('test-key');

      expect(result.success).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error removing item from storage:',
        expect.any(Error)
      );
    });

    it('should not log errors when storage fails and shouldLog=false', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, false);

      const result = await wrapper.removeItem('test-key');

      expect(result.success).toBe(false);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should complete successfully when storage works regardless of shouldLog', async () => {
      await mockStorage.setItem('test-key', JSON.stringify('test-value'));

      const wrapperWithLog = createStorageWrapper(mockStorage, false, null, true);
      const wrapperWithoutLog = createStorageWrapper(mockStorage, false, null, false);

      const resultWithLog = await wrapperWithLog.removeItem('test-key');
      await mockStorage.setItem('test-key2', JSON.stringify('test-value2'));
      const resultWithoutLog = await wrapperWithoutLog.removeItem('test-key2');

      expect(resultWithLog.success).toBe(true);
      expect(resultWithoutLog.success).toBe(true);
      expect(await mockStorage.getItem('test-key')).toBeNull();
      expect(await mockStorage.getItem('test-key2')).toBeNull();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('shouldLog boolean behavior', () => {
    it('should handle shouldLog=true correctly in all error scenarios', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, true);

      await wrapper.getItem('test');
      const setResult = await wrapper.setItem('test', 'value');
      const removeResult = await wrapper.removeItem('test');

      // Should have logged all three errors
      expect(setResult.success).toBe(false);
      expect(removeResult.success).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenNthCalledWith(
        1,
        'Error getting item from storage:',
        expect.any(Error)
      );
      expect(mockLogger.error).toHaveBeenNthCalledWith(
        2,
        'Error setting item in storage:',
        expect.any(Error)
      );
      expect(mockLogger.error).toHaveBeenNthCalledWith(
        3,
        'Error removing item from storage:',
        expect.any(Error)
      );
    });

    it('should handle shouldLog=false correctly in all error scenarios', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, false);

      await wrapper.getItem('test');
      const setResult = await wrapper.setItem('test', 'value');
      const removeResult = await wrapper.removeItem('test');

      // Should not have logged any errors
      expect(setResult.success).toBe(false);
      expect(removeResult.success).toBe(false);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('logger string constants', () => {
    it('should use exact error messages for each operation', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, true);

      await wrapper.getItem('test');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error getting item from storage:',
        expect.any(Error)
      );

      mockLogger.error.mockClear();

      const setResult = await wrapper.setItem('test', 'value');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error setting item in storage:',
        expect.any(Error)
      );
      expect(setResult.success).toBe(false);

      mockLogger.error.mockClear();

      const removeResult = await wrapper.removeItem('test');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error removing item from storage:',
        expect.any(Error)
      );
      expect(removeResult.success).toBe(false);
    });

    it('should pass the actual error object to logger', async () => {
      const testError = new Error('Specific test error');
      const customErrorStorage: StorageAdapter = {
        clear: vi.fn().mockRejectedValue(testError),
        getAllKeys: vi.fn().mockRejectedValue(testError),
        getItem: vi.fn().mockRejectedValue(testError),
        removeItem: vi.fn().mockRejectedValue(testError),
        setItem: vi.fn().mockRejectedValue(testError),
      };

      const wrapper = createStorageWrapper(customErrorStorage, false, null, true);

      await wrapper.getItem('test');
      expect(mockLogger.error).toHaveBeenCalledWith('Error getting item from storage:', testError);
    });
  });
});
