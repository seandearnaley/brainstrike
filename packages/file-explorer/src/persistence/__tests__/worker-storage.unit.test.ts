/**
 * Unit tests for WorkerStorage that don't depend on Worker timing.
 * These tests focus on:
 * - resolveWorkerStorageUrl error paths
 * - WorkerStorage initialization behavior
 * - Synchronous paths and fallback behavior
 * - Cleanup and destroy functionality
 */

import type { StorageAdapter } from '@brainstrike/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the logger
const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock localStorage
const mockLocalStorage = {
  clear: vi.fn(() => {
    mockLocalStorage.data.clear();
  }),
  data: new Map<string, string>(),
  getItem: vi.fn((key: string) => mockLocalStorage.data.get(key) ?? null),
  key: vi.fn(() => null),
  length: 0,
  removeItem: vi.fn((key: string) => {
    mockLocalStorage.data.delete(key);
  }),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage.data.set(key, value);
  }),
};

// Add localStorage to global
Object.defineProperty(global, 'localStorage', {
  configurable: true,
  value: mockLocalStorage,
  writable: true,
});

const mockStorageAdapter: StorageAdapter = {
  async clear(): Promise<void> {
    mockLocalStorage.clear();
  },
  async getAllKeys(): Promise<string[]> {
    return [...mockLocalStorage.data.keys()];
  },
  async getItem(key: string): Promise<string | null> {
    return mockLocalStorage.getItem(key);
  },
  async removeItem(key: string): Promise<void> {
    mockLocalStorage.removeItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    mockLocalStorage.setItem(key, value);
  },
};

describe('WorkerStorage - No Worker Environment', () => {
  let originalWorker: typeof Worker | undefined;
  const mockWorkerUrl = new URL('file:///mock-worker-storage.worker.mjs');

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.data.clear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();

    // Save original Worker
    originalWorker = (global as unknown as { Worker?: typeof Worker }).Worker;

    // Remove Worker from global to simulate non-Worker environment
    (global as unknown as { Worker: typeof Worker | undefined }).Worker = undefined;
  });

  afterEach(() => {
    // Restore original Worker
    if (originalWorker !== undefined) {
      (global as unknown as { Worker: typeof Worker }).Worker = originalWorker;
    }
    vi.restoreAllMocks();
  });

  it('should set isWorkerAvailable to false when Worker is undefined', async () => {
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    expect(storage.isWorkerAvailable).toBe(false);
  });

  it('should fallback to localStorage for getItem when worker is not available', async () => {
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    mockLocalStorage.data.set('test-key', JSON.stringify({ foo: 'bar' }));

    const result = await storage.getItem('test-key');

    expect(result).toEqual({ foo: 'bar' });
    expect(mockLocalStorage.getItem).toHaveBeenCalledWith('test-key');
  });

  it('should return null for non-existent keys in localStorage fallback', async () => {
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    const result = await storage.getItem('non-existent');

    expect(result).toBeNull();
  });

  it('should return raw value when JSON parse fails in localStorage fallback', async () => {
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    mockLocalStorage.data.set('raw-key', 'not-valid-json');

    const result = await storage.getItem('raw-key');

    expect(result).toBe('not-valid-json');
  });

  it('should fallback to localStorage for setItem when worker is not available', async () => {
    vi.useFakeTimers();
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    const setPromise = storage.setItem('test-key', { foo: 'bar' });

    // Advance past debounce timer
    await vi.advanceTimersByTimeAsync(200);

    await setPromise;

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'test-key',
      JSON.stringify({ foo: 'bar' })
    );
    vi.useRealTimers();
  });

  it('should store string values directly without double-serialization', async () => {
    vi.useFakeTimers();
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    const setPromise = storage.setItem('string-key', 'plain-string');

    await vi.advanceTimersByTimeAsync(200);
    await setPromise;

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('string-key', 'plain-string');
    vi.useRealTimers();
  });

  it('should fallback to localStorage for removeItem when worker is not available', async () => {
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    mockLocalStorage.data.set('remove-key', 'value');

    await storage.removeItem('remove-key');

    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('remove-key');
  });

  it('should not throw on destroy when worker is not available', async () => {
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    expect(() => storage.destroy()).not.toThrow();
    expect(storage.isWorkerAvailable).toBe(false);
  });
});

describe('WorkerStorage - Worker Initialization Errors', () => {
  const mockWorkerUrl = new URL('file:///mock-worker-storage.worker.mjs');

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.data.clear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should handle Worker constructor errors gracefully', async () => {
    vi.stubGlobal(
      'Worker',
      class MockWorkerThatThrows {
        constructor() {
          throw new Error('Worker initialization failed');
        }
      }
    );

    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    expect(storage.isWorkerAvailable).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to initialize Web Worker for state persistence:',
      expect.any(Error)
    );
  });
});

describe('WorkerStorage - Debouncing Behavior', () => {
  const mockWorkerUrl = new URL('file:///mock-worker-storage.worker.mjs');

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.data.clear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();

    // Ensure Worker is undefined for fallback testing
    (global as unknown as { Worker: typeof Worker | undefined }).Worker = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should debounce rapid setItem calls for the same key', async () => {
    vi.useFakeTimers();
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    // Fire multiple rapid setItem calls
    void storage.setItem('debounce-key', 'value1');
    void storage.setItem('debounce-key', 'value2');
    const promise = storage.setItem('debounce-key', 'value3');

    // Advance past debounce timer
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    // Should only have stored the last value (debounce clears earlier timers)
    expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('debounce-key', 'value3');
    vi.useRealTimers();
  });

  it('should handle independent keys without debounce interference', async () => {
    vi.useFakeTimers();
    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    const promise1 = storage.setItem('key1', 'value1');
    const promise2 = storage.setItem('key2', 'value2');

    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([promise1, promise2]);

    expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(2);
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('key1', 'value1');
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('key2', 'value2');
    vi.useRealTimers();
  });
});

describe('WorkerStorage - Destroy Cleanup', () => {
  const mockWorkerUrl = new URL('file:///mock-worker-storage.worker.mjs');

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.data.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('flushes the latest debounced value on destroy', async () => {
    vi.useFakeTimers();

    // Ensure Worker is undefined
    (global as unknown as { Worker: typeof Worker | undefined }).Worker = undefined;

    const { WorkerStorage } = await import('../worker-storage');
    const storage = new WorkerStorage(mockWorkerUrl, mockStorageAdapter);

    // Start a setItem that will be debounced
    void storage.setItem('pending-key', 'pending-value');

    // Destroy before debounce completes
    storage.destroy();

    // Advance time to ensure debounce timer would have fired
    await vi.advanceTimersByTimeAsync(200);

    expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('pending-key', 'pending-value');
    vi.useRealTimers();
  });
});
