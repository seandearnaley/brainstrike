/**
 * Worker Storage Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerStorage } from '../worker-storage';

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

describe('WorkerStorage', () => {
  let originalWorker: typeof Worker | undefined;
  let mockWorker: MockWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.data.clear();

    // Save original Worker if it exists
    originalWorker = (global as unknown as { Worker?: typeof Worker }).Worker;

    // Create mock worker instance
    mockWorker = new MockWorker();

    // Mock Worker constructor
    vi.stubGlobal(
      'Worker',
      vi.fn(() => mockWorker)
    );
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

      expect(Worker).toHaveBeenCalled();
      expect(Worker).toHaveBeenCalledWith(expect.any(URL), { type: 'module' });
      // Verify the URL ends with the correct worker file
      const workerMock = Worker as unknown as { mock: { calls: unknown[][] } };
      const callArgs = workerMock.mock.calls[0];
      expect(callArgs).toBeDefined();
      expect(String(callArgs?.[0])).toMatch(/worker-storage\.worker\.js$/);
      expect(storage.isWorkerAvailable).toBe(true);
    });

    it('should not initialize worker when Worker is undefined', () => {
      vi.stubGlobal('Worker', undefined);

      const storage = new WorkerStorage();

      expect(storage.isWorkerAvailable).toBe(false);
    });

    it('should not initialize worker in Electron environment', () => {
      vi.stubGlobal('window', {
        process: { type: 'renderer' },
      });

      const storage = new WorkerStorage();

      expect(Worker).not.toHaveBeenCalled();
      expect(storage.isWorkerAvailable).toBe(false);

      vi.unstubAllGlobals();
    });

    it('should handle worker initialization errors gracefully', () => {
      vi.stubGlobal(
        'Worker',
        vi.fn(() => {
          throw new Error('Worker initialization failed');
        })
      );

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const storage = new WorkerStorage();

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to initialize Web Worker for state persistence:',
        expect.any(Error)
      );
      expect(storage.isWorkerAvailable).toBe(false);

      consoleSpy.mockRestore();
    });
  });

  describe('getItem', () => {
    it('should send load message to worker and return result', async () => {
      const storage = new WorkerStorage();
      const testData = { foo: 'bar' };

      // Simulate worker response
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

      const result = await storage.getItem('test-key');

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

      // Simulate worker error response
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

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await storage.getItem('fallback-key');

      expect(result).toEqual(testData);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('fallback-key');
      expect(consoleSpy).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));

      consoleSpy.mockRestore();
    });

    it('should return null when key does not exist', async () => {
      const storage = new WorkerStorage();

      // Simulate worker response with null result
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

      const result = await storage.getItem('non-existent-key');

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

      // Simulate worker response
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

      await storage.setItem('test-key', JSON.stringify(testData));

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

      // Simulate worker error response
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

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await storage.setItem('fallback-key', testValue);

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('fallback-key', testValue);
      expect(consoleSpy).toHaveBeenCalledWith('Worker setItem failed:', expect.any(Error));

      consoleSpy.mockRestore();
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

      // Simulate worker response
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

      await storage.removeItem('test-key');

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        type: 'remove',
        key: 'test-key',
      });
    });

    it('should fallback to localStorage when worker fails', async () => {
      const storage = new WorkerStorage();

      // Simulate worker error response
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

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await storage.removeItem('fallback-key');

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('fallback-key');
      expect(consoleSpy).toHaveBeenCalledWith('Worker removeItem failed:', expect.any(Error));

      consoleSpy.mockRestore();
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
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
      expect(consoleSpy).toHaveBeenCalledWith('Worker error:', expect.any(MockErrorEvent));

      consoleSpy.mockRestore();
    });

    it('should handle unknown response IDs gracefully', () => {
      new WorkerStorage();
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

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

      expect(consoleSpy).toHaveBeenCalledWith(
        'Received worker response for unknown request:',
        'unknown-id'
      );

      consoleSpy.mockRestore();
    });

    it('should timeout long-running requests', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorage();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const promise = storage.getItem('test');

      // Fast-forward past timeout (30 seconds)
      vi.advanceTimersByTime(31000);

      // Should fall back to localStorage after timeout
      const result = await promise;
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));

      consoleSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should handle missing error message in worker response', async () => {
      const storage = new WorkerStorage();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const promise = storage.getItem('test');

      // Immediately trigger error response without message
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
      expect(consoleSpy).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));

      consoleSpy.mockRestore();
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on destroy', () => {
      const storage = new WorkerStorage();

      // Add some pending requests
      storage.getItem('test1');
      storage.getItem('test2');

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
        Promise.resolve().then(() => {
          if (mockWorker.onmessage) {
            mockWorker.onmessage(
              new MessageEvent('message', {
                data: {
                  id: id,
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
        Promise.resolve().then(() => {
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
});
