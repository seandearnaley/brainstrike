import type { StorageAdapter } from '@brainstrike/storage';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageWrapper } from '../storage-wrapper';

// Mock the logger
const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('StorageWrapper', () => {
  let mockStorage: StorageAdapter;
  let errorStorage: StorageAdapter;

  beforeEach(() => {
    mockStorage = new MemoryStorageAdapter();

    // Create a storage adapter that always throws errors
    errorStorage = {
      getItem: vi.fn().mockRejectedValue(new Error('Get error')),
      setItem: vi.fn().mockRejectedValue(new Error('Set error')),
      removeItem: vi.fn().mockRejectedValue(new Error('Remove error')),
      clear: vi.fn().mockRejectedValue(new Error('Clear error')),
      getAllKeys: vi.fn().mockRejectedValue(new Error('GetAllKeys error')),
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
  });

  describe('setItem with shouldLog=true', () => {
    it('should log errors when storage fails and shouldLog=true', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, true);

      await wrapper.setItem('test-key', 'test-value');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error setting item in storage:',
        expect.any(Error)
      );
    });

    it('should not log errors when storage fails and shouldLog=false', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, false);

      await wrapper.setItem('test-key', 'test-value');

      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should complete successfully when storage works regardless of shouldLog', async () => {
      const wrapperWithLog = createStorageWrapper(mockStorage, false, null, true);
      const wrapperWithoutLog = createStorageWrapper(mockStorage, false, null, false);

      await wrapperWithLog.setItem('key1', 'value1');
      await wrapperWithoutLog.setItem('key2', 'value2');

      // Storage wrapper JSON stringifies values when storing
      expect(await mockStorage.getItem('key1')).toBe(JSON.stringify('value1'));
      expect(await mockStorage.getItem('key2')).toBe(JSON.stringify('value2'));
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('removeItem with shouldLog=true', () => {
    it('should log errors when storage fails and shouldLog=true', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, true);

      await wrapper.removeItem('test-key');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error removing item from storage:',
        expect.any(Error)
      );
    });

    it('should not log errors when storage fails and shouldLog=false', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, false);

      await wrapper.removeItem('test-key');

      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should complete successfully when storage works regardless of shouldLog', async () => {
      await mockStorage.setItem('test-key', JSON.stringify('test-value'));

      const wrapperWithLog = createStorageWrapper(mockStorage, false, null, true);
      const wrapperWithoutLog = createStorageWrapper(mockStorage, false, null, false);

      await wrapperWithLog.removeItem('test-key');
      await mockStorage.setItem('test-key2', JSON.stringify('test-value2'));
      await wrapperWithoutLog.removeItem('test-key2');

      expect(await mockStorage.getItem('test-key')).toBeNull();
      expect(await mockStorage.getItem('test-key2')).toBeNull();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('shouldLog boolean behavior', () => {
    it('should handle shouldLog=true correctly in all error scenarios', async () => {
      const wrapper = createStorageWrapper(errorStorage, false, null, true);

      await wrapper.getItem('test');
      await wrapper.setItem('test', 'value');
      await wrapper.removeItem('test');

      // Should have logged all three errors
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
      await wrapper.setItem('test', 'value');
      await wrapper.removeItem('test');

      // Should not have logged any errors
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

      await wrapper.setItem('test', 'value');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error setting item in storage:',
        expect.any(Error)
      );

      mockLogger.error.mockClear();

      await wrapper.removeItem('test');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error removing item from storage:',
        expect.any(Error)
      );
    });

    it('should pass the actual error object to logger', async () => {
      const testError = new Error('Specific test error');
      const customErrorStorage: StorageAdapter = {
        getItem: vi.fn().mockRejectedValue(testError),
        setItem: vi.fn().mockRejectedValue(testError),
        removeItem: vi.fn().mockRejectedValue(testError),
        clear: vi.fn().mockRejectedValue(testError),
        getAllKeys: vi.fn().mockRejectedValue(testError),
      };

      const wrapper = createStorageWrapper(customErrorStorage, false, null, true);

      await wrapper.getItem('test');
      expect(mockLogger.error).toHaveBeenCalledWith('Error getting item from storage:', testError);
    });
  });
});
