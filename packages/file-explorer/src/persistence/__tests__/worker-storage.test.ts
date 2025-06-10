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

// Mock URL.createObjectURL and URL.revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
global.URL.revokeObjectURL = vi.fn();

// Mock Blob
global.Blob = class MockBlob {
  constructor(
    public content: unknown[],
    public options?: { type?: string }
  ) {}
} as any;

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
};

// Add localStorage to global
(global as any).localStorage = mockLocalStorage;

// Mock ErrorEvent
class MockErrorEvent extends Event {
  constructor(
    type: string,
    public init?: { message?: string; error?: any }
  ) {
    super(type);
  }
  get message() {
    return this.init?.message || '';
  }
}
(global as any).ErrorEvent = MockErrorEvent;

describe('WorkerStorage', () => {
  let originalWorker: typeof Worker | undefined;
  let mockWorker: MockWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.data.clear();

    // Save original Worker if it exists
    originalWorker = (global as any).Worker;

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
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(storage.isWorkerAvailable).toBe(true);
    });

    it('should not initialize worker when Worker is undefined', () => {
      vi.stubGlobal('Worker', undefined as any);

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
      mockLocalStorage.data.set('fallback-key', 'fallback-value');

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

      expect(consoleSpy).toHaveBeenCalledWith('Worker getItem failed:', expect.any(Error));
      expect(result).toBe('fallback-value');

      consoleSpy.mockRestore();
    });

    it('should handle null results correctly', async () => {
      const storage = new WorkerStorage();

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

      const result = await storage.getItem('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('setItem', () => {
    it('should send save message to worker', async () => {
      const storage = new WorkerStorage();

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

      await storage.setItem('test-key', 'test-value');

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: '1',
        type: 'save',
        key: 'test-key',
        value: 'test-value',
      });
    });

    it('should fallback to localStorage when worker fails', async () => {
      const storage = new WorkerStorage();

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
      await storage.setItem('fallback-key', 'fallback-value');

      expect(consoleSpy).toHaveBeenCalledWith('Worker setItem failed:', expect.any(Error));
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('fallback-key', 'fallback-value');

      consoleSpy.mockRestore();
    });
  });

  describe('removeItem', () => {
    it('should send remove message to worker', async () => {
      const storage = new WorkerStorage();

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
      await storage.removeItem('test-key');

      expect(consoleSpy).toHaveBeenCalledWith('Worker removeItem failed:', expect.any(Error));
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('test-key');

      consoleSpy.mockRestore();
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
        mockWorker.onerror(new MockErrorEvent('error', { message: 'Worker crashed' }) as any);
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

      // Fast-forward past timeout (10 seconds)
      vi.advanceTimersByTime(11000);

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
      vi.stubGlobal('Worker', undefined as any);
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
      expect(results.every((r) => r?.startsWith('result-'))).toBe(true);
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
      vi.stubGlobal('Worker', undefined as any);
      const storage = new WorkerStorage();

      // Since the worker is not available, it should fall back to localStorage
      // and return null for non-existent keys
      const result = await storage.getItem('test');
      expect(result).toBeNull();
    });
  });
});
