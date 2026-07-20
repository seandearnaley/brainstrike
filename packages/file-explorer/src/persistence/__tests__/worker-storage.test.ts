/**
 * Worker Storage Tests
 */

import type { StorageAdapter } from '@brainstrike/storage';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Mock the logger using vi.hoisted
const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock Worker global
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  // Use a mock function for postMessage to track calls
  postMessage = vi.fn();
  terminate = vi.fn();

  addEventListener(type: string, handler: (event: Event) => void) {
    if (type === 'message') {
      this.onmessage = handler as (event: MessageEvent) => void;
    } else if (type === 'error') {
      this.onerror = handler as (event: ErrorEvent) => void;
    }
  }

  removeEventListener() {}

  // Helper to simulate receiving a message from the worker (worker -> main)
  emitMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
  }

  // Helper to simulate an error (worker -> main)
  emitError(error: Error | string) {
    const message = error instanceof Error ? error.message : String(error);
    const errorEvent = new ErrorEvent('error', {
      error: error instanceof Error ? error : new Error(message),
      message,
    });

    if (this.onerror) {
      this.onerror(errorEvent);
    }
  }
}

// Mock localStorage
const mockLocalStorage = {
  clear: vi.fn(() => {
    mockLocalStorage.data.clear();
  }),
  data: new Map<string, string>(),
  getItem: vi.fn((key: string) => mockLocalStorage.data.get(key) || null),
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
(global as unknown as { localStorage: typeof mockLocalStorage }).localStorage = mockLocalStorage;

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

// Mock ErrorEvent
class MockErrorEvent extends Event {
  constructor(
    type: string,
    public init?: { message?: string; error?: Error }
  ) {
    super(type);
  }
  get message() {
    return this.init?.message || '';
  }
  get colno() {
    return 0;
  }
  get error() {
    return this.init?.error || null;
  }
  get filename() {
    return '';
  }
  get lineno() {
    return 0;
  }
}
(global as unknown as { ErrorEvent: typeof MockErrorEvent }).ErrorEvent = MockErrorEvent;

describe('resolveWorkerStorageUrl', () => {
  it('returns the emitted ESM worker artifact URL', async () => {
    const { resolveWorkerStorageUrl } = await import('../worker-storage');
    const url = resolveWorkerStorageUrl();

    expect(url).toBeInstanceOf(URL);
    expect(url.href).toMatch(/worker-storage\.worker\.mjs$/);
  });

  it('uses the bundler-analyzable URL relative to the current ESM module', async () => {
    const { resolveWorkerStorageUrl } = await import('../worker-storage');
    const url = resolveWorkerStorageUrl();

    expect(url.href).toContain('/src/persistence/worker-storage.worker.mjs');
  });
});

// Mock worker URL for testing - WorkerStorage now requires a URL parameter
const mockWorkerUrl = new URL('file:///mock-worker-storage.worker.mjs');

const WORKER_TIMEOUT = 5000;
// Buffer to ensure we're past the timeout
const TIMEOUT_BUFFER = 1000;

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorkerStorage', () => {
  let originalWorker: typeof Worker | undefined;
  let mockWorker: MockWorker;
  let MockWorkerConstructorSpy: Mock<(url: string | URL, ...args: unknown[]) => void>;
  let WorkerStorageClass: typeof import('../worker-storage').WorkerStorage;

  beforeEach(async () => {
    // Reset modules to ensure Worker global is picked up correctly
    vi.resetModules();
    vi.clearAllMocks();
    mockLocalStorage.data.clear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();

    // Save original Worker if it exists
    originalWorker = (global as unknown as { Worker?: typeof Worker }).Worker;

    // Create mock worker instance
    mockWorker = new MockWorker();

    // Create a spy to track constructor calls
    MockWorkerConstructorSpy = vi.fn();

    // Define a proper class for Worker to avoid Vitest warnings
    class MockWorkerImplementation {
      constructor(url: string | URL, ...args: unknown[]) {
        MockWorkerConstructorSpy(url, ...args);
        // Emulate behavior of feature detection vs normal worker
        if (url.toString().startsWith('data:')) {
          // biome-ignore lint/correctness/noConstructorReturn: Mocking Worker constructor to return a specific instance
          return { addEventListener: vi.fn(), terminate: vi.fn() } as unknown as Worker;
        }
        // biome-ignore lint/correctness/noConstructorReturn: Mocking Worker constructor to return a specific instance
        return mockWorker;
      }
    }

    // Set globally on both global and globalThis to be safe.
    // vi.stubGlobal should be sufficient in JSDOM, but explicit assignment to global/globalThis
    // ensures the mock is available even if the environment setup varies or code accesses 'global' directly.
    vi.stubGlobal('Worker', MockWorkerImplementation);
    (global as any).Worker = MockWorkerImplementation;
    (globalThis as any).Worker = MockWorkerImplementation;

    // Dynamically import the module AFTER stubbing globals
    const mod = await import('../worker-storage');
    WorkerStorageClass = mod.WorkerStorage;
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore original Worker
    if (originalWorker === undefined) {
      vi.unstubAllGlobals();
      (global as any).Worker = undefined;
      (globalThis as any).Worker = undefined;
    } else {
      vi.stubGlobal('Worker', originalWorker);
      (global as any).Worker = originalWorker;
      (globalThis as any).Worker = originalWorker;
    }
  });

  describe('initialization', () => {
    it('should initialize worker in browser environment', () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // It's called once for the real worker.
      expect(MockWorkerConstructorSpy).toHaveBeenCalledTimes(1);

      // Check the call for the actual worker URL
      const callArgs = MockWorkerConstructorSpy.mock.calls[0]; // First (and only) call
      expect(callArgs).toBeDefined();
      expect(String(callArgs?.[0])).toMatch(/worker-storage\.worker\.mjs$/);
      expect(callArgs?.[1]).toEqual({ type: 'module' });

      expect(storage.isWorkerAvailable).toBe(true);
    });

    it('should not initialize worker when Worker is undefined', async () => {
      vi.resetModules();
      vi.stubGlobal('Worker', undefined);
      (global as any).Worker = undefined;

      // Re-import to pick up undefined Worker
      const mod = await import('../worker-storage');
      const Storage = mod.WorkerStorage;

      const storage = new Storage(mockWorkerUrl, mockStorageAdapter);

      expect(storage.isWorkerAvailable).toBe(false);
    });

    it('should handle worker initialization errors gracefully', async () => {
      vi.resetModules();

      const ErrorWorker = class {
        constructor() {
          throw new Error('Worker initialization failed');
        }
      };

      vi.stubGlobal('Worker', ErrorWorker);
      (global as any).Worker = ErrorWorker;

      // Re-import
      const mod = await import('../worker-storage');
      const Storage = mod.WorkerStorage;

      const storage = new Storage(mockWorkerUrl, mockStorageAdapter);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to initialize Web Worker for state persistence:',
        expect.any(Error)
      );
      expect(storage.isWorkerAvailable).toBe(false);
    });
  });

  describe('getItem', () => {
    it('should send load message to worker and return result', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const testData = { foo: 'bar' };

      // Setup mock response
      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        // Asynchronously respond to simulate worker behavior
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            result: JSON.stringify(testData),
            type: 'success',
          });
        });
      });

      const result = await storage.getItem('test-key');

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: expect.any(String),
        key: 'test-key',
        type: 'load',
      });
      expect(result).toBe(JSON.stringify(testData));
    });

    it('should fallback to localStorage when worker fails', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const testData = { test: 'data' };
      mockLocalStorage.data.set('fallback-key', JSON.stringify(testData));

      // Setup mock error response
      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            error: 'Worker error',
            id: message.id,
            type: 'error',
          });
        });
      });

      const result = await storage.getItem('fallback-key');

      expect(result).toEqual(testData);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('fallback-key');
      expect(mockLogger.error).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));
    });

    it('should return null when key does not exist', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            result: null,
            type: 'success',
          });
        });
      });

      const result = await storage.getItem('non-existent-key');

      expect(result).toBeNull();
    });

    it('should handle worker not available', async () => {
      vi.resetModules();
      vi.stubGlobal('Worker', undefined);
      const mod = await import('../worker-storage');
      const Storage = mod.WorkerStorage;

      const storage = new Storage(mockWorkerUrl, mockStorageAdapter);

      const result = await storage.getItem('test-key');

      expect(result).toBeNull();
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('test-key');
    });
  });

  describe('setItem', () => {
    it('should send save message to worker', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const testData = { foo: 'bar' };

      // Setup mock to respond when called
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          id: message.id,
          result: true,
          type: 'success',
        });
      });

      const promise = storage.setItem('test-key', JSON.stringify(testData));

      // Fast-forward debounce
      await vi.advanceTimersByTimeAsync(100);

      await promise;

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: expect.any(String),
        key: 'test-key',
        type: 'save',
        value: JSON.stringify(testData),
      });
    });

    it('should fallback to localStorage when worker fails', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const testValue = 'test-value';

      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          error: 'Worker error',
          id: message.id,
          type: 'error',
        });
      });

      const promise = storage.setItem('fallback-key', testValue);

      // Fast-forward debounce
      await vi.advanceTimersByTimeAsync(100);

      await promise;

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('fallback-key', testValue);
      expect(mockLogger.error).toHaveBeenCalledWith('Worker setItem failed:', expect.any(Error));
    });

    it('should handle worker not available', async () => {
      vi.resetModules();
      vi.stubGlobal('Worker', undefined);
      const mod = await import('../worker-storage');
      const Storage = mod.WorkerStorage;

      const storage = new Storage(mockWorkerUrl, mockStorageAdapter);
      const testValue = 'test-value';

      await storage.setItem('test-key', testValue);

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('test-key', testValue);
    });
  });

  describe('removeItem', () => {
    it('should send remove message to worker', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            result: true,
            type: 'success',
          });
        });
      });

      await storage.removeItem('test-key');

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: expect.any(String),
        key: 'test-key',
        type: 'remove',
      });
    });

    it('should fallback to localStorage when worker fails', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            error: 'Worker error',
            id: message.id,
            type: 'error',
          });
        });
      });

      await storage.removeItem('fallback-key');

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('fallback-key');
      expect(mockLogger.error).toHaveBeenCalledWith('Worker removeItem failed:', expect.any(Error));
    });

    it('should handle worker not available', async () => {
      vi.resetModules();
      vi.stubGlobal('Worker', undefined);
      const mod = await import('../worker-storage');
      const Storage = mod.WorkerStorage;

      const storage = new Storage(mockWorkerUrl, mockStorageAdapter);

      await storage.removeItem('test-key');

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('test-key');
    });
  });

  describe('error handling', () => {
    it('should handle worker error events', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Create a promise that will fall back to localStorage
      // We don't resolve the postMessage here, we simulate a crash
      const promise = storage.getItem('test');

      // Trigger worker error before any response
      mockWorker.emitError(new Error('Worker crashed'));

      // Should fall back to localStorage and return null for non-existent key
      const result = await promise;
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Worker error occurred:', expect.anything());
    });

    it('flushes pending debounced setItem calls when worker errors', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      const promise = storage.setItem('debounced-key', 'value');

      mockWorker.emitError(new Error('Worker crashed'));

      await expect(promise).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(200);
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('debounced-key', 'value');
    });

    it('should mark worker unavailable after error for fast fallback writes', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitError(new Error('Worker crashed'));
      expect(storage.isWorkerAvailable).toBe(false);

      const promise = storage.setItem('after-error', 'value');

      // Debounce window; fallback should happen immediately after this, not after 5s timeout.
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBeUndefined();
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('after-error', 'value');
    });

    it('should handle unknown response IDs gracefully', () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Send response with unknown ID
      mockWorker.emitMessage({
        id: 'unknown-id',
        result: 'data',
        type: 'success',
      });

      // Should silently ignore unknown response IDs (no console warning)
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should timeout long-running requests', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Don't mock response for this one to simulate timeout
      const promise = storage.getItem('test');

      // Fast-forward past timeout (5 seconds + buffer)
      await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT + TIMEOUT_BUFFER);

      // Should fall back to localStorage after timeout
      const result = await promise;
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));
    });

    it('should handle missing error message in worker response', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            type: 'error',
            // No error message
          });
        });
      });

      const result = await storage.getItem('test');

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on destroy', () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Add some pending requests
      void storage.getItem('test1');
      void storage.getItem('test2');

      storage.destroy();

      expect(mockWorker.terminate).toHaveBeenCalled();
      expect(storage.isWorkerAvailable).toBe(false);
    });

    it('should handle destroy when worker is not available', async () => {
      vi.resetModules();
      vi.stubGlobal('Worker', undefined);
      const mod = await import('../worker-storage');
      const Storage = mod.WorkerStorage;

      const storage = new Storage(mockWorkerUrl, mockStorageAdapter);

      // Should not throw
      expect(() => storage.destroy()).not.toThrow();
    });

    it('flushes the latest pending value when the worker errors', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      void storage.setItem('pending-key', 'pending-value');

      mockWorker.emitError(new Error('worker crashed'));

      await vi.advanceTimersByTimeAsync(200);

      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('pending-key', 'pending-value');
      expect(mockWorker.terminate).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle multiple concurrent requests', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Auto-respond to all messages
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            result: `result-${message.id}`,
            type: 'success',
          });
        });
      });

      const promises = [storage.getItem('key1'), storage.getItem('key2'), storage.getItem('key3')];
      const results = await Promise.all(promises);

      expect(mockWorker.postMessage).toHaveBeenCalledTimes(3);
      expect(results).toHaveLength(3);
      // We can't guarantee IDs are sequential 1, 2, 3 but they should be distinct
      // But based on the code, they should be.
    });

    it('should generate unique message IDs', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const sentIds = new Set<string>();

      mockWorker.postMessage.mockImplementation((data: { id: string }) => {
        sentIds.add(data.id);
        mockWorker.emitMessage({
          id: data.id,
          result: true,
          type: 'success',
        });
      });

      const p1 = storage.setItem('key1', 'value1');
      const p2 = storage.setItem('key2', 'value2');
      const p3 = storage.setItem('key3', 'value3');

      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([p1, p2, p3]);

      expect(sentIds.size).toBe(3);
      expect(mockWorker.postMessage).toHaveBeenCalledTimes(3);
    });

    it('should reject when worker is not available', async () => {
      vi.resetModules();
      vi.stubGlobal('Worker', undefined);
      const mod = await import('../worker-storage');
      const Storage = mod.WorkerStorage;

      const storage = new Storage(mockWorkerUrl, mockStorageAdapter);

      // Since the worker is not available, it should fall back to localStorage
      // and return null for non-existent keys
      const result = await storage.getItem('test');
      expect(result).toBeNull();
    });
  });

  describe('storage_request', () => {
    it('handles setItem requests', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'setItem',
        opId: 1,
        type: 'storage_request',
        value: 'bar',
      });

      await flushAsyncWork();
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('foo', 'bar');
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        operation: 'setItem',
        success: true,
        type: 'storage_response',
      });
    });

    it('ignores older opId values', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'setItem',
        opId: 2,
        type: 'storage_request',
        value: 'bar',
      });

      mockWorker.emitMessage({
        id: '2',
        key: 'foo',
        operation: 'setItem',
        opId: 1,
        type: 'storage_request',
        value: 'baz',
      });

      await flushAsyncWork();
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockWorker.postMessage).toHaveBeenCalledTimes(2);
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        operation: 'setItem',
        success: true,
        type: 'storage_response',
      });
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '2',
        operation: 'setItem',
        success: true,
        type: 'storage_response',
      });
    });

    it('handles getItem requests', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      mockLocalStorage.data.set('foo', 'bar');

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'getItem',
        type: 'storage_request',
      });

      await flushAsyncWork();
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        operation: 'getItem',
        rawValue: 'bar',
        type: 'storage_response',
      });
    });

    it('handles removeItem requests', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      mockLocalStorage.data.set('foo', 'bar');

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'removeItem',
        type: 'storage_request',
      });

      await flushAsyncWork();
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('foo');
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        operation: 'removeItem',
        success: true,
        type: 'storage_response',
      });
    });

    it('handles setItem with undefined value', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'setItem',
        opId: 1,
        type: 'storage_request',
        value: undefined,
      });

      await flushAsyncWork();
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        error: 'Cannot store undefined value',
        id: '1',
        operation: 'setItem',
        success: false,
        type: 'storage_response',
      });
    });

    it('handles setItem without opId', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'setItem',
        type: 'storage_request',
        value: 'bar',
        // No opId
      });

      await flushAsyncWork();
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('foo', 'bar');
    });

    it('handles unknown operation type by doing nothing', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'unknown' as 'setItem',
        type: 'storage_request',
      });

      await flushAsyncWork();
      // Should not call any storage methods
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
      expect(mockLocalStorage.getItem).not.toHaveBeenCalled();
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();
    });

    it('returns explicit storage_response errors when adapter operations fail', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      mockLocalStorage.getItem.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      mockLocalStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('fail');
      });

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'setItem',
        opId: 1,
        type: 'storage_request',
        value: 'bar',
      });

      mockWorker.emitMessage({
        id: '2',
        key: 'foo',
        operation: 'getItem',
        type: 'storage_request',
      });

      mockWorker.emitMessage({
        id: '3',
        key: 'foo',
        operation: 'removeItem',
        type: 'storage_request',
      });

      await flushAsyncWork();
      expect(mockWorker.postMessage).toHaveBeenNthCalledWith(1, {
        error: 'fail',
        id: '1',
        operation: 'setItem',
        success: false,
        type: 'storage_response',
      });
      expect(mockWorker.postMessage).toHaveBeenNthCalledWith(2, {
        error: 'fail',
        id: '2',
        operation: 'getItem',
        success: false,
        type: 'storage_response',
      });
      expect(mockWorker.postMessage).toHaveBeenNthCalledWith(3, {
        error: 'fail',
        id: '3',
        operation: 'removeItem',
        success: false,
        type: 'storage_response',
      });
    });

    it('sends error response when non-Error is thrown from adapter', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockLocalStorage.setItem.mockImplementationOnce(() => {
        // biome-ignore lint/style/useThrowOnlyError: intentionally throwing non-Error to test handler
        throw 'string-error';
      });

      mockWorker.emitMessage({
        id: '1',
        key: 'foo',
        operation: 'setItem',
        opId: 1,
        type: 'storage_request',
        value: 'bar',
      });

      await flushAsyncWork();
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        error: 'string-error',
        id: '1',
        operation: 'setItem',
        success: false,
        type: 'storage_response',
      });
    });
  });

  describe('flushPendingWrites', () => {
    it('should flush pending save values through the public API', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Start a setItem that is pending (not yet debounced)
      void storage.setItem('flush-key', 'flush-value');

      // Call the public flushPendingWrites
      storage.flushPendingWrites();

      // The value should be flushed to localStorage
      await vi.advanceTimersByTimeAsync(200);
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('flush-key', 'flush-value');
    });

    it('should handle flush with object values (JSON.stringify path)', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      void storage.setItem('obj-key', { nested: true });

      storage.flushPendingWrites();

      await vi.advanceTimersByTimeAsync(200);
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'obj-key',
        JSON.stringify({ nested: true })
      );
    });

    it('should handle flush with string values directly (no JSON.stringify)', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      void storage.setItem('str-key', 'plain-string');

      storage.flushPendingWrites();

      await vi.advanceTimersByTimeAsync(200);
      // flushPendingWrites uses `typeof value === 'string' ? value : JSON.stringify(value)`
      // so a string value should be passed through directly
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('str-key', 'plain-string');
    });
  });

  describe('removeItem with pending debounce', () => {
    it('should resolve and clear pending debounced setItem when removeItem is called', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Setup mock response for the removeItem worker message
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            result: true,
            type: 'success',
          });
        });
      });

      // Start a debounced setItem
      const setPromise = storage.setItem('remove-me', 'value');

      // Now call removeItem for the same key - should resolve the pending setItem
      await storage.removeItem('remove-me');

      // The setItem promise should resolve (not hang or reject)
      await vi.advanceTimersByTimeAsync(200);
      await expect(setPromise).resolves.toBeUndefined();
    });
  });

  describe('setItem fallback paths', () => {
    it('should stringify non-string values in setItem fallback path', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Worker fails
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          error: 'Worker error',
          id: message.id,
          type: 'error',
        });
      });

      const promise = storage.setItem('obj-key', { data: 'test' });

      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'obj-key',
        JSON.stringify({ data: 'test' })
      );
    });

    it('should pass string values through without double-stringify in fallback', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Worker fails
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          error: 'Worker error',
          id: message.id,
          type: 'error',
        });
      });

      const promise = storage.setItem('str-key', 'already-a-string');

      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('str-key', 'already-a-string');
    });
  });

  describe('debounce superseding', () => {
    it('should resolve previous caller when superseded by a new setItem', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Worker responds successfully
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          id: message.id,
          result: true,
          type: 'success',
        });
      });

      // First call gets superseded
      const promise1 = storage.setItem('key', 'value1');
      // Second call supersedes the first
      const promise2 = storage.setItem('key', 'value2');

      await vi.advanceTimersByTimeAsync(100);

      // Both promises should resolve
      await expect(promise1).resolves.toBeUndefined();
      await expect(promise2).resolves.toBeUndefined();

      // Only the second value should be sent to worker (debounced)
      expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
    });
  });
});
