/**
 * Additional coverage tests for WorkerStorage
 *
 * Targets uncovered paths not exercised by existing test files:
 * - flushPendingWrites() public method
 * - processSetItemRequest with undefined value
 * - removeItem cancelling a pending debounced setItem
 * - setItem double-failure path (worker fails, then adapter also fails)
 * - flushPendingSaveValues error path (serialization / adapter failures)
 * - clearTrackedPendingSave no-op when value has been superseded
 * - sendMessage edge cases (no key/value)
 * - handleWorkerError full cleanup with mixed pending state
 * - destroy idempotency (double-destroy)
 * - getItem fallback parse failure returns raw value
 * - concurrent setItem + removeItem interactions
 */

import type { StorageAdapter } from '@brainstrike/storage';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { readGlobalSlot, setGlobalSlot } from './global-slots';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/logging', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// ---------------------------------------------------------------------------
// Mock Worker
// ---------------------------------------------------------------------------
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

  emitMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
  }

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

// ---------------------------------------------------------------------------
// Mock localStorage / StorageAdapter
// ---------------------------------------------------------------------------
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
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

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

// Mock ErrorEvent for Node environments
class MockErrorEvent extends Event {
  constructor(
    type: string,
    public init?: { message?: string; error?: Error }
  ) {
    super(type);
  }
  get message() {
    return this.init?.message ?? '';
  }
  get colno() {
    return 0;
  }
  get error() {
    return this.init?.error ?? null;
  }
  get filename() {
    return '';
  }
  get lineno() {
    return 0;
  }
}
const originalErrorEvent = globalThis.ErrorEvent;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockWorkerUrl = new URL('file:///mock-worker-storage.worker.mjs');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('WorkerStorage – coverage boost', () => {
  let originalWorker: typeof Worker | undefined;
  let mockWorker: MockWorker;
  let MockWorkerConstructorSpy: Mock<(url: string | URL, ...args: unknown[]) => void>;
  let WorkerStorageClass: typeof import('../worker-storage').WorkerStorage;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockLocalStorage.data.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: mockLocalStorage,
      writable: true,
    });
    setGlobalSlot('ErrorEvent', MockErrorEvent);

    originalWorker = readGlobalSlot<typeof Worker>('Worker');
    mockWorker = new MockWorker();
    MockWorkerConstructorSpy = vi.fn();

    class MockWorkerImplementation {
      constructor(url: string | URL, ...args: unknown[]) {
        MockWorkerConstructorSpy(url, ...args);
        if (url.toString().startsWith('data:')) {
          // biome-ignore lint/correctness/noConstructorReturn: testing mock
          return { addEventListener: vi.fn(), terminate: vi.fn() } as unknown as Worker;
        }
        // biome-ignore lint/correctness/noConstructorReturn: testing mock
        return mockWorker;
      }
    }

    vi.stubGlobal('Worker', MockWorkerImplementation);

    const mod = await import('../worker-storage');
    WorkerStorageClass = mod.WorkerStorage;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalWorker === undefined) {
      vi.unstubAllGlobals();
    } else {
      vi.stubGlobal('Worker', originalWorker);
    }
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
    if (originalErrorEvent) {
      setGlobalSlot('ErrorEvent', originalErrorEvent as typeof MockErrorEvent);
    } else {
      Reflect.deleteProperty(globalThis, 'ErrorEvent');
    }
  });

  // -----------------------------------------------------------------------
  // flushPendingWrites() public method
  // -----------------------------------------------------------------------
  describe('flushPendingWrites', () => {
    it('flushes pending save values to the storage adapter', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Start a debounced setItem but do NOT let the debounce fire
      void storage.setItem('flush-key', { hello: 'world' });

      // Manually flush before debounce fires
      storage.flushPendingWrites();

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'flush-key',
        JSON.stringify({ hello: 'world' })
      );
    });

    it('flushes string values without double serialization', () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      void storage.setItem('string-key', 'plain-string');
      storage.flushPendingWrites();

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('string-key', 'plain-string');
    });

    it('is a no-op when there are no pending values', () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      storage.flushPendingWrites();

      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });

    it('logs when JSON.stringify throws during flush (synchronous error path)', () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Circular references can't be JSON-serialized — triggers the synchronous catch
      // path inside flushPendingSaveValues. Note: the adapter's setItem is void-ed, so
      // async adapter failures are silently dropped; only synchronous serialization
      // errors (like JSON.stringify on circular structures) reach the catch block.
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      void storage.setItem('circular-key', circular);

      // Should not throw
      expect(() => storage.flushPendingWrites()).not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to flush pending worker storage write:',
        expect.objectContaining({ error: expect.any(Error), key: 'circular-key' })
      );
    });
  });

  // -----------------------------------------------------------------------
  // processSetItemRequest with undefined value
  // -----------------------------------------------------------------------
  describe('storage_request – setItem with undefined value', () => {
    it('responds with error when value is undefined', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: 'undef-1',
        key: 'some-key',
        operation: 'setItem',
        // value intentionally omitted (undefined)
        opId: 1,
        type: 'storage_request',
      });

      await vi.waitFor(() => {
        expect(mockWorker.postMessage).toHaveBeenCalledWith({
          error: 'Cannot store undefined value',
          id: 'undef-1',
          operation: 'setItem',
          success: false,
          type: 'storage_response',
        });
      });
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // removeItem cancelling a pending debounced setItem
  // -----------------------------------------------------------------------
  describe('removeItem clears pending debounced setItem', () => {
    it('cancels the debounced setItem and removes the key', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Start debounced setItem
      void storage.setItem('ephemeral', 'will-be-removed');

      // Auto-respond to remove message
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          id: message.id,
          result: true,
          type: 'success',
        });
      });

      // Remove before debounce fires
      await storage.removeItem('ephemeral');

      // Advance past debounce window – the setItem should NOT fire
      await vi.advanceTimersByTimeAsync(200);

      // The only postMessage should be for the remove, not the save
      const saveMessages = mockWorker.postMessage.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'save'
      );
      expect(saveMessages).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // setItem double-failure path
  // -----------------------------------------------------------------------
  describe('setItem double-failure (worker + adapter)', () => {
    it('rejects when both worker and storage adapter fail', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Worker responds with error
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          error: 'Worker save failed',
          id: message.id,
          type: 'error',
        });
      });

      // Adapter also fails
      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage quota exceeded');
      });

      const promise = storage.setItem('doomed-key', 'value');

      // Attach the rejection handler BEFORE advancing timers. The rejection fires
      // during advanceTimersByTimeAsync's microtask flushing; without a handler
      // attached first, Node emits an unhandledRejection warning.
      const assertion = expect(promise).rejects.toThrow('Storage quota exceeded');

      await vi.advanceTimersByTimeAsync(200);
      await assertion;
    });
  });

  // -----------------------------------------------------------------------
  // clearTrackedPendingSave no-op when value has been superseded
  // -----------------------------------------------------------------------
  describe('clearTrackedPendingSave – superseded value', () => {
    it('does not clear pending save when value has been superseded', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Respond successfully to all worker messages
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          id: message.id,
          result: true,
          type: 'success',
        });
      });

      // First setItem starts debounce
      const p1 = storage.setItem('race-key', 'old-value');

      // Second setItem supersedes the first
      const p2 = storage.setItem('race-key', 'new-value');

      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([p1, p2]);

      // The last value should be persisted
      // The postMessage for 'save' should have been called with 'new-value'
      const saveCall = mockWorker.postMessage.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as { type: string }).type === 'save' &&
          (call[0] as { key?: string }).key === 'race-key'
      );
      expect(saveCall).toBeDefined();
      expect((saveCall?.[0] as { value?: unknown } | undefined)?.value).toBe('new-value');
    });
  });

  // -----------------------------------------------------------------------
  // handleWorkerError with mixed pending state
  // -----------------------------------------------------------------------
  describe('handleWorkerError – comprehensive cleanup', () => {
    it('rejects all pending requests and flushes saves on error', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Start multiple operations
      const getPromise = storage.getItem('pending-get');
      void storage.setItem('pending-set', 'value');

      // Trigger worker error
      mockWorker.emitError(new Error('catastrophic failure'));

      // getItem should fall back to localStorage
      const getResult = await getPromise;
      expect(getResult).toBeNull();

      // Pending save should be flushed to adapter
      await vi.advanceTimersByTimeAsync(200);
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('pending-set', 'value');

      expect(storage.isWorkerAvailable).toBe(false);
      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it('clears timeout timers on worker error', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Start a request that will create a timeout timer
      void storage.getItem('will-timeout');

      // Error should clear the timeout
      mockWorker.emitError(new Error('crash'));

      // Advancing past the 5s timeout should not cause issues
      await vi.advanceTimersByTimeAsync(6000);

      // No additional error logs from timeout after error cleanup
      const timeoutErrors = mockLogger.error.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('timeout')
      );
      expect(timeoutErrors).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // destroy idempotency
  // -----------------------------------------------------------------------
  describe('destroy – idempotency', () => {
    it('can be called multiple times without error', () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      storage.destroy();
      storage.destroy(); // second call should be safe

      expect(mockWorker.terminate).toHaveBeenCalledTimes(1);
      expect(storage.isWorkerAvailable).toBe(false);
    });

    it('resolves pending debounced setItem callers on destroy', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      const promise = storage.setItem('destroy-key', 'destroy-val');

      storage.destroy();

      // The promise from the superseded debounce should resolve (not hang)
      await vi.advanceTimersByTimeAsync(200);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getItem fallback – JSON parse failure returns raw string
  // -----------------------------------------------------------------------
  describe('getItem fallback – raw value on parse failure', () => {
    it('returns raw string when JSON.parse fails in fallback path', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Worker responds with error → triggers fallback
      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            error: 'worker down',
            id: message.id,
            type: 'error',
          });
        });
      });

      // Set a non-JSON value in localStorage
      mockLocalStorage.data.set('raw-val', 'not-valid-json{{{');

      const result = await storage.getItem('raw-val');

      expect(result).toBe('not-valid-json{{{');
    });

    it('returns parsed object when JSON is valid in fallback path', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            error: 'worker down',
            id: message.id,
            type: 'error',
          });
        });
      });

      mockLocalStorage.data.set('json-val', JSON.stringify({ parsed: true }));

      const result = await storage.getItem('json-val');

      expect(result).toEqual({ parsed: true });
    });
  });

  // -----------------------------------------------------------------------
  // sendMessage edge cases
  // -----------------------------------------------------------------------
  describe('sendMessage – message construction', () => {
    it('sends load message without value field', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            result: 'loaded',
            type: 'success',
          });
        });
      });

      await storage.getItem('load-key');

      const sentMessage = mockWorker.postMessage.mock.calls[0]?.[0];
      expect(sentMessage).toBeDefined();
      expect(sentMessage).toHaveProperty('type', 'load');
      expect(sentMessage).toHaveProperty('key', 'load-key');
      expect(sentMessage).not.toHaveProperty('value');
    });

    it('sends save message with both key and value', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          id: message.id,
          result: true,
          type: 'success',
        });
      });

      const promise = storage.setItem('save-key', { nested: 'data' });
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      const saveCall = mockWorker.postMessage.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'save'
      );
      expect(saveCall).toBeDefined();
      expect((saveCall?.[0] as { key?: string } | undefined)?.key).toBe('save-key');
      expect((saveCall?.[0] as { value?: unknown } | undefined)?.value).toEqual({
        nested: 'data',
      });
    });
  });

  // -----------------------------------------------------------------------
  // storage_request – opId ordering edge cases
  // -----------------------------------------------------------------------
  describe('storage_request – opId edge cases', () => {
    it('processes request without opId (opId is undefined)', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: 'no-opid',
        key: 'k',
        operation: 'setItem',
        type: 'storage_request',
        value: 'v',
        // opId intentionally omitted
      });

      await vi.waitFor(() => {
        expect(mockLocalStorage.setItem).toHaveBeenCalledWith('k', 'v');
        expect(mockWorker.postMessage).toHaveBeenCalledWith({
          id: 'no-opid',
          operation: 'setItem',
          success: true,
          type: 'storage_response',
        });
      });
    });

    it('accepts equal opId (not strictly less than)', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // First request sets the opId baseline
      mockWorker.emitMessage({
        id: 'first',
        key: 'k',
        operation: 'setItem',
        opId: 5,
        type: 'storage_request',
        value: 'first-val',
      });

      await vi.waitFor(() => {
        expect(mockLocalStorage.setItem).toHaveBeenCalledWith('k', 'first-val');
      });

      // Second request with equal opId should still process
      mockWorker.emitMessage({
        id: 'second',
        key: 'k',
        operation: 'setItem',
        opId: 5,
        type: 'storage_request',
        value: 'second-val',
      });

      await vi.waitFor(() => {
        expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(2);
      });
    });

    it('skips setItem when opId < lastOp but still responds success', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Establish high opId
      mockWorker.emitMessage({
        id: 'high',
        key: 'ordered-key',
        operation: 'setItem',
        opId: 100,
        type: 'storage_request',
        value: 'new',
      });

      await vi.waitFor(() => {
        expect(mockLocalStorage.setItem).toHaveBeenCalledWith('ordered-key', 'new');
      });

      mockLocalStorage.setItem.mockClear();

      // Stale opId arrives late
      mockWorker.emitMessage({
        id: 'stale',
        key: 'ordered-key',
        operation: 'setItem',
        opId: 50,
        type: 'storage_request',
        value: 'old',
      });

      await vi.waitFor(() => {
        expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
        expect(mockWorker.postMessage).toHaveBeenCalledWith({
          id: 'stale',
          operation: 'setItem',
          success: true,
          type: 'storage_response',
        });
      });
    });

    // BST-459: `opId` is declared `opId?: number`, so 0 is a legal value of the
    // protocol type and `undefined` is the only "sender did not sequence this
    // write" signal. A truthiness check conflates the two and fails the guard
    // OPEN for opId 0 — the stale write wins and clobbers newer data.
    it('skips a stale setItem carrying opId 0, not just truthy stale opIds', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: 'newer',
        key: 'zero-key',
        operation: 'setItem',
        opId: 5,
        type: 'storage_request',
        value: 'newer',
      });

      await vi.waitFor(() => {
        expect(mockLocalStorage.setItem).toHaveBeenCalledWith('zero-key', 'newer');
      });

      mockLocalStorage.setItem.mockClear();

      mockWorker.emitMessage({
        id: 'stale-zero',
        key: 'zero-key',
        operation: 'setItem',
        opId: 0,
        type: 'storage_request',
        value: 'stale',
      });

      await vi.waitFor(() => {
        expect(mockWorker.postMessage).toHaveBeenCalledWith({
          id: 'stale-zero',
          operation: 'setItem',
          success: true,
          type: 'storage_response',
        });
      });
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent operations
  // -----------------------------------------------------------------------
  describe('concurrent setItem + removeItem', () => {
    it('removeItem clears pending debounce then sends remove to worker', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      // Start setItem (debounced)
      const setPromise = storage.setItem('concurrent-key', 'value');

      // removeItem should cancel the debounce
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          id: message.id,
          result: true,
          type: 'success',
        });
      });

      await storage.removeItem('concurrent-key');

      // The setItem promise should have been resolved (superseded)
      await vi.advanceTimersByTimeAsync(200);
      await expect(setPromise).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Timeout cleanup
  // -----------------------------------------------------------------------
  describe('request timeout cleanup', () => {
    it('cleans up timeout entry when request resolves before timeout', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            result: 'fast-result',
            type: 'success',
          });
        });
      });

      const result = await storage.getItem('fast-key');
      expect(result).toBe('fast-result');

      // Advance past timeout – should not cause any issues
      await vi.advanceTimersByTimeAsync(6000);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // setItem serialization in fallback
  // -----------------------------------------------------------------------
  describe('setItem fallback serialization', () => {
    it('serializes object values to JSON in fallback path', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          error: 'fail',
          id: message.id,
          type: 'error',
        });
      });

      const promise = storage.setItem('obj-key', { a: 1, b: [2, 3] });
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'obj-key',
        JSON.stringify({ a: 1, b: [2, 3] })
      );
    });

    it('stores string values directly without double-quoting in fallback path', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({
          error: 'fail',
          id: message.id,
          type: 'error',
        });
      });

      const promise = storage.setItem('str-key', 'already-a-string');
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('str-key', 'already-a-string');
    });
  });

  // -----------------------------------------------------------------------
  // registerWorkerListeners guard
  // -----------------------------------------------------------------------
  describe('registerWorkerListeners – null worker guard', () => {
    it('does not throw when worker is null during initialization', async () => {
      vi.resetModules();

      // Worker constructor that succeeds but produces null
      vi.stubGlobal('Worker', undefined);

      const mod = await import('../worker-storage');
      const storage = new mod.WorkerStorage(mockWorkerUrl, mockStorageAdapter);

      // Should have safely skipped listener registration
      expect(storage.isWorkerAvailable).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // handleWorkerMessage routing
  // -----------------------------------------------------------------------
  describe('handleWorkerMessage – routing', () => {
    it('routes storage_request messages to handleStorageRequest', async () => {
      new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitMessage({
        id: 'route-test',
        key: 'routing-key',
        operation: 'getItem',
        type: 'storage_request',
      });

      await vi.waitFor(() => {
        expect(mockLocalStorage.getItem).toHaveBeenCalledWith('routing-key');
      });
    });

    it('routes success/error messages to handleWorkerResponse', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.postMessage.mockImplementationOnce((message: { id: string }) => {
        queueMicrotask(() => {
          mockWorker.emitMessage({
            id: message.id,
            result: 'routed-data',
            type: 'success',
          });
        });
      });

      const result = await storage.getItem('route-resp');
      expect(result).toBe('routed-data');
    });
  });

  // -----------------------------------------------------------------------
  // Worker error with string (not Error object)
  // -----------------------------------------------------------------------
  describe('handleWorkerError – string error', () => {
    it('handles string error messages', () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);

      mockWorker.emitError('string error message');

      expect(storage.isWorkerAvailable).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith('Worker error occurred:', expect.anything());
    });
  });
});
