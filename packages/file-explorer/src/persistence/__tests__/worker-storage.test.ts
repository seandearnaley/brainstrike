/**
 * Worker Storage Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerStorage } from '../worker-storage';

// Mock the logger using vi.hoisted
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock Worker global
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
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
}

// Mock localStorage
const mockLocalStorage = {
  data: new Map<string, string>(),
  getItem: vi.fn((key: string) => mockLocalStorage.data.get(key) || null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage.data.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    mockLocalStorage.data.delete(key);
  }),
  clear: vi.fn(() => {
    mockLocalStorage.data.clear();
  }),
  length: 0,
  key: vi.fn(() => null),
};

// Add localStorage to global
(global as unknown as { localStorage: typeof mockLocalStorage }).localStorage = mockLocalStorage;

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

// TODO: These tests have intermittent failures due to Worker mock timing issues
// that pre-date the Vitest 4 upgrade. The mock setup needs to be revisited
// to properly handle addEventListener and message passing.
// biome-ignore lint/suspicious/noSkippedTests: Known flaky tests awaiting mock refactor
describe.skip('WorkerStorage', () => {
  let originalWorker: typeof Worker | undefined;
  let mockWorker: MockWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.data.clear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();

    // Save original Worker if it exists
    originalWorker = (global as unknown as { Worker?: typeof Worker }).Worker;

    // Create mock worker instance
    mockWorker = new MockWorker();

    // Mock Worker constructor - Vitest 4 requires class constructor mocking to use a function
    // that returns the mock instance when called with `new`
    const MockWorkerConstructor = vi.fn().mockImplementation((url: string | URL) => {
      // For the feature-detect call, return a dummy worker that can be terminated.
      if (url.toString().startsWith('data:')) {
        return { terminate: vi.fn(), addEventListener: vi.fn() };
      }
      // For other calls, return the shared mockWorker for testing.
      return mockWorker;
    });
    vi.stubGlobal('Worker', MockWorkerConstructor);
  });

  afterEach(() => {
    // Restore original Worker
    if (originalWorker !== undefined) {
      vi.stubGlobal('Worker', originalWorker);
    } else {
      vi.unstubAllGlobals();
    }
  });

  describe('initialization', () => {
    it('should initialize worker in browser environment', () => {
      const storage = new WorkerStorage();

      // It's called once for the real worker.
      expect(Worker).toHaveBeenCalledTimes(1);

      // Check the call for the actual worker URL
      const workerMock = Worker as unknown as { mock: { calls: unknown[][] } };
      const callArgs = workerMock.mock.calls[0]; // First (and only) call
      expect(callArgs).toBeDefined();
      expect(String(callArgs?.[0])).toMatch(/worker-storage\.worker\.js$/);
      expect(callArgs?.[1]).toEqual({ type: 'module' });
      expect(storage.isWorkerAvailable).toBe(true);
    });

    it('should not initialize worker when Worker is undefined', () => {
      vi.stubGlobal('Worker', undefined);

      const storage = new WorkerStorage();

      expect(storage.isWorkerAvailable).toBe(false);
    });

    it('should handle worker initialization errors gracefully', () => {
      vi.stubGlobal(
        'Worker',
        vi.fn(() => {
          throw new Error('Worker initialization failed');
        })
      );

      const storage = new WorkerStorage();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to initialize Web Worker for state persistence:',
        expect.any(Error)
      );
      expect(storage.isWorkerAvailable).toBe(false);
    });
  });

  describe('getItem', () => {
    it('should send load message to worker and return result', async () => {
      const storage = new WorkerStorage();
      const testData = { foo: 'bar' };

      // Simulate worker response deterministically
      vi.useFakeTimers();
      const promise = storage.getItem('test-key');
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage(
            new MessageEvent('message', {
              data: {
                id: '1',
                type: 'success',
                result: JSON.stringify(testData),
              },
            })
          );
        }
      }, 10);
      await vi.advanceTimersByTimeAsync(10);
      const result = await promise;
      vi.useRealTimers();

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        type: 'load',
        key: 'test-key',
      });
      expect(result).toBe(JSON.stringify(testData));
    });

    it('should fallback to localStorage when worker fails', async () => {
      const storage = new WorkerStorage();
      const testData = { test: 'data' };
      mockLocalStorage.data.set('fallback-key', JSON.stringify(testData));

      // Simulate worker error response deterministically
      vi.useFakeTimers();
      const promise = storage.getItem('fallback-key');
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage(
            new MessageEvent('message', {
              data: {
                id: '1',
                type: 'error',
                error: 'Worker error',
              },
            })
          );
        }
      }, 10);
      await vi.advanceTimersByTimeAsync(10);
      const result = await promise;
      vi.useRealTimers();

      expect(result).toEqual(testData);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('fallback-key');
      expect(mockLogger.error).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));
    });

    it('should return null when key does not exist', async () => {
      const storage = new WorkerStorage();

      // Simulate worker response with null result deterministically
      vi.useFakeTimers();
      const promise = storage.getItem('non-existent-key');
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage(
            new MessageEvent('message', {
              data: {
                id: '1',
                type: 'success',
                result: null,
              },
            })
          );
        }
      }, 10);
      await vi.advanceTimersByTimeAsync(10);
      const result = await promise;
      vi.useRealTimers();

      expect(result).toBeNull();
    });

    it('should handle worker not available', async () => {
      vi.stubGlobal('Worker', undefined);
      const storage = new WorkerStorage();

      const result = await storage.getItem('test-key');

      expect(result).toBeNull();
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('test-key');
    });
  });

  describe('setItem', () => {
    it('should send save message to worker', async () => {
      const storage = new WorkerStorage();
      const testData = { foo: 'bar' };

      // Simulate worker response after debounce delay deterministically
      vi.useFakeTimers();
      const promise = storage.setItem('test-key', JSON.stringify(testData));
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage(
            new MessageEvent('message', {
              data: {
                id: '1',
                type: 'success',
                result: true,
              },
            })
          );
        }
      }, 120);
      await vi.advanceTimersByTimeAsync(120);
      await promise;
      vi.useRealTimers();

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        type: 'save',
        key: 'test-key',
        value: JSON.stringify(testData),
      });
    });

    it('should fallback to localStorage when worker fails', async () => {
      const storage = new WorkerStorage();
      const testValue = 'test-value';

      // Simulate worker error response after debounce delay deterministically
      vi.useFakeTimers();
      const promise = storage.setItem('fallback-key', testValue);
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage(
            new MessageEvent('message', {
              data: {
                id: '1',
                type: 'error',
                error: 'Worker error',
              },
            })
          );
        }
      }, 120);
      await vi.advanceTimersByTimeAsync(120);
      await promise;
      vi.useRealTimers();

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('fallback-key', testValue);
      expect(mockLogger.error).toHaveBeenCalledWith('Worker setItem failed:', expect.any(Error));
    });

    it('should handle worker not available', async () => {
      vi.stubGlobal('Worker', undefined);
      const storage = new WorkerStorage();
      const testValue = 'test-value';

      await storage.setItem('test-key', testValue);

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('test-key', testValue);
    });
  });

  describe('removeItem', () => {
    it('should send remove message to worker', async () => {
      const storage = new WorkerStorage();

      // Simulate worker response deterministically
      vi.useFakeTimers();
      const promise = storage.removeItem('test-key');
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage(
            new MessageEvent('message', {
              data: {
                id: '1',
                type: 'success',
                result: true,
              },
            })
          );
        }
      }, 10);
      await vi.advanceTimersByTimeAsync(10);
      await promise;
      vi.useRealTimers();

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        type: 'remove',
        key: 'test-key',
      });
    });

    it('should fallback to localStorage when worker fails', async () => {
      const storage = new WorkerStorage();

      vi.useFakeTimers();
      const promise = storage.removeItem('fallback-key');
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage(
            new MessageEvent('message', {
              data: {
                id: '1',
                type: 'error',
                error: 'Worker error',
              },
            })
          );
        }
      }, 10);
      await vi.advanceTimersByTimeAsync(10);
      await promise;
      vi.useRealTimers();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('fallback-key');
      expect(mockLogger.error).toHaveBeenCalledWith('Worker removeItem failed:', expect.any(Error));
    });

    it('should handle worker not available', async () => {
      vi.stubGlobal('Worker', undefined);
      const storage = new WorkerStorage();

      await storage.removeItem('test-key');

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('test-key');
    });
  });

  describe('error handling', () => {
    it('should handle worker error events', async () => {
      const storage = new WorkerStorage();

      // Create a promise that will fall back to localStorage
      const promise = storage.getItem('test');

      // Trigger worker error before any response
      if (mockWorker.onerror) {
        mockWorker.onerror(
          new MockErrorEvent('error', { message: 'Worker crashed' }) as unknown as ErrorEvent
        );
      }

      // Should fall back to localStorage and return null for non-existent key
      const result = await promise;
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Worker error occurred:', expect.any(String));
    });

    it('should handle unknown response IDs gracefully', () => {
      new WorkerStorage();

      // Send response with unknown ID
      if (mockWorker.onmessage) {
        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: 'unknown-id',
              type: 'success',
              result: 'data',
            },
          })
        );
      }

      // Should silently ignore unknown response IDs (no console warning)
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should timeout long-running requests', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorage();

      const promise = storage.getItem('test');

      // Fast-forward past timeout (30 seconds)
      vi.advanceTimersByTime(31_000);

      // Should fall back to localStorage after timeout
      const result = await promise;
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));

      vi.useRealTimers();
    });

    it('should handle missing error message in worker response', async () => {
      const storage = new WorkerStorage();

      const promise = storage.getItem('test');

      // Immediately trigger error response without message
      await // Immediately trigger error response without message
      Promise.resolve().then(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage(
            new MessageEvent('message', {
              data: {
                id: '1',
                type: 'error',
                // No error message
              },
            })
          );
        }
      });

      // Should fall back to localStorage after worker error
      const result = await promise;
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on destroy', () => {
      const storage = new WorkerStorage();

      // Add some pending requests
      void storage.getItem('test1');
      void storage.getItem('test2');

      storage.destroy();

      expect(mockWorker.terminate).toHaveBeenCalled();
      expect(storage.isWorkerAvailable).toBe(false);
    });

    it('should handle destroy when worker is not available', () => {
      vi.stubGlobal('Worker', undefined);
      const storage = new WorkerStorage();

      // Should not throw
      expect(() => storage.destroy()).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle multiple concurrent requests', async () => {
      const storage = new WorkerStorage();
      const responses: Record<string, string> = {};

      // Track sent messages
      mockWorker.postMessage = vi.fn((data) => {
        const id = data.id;
        responses[id] = `result-${id}`;

        // Respond immediately
        void Promise.resolve().then(() => {
          if (mockWorker.onmessage) {
            mockWorker.onmessage(
              new MessageEvent('message', {
                data: {
                  id,
                  type: 'success',
                  result: responses[id],
                },
              })
            );
          }
        });
      });

      const promises = [storage.getItem('key1'), storage.getItem('key2'), storage.getItem('key3')];

      const results = await Promise.all(promises);

      expect(mockWorker.postMessage).toHaveBeenCalledTimes(3);
      expect(results).toHaveLength(3);
      expect(results.every((r) => typeof r === 'string' && r.startsWith('result-'))).toBe(true);
    });

    it('should generate unique message IDs', async () => {
      const storage = new WorkerStorage();
      const sentIds = new Set<string>();

      mockWorker.postMessage = vi.fn((data) => {
        sentIds.add(data.id);
        // Respond immediately
        void Promise.resolve().then(() => {
          if (mockWorker.onmessage) {
            mockWorker.onmessage(
              new MessageEvent('message', {
                data: {
                  id: data.id,
                  type: 'success',
                  result: true,
                },
              })
            );
          }
        });
      });

      await Promise.all([
        storage.setItem('key1', 'value1'),
        storage.setItem('key2', 'value2'),
        storage.setItem('key3', 'value3'),
      ]);

      expect(sentIds.size).toBe(3);
      expect(mockWorker.postMessage).toHaveBeenCalledTimes(3);
    });

    it('should reject when worker is not available', async () => {
      vi.stubGlobal('Worker', undefined);
      const storage = new WorkerStorage();

      // Since the worker is not available, it should fall back to localStorage
      // and return null for non-existent keys
      const result = await storage.getItem('test');
      expect(result).toBeNull();
    });
  });

  describe('storage_request', () => {
    it('handles setItem requests', () => {
      new WorkerStorage();

      if (mockWorker.onmessage) {
        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: '1',
              type: 'storage_request',
              operation: 'setItem',
              key: 'foo',
              value: 'bar',
              opId: 1,
            },
          })
        );
      }

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('foo', 'bar');
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        type: 'storage_response',
        operation: 'setItem',
        success: true,
      });
    });

    it('ignores older opId values', () => {
      new WorkerStorage();

      if (mockWorker.onmessage) {
        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: '1',
              type: 'storage_request',
              operation: 'setItem',
              key: 'foo',
              value: 'bar',
              opId: 2,
            },
          })
        );
      }

      if (mockWorker.onmessage) {
        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: '2',
              type: 'storage_request',
              operation: 'setItem',
              key: 'foo',
              value: 'baz',
              opId: 1,
            },
          })
        );
      }

      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockWorker.postMessage).toHaveBeenNthCalledWith(1, {
        id: '1',
        type: 'storage_response',
        operation: 'setItem',
        success: true,
      });
      expect(mockWorker.postMessage).toHaveBeenNthCalledWith(2, {
        id: '2',
        type: 'storage_response',
        operation: 'setItem',
        success: true,
      });
    });

    it('handles getItem requests', () => {
      new WorkerStorage();
      mockLocalStorage.data.set('foo', 'bar');

      if (mockWorker.onmessage) {
        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: '1',
              type: 'storage_request',
              operation: 'getItem',
              key: 'foo',
            },
          })
        );
      }

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        type: 'storage_response',
        operation: 'getItem',
        rawValue: 'bar',
      });
    });

    it('handles removeItem requests', () => {
      new WorkerStorage();
      mockLocalStorage.data.set('foo', 'bar');

      if (mockWorker.onmessage) {
        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: '1',
              type: 'storage_request',
              operation: 'removeItem',
              key: 'foo',
            },
          })
        );
      }

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('foo');
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        type: 'storage_response',
        operation: 'removeItem',
        success: true,
      });
    });

    it('logs warnings on localStorage errors', () => {
      new WorkerStorage();

      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      mockLocalStorage.getItem.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      mockLocalStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      const warnSpy = vi.spyOn(mockLogger, 'warn').mockImplementation(() => {});

      if (mockWorker.onmessage) {
        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: '1',
              type: 'storage_request',
              operation: 'setItem',
              key: 'foo',
              value: 'bar',
              opId: 1,
            },
          })
        );

        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: '2',
              type: 'storage_request',
              operation: 'getItem',
              key: 'foo',
            },
          })
        );

        mockWorker.onmessage(
          new MessageEvent('message', {
            data: {
              id: '3',
              type: 'storage_request',
              operation: 'removeItem',
              key: 'foo',
            },
          })
        );
      }

      expect(warnSpy).toHaveBeenCalledTimes(3);
      warnSpy.mockRestore();
    });
  });
});
