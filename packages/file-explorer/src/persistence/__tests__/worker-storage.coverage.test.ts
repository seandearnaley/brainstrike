import { exchangeStorageRequest } from './worker-storage-test-boundary';
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
      setGlobalSlot('ErrorEvent', originalErrorEvent);
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

    it('logs when JSON.stringify throws during flush (synchronous error path)', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      const saved = storage.setItem('circular-key', circular);
      const rejected = expect(saved).rejects.toThrow();
      expect(() => storage.flushPendingWrites()).not.toThrow();
      await rejected;
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to flush pending worker storage write:',
        expect.objectContaining({ error: expect.any(Error) })
      );
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // processSetItemRequest with undefined value
  // -----------------------------------------------------------------------
  describe('storage_request – setItem with undefined value', () => {
    it('responds with error when value is undefined', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const result = await exchangeStorageRequest(storage, mockWorker, {
        key: 'some-key',
        operation: 'setItem',
        opId: 1,
      });
      expect(result).toEqual(new Error('Cannot store undefined value'));
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
      mockWorker.postMessage.mockImplementation((message: { id: string }) => {
        mockWorker.emitMessage({ error: 'Worker save failed', id: message.id, type: 'error' });
      });
      const promise = storage.setItem('doomed-key', 'value');
      const assertion = expect(promise).rejects.toThrow('Worker save failed');
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
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
    it('rejects pending saves on worker error without a fallback', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const reading = storage.getItem('pending-get');
      const saving = storage.setItem('pending-set', 'value');
      const rejection = expect(saving).rejects.toThrow('Worker error occurred');
      mockWorker.emitError(new Error('catastrophic failure'));
      await rejection;
      expect(await reading).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
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
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      expect(
        await exchangeStorageRequest(storage, mockWorker, {
          key: 'k',
          operation: 'setItem',
          value: 'v',
        })
      ).toBeUndefined();
      expect(mockLocalStorage.data.get('k')).toBe('v');
    });

    it('accepts equal opId (not strictly less than)', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'k',
        operation: 'setItem',
        opId: 5,
        value: 'first-val',
      });
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'k',
        operation: 'setItem',
        opId: 5,
        value: 'second-val',
      });
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(2);
      expect(mockLocalStorage.data.get('k')).toBe('second-val');
    });

    it('skips setItem when opId < lastOp but still responds success', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'ordered-key',
        operation: 'setItem',
        opId: 100,
        value: 'new',
      });
      expect(
        await exchangeStorageRequest(storage, mockWorker, {
          key: 'ordered-key',
          operation: 'setItem',
          opId: 50,
          value: 'old',
        })
      ).toBeUndefined();
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockLocalStorage.data.get('ordered-key')).toBe('new');
    });

    // BST-459: `opId` is declared `opId?: number`, so 0 is a legal value of the
    // protocol type and `undefined` is the only "sender did not sequence this
    // write" signal. A truthiness check conflates the two and fails the guard
    // OPEN for opId 0 — the stale write wins and clobbers newer data.
    it('skips a stale setItem carrying opId 0, not just truthy stale opIds', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'ordered-key',
        operation: 'setItem',
        opId: 100,
        value: 'new',
      });
      expect(
        await exchangeStorageRequest(storage, mockWorker, {
          key: 'ordered-key',
          operation: 'setItem',
          opId: 0,
          value: 'old',
        })
      ).toBeUndefined();
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockLocalStorage.data.get('ordered-key')).toBe('new');
    });

    // The two cases that make `Number.isFinite` the predicate rather than a
    // bare `opId !== undefined`. The payload crosses postMessage and is not
    // type-checked at runtime, so neither value is excluded by the declared
    // `opId?: number`.
    it('does not let a NaN opId poison the ordering baseline for its key', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'nan-key',
        operation: 'setItem',
        opId: 100,
        value: 'newest',
      });
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'nan-key',
        operation: 'setItem',
        opId: Number.NaN,
        value: 'unsequenced',
      });
      mockLocalStorage.setItem.mockClear();
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'nan-key',
        operation: 'setItem',
        opId: 50,
        value: 'stale',
      });
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
      expect(mockLocalStorage.data.get('nan-key')).toBe('unsequenced');
    });

    it('does not skip a write whose opId is a non-numeric value that coerces low', async () => {
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'coerce-key',
        operation: 'setItem',
        opId: 100,
        value: 'newest',
      });
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'coerce-key',
        operation: 'setItem',
        opId: '' as unknown as number,
        value: 'later',
      });
      expect(mockLocalStorage.data.get('coerce-key')).toBe('later');
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(2);
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
  describe('explicit flush serialization', () => {
    it('serializes object values during explicit flush', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const saved = storage.setItem('flush-key', { nested: 'value' });
      storage.flushPendingWrites();
      await saved;
      expect(mockLocalStorage.data.get('flush-key')).toBe(JSON.stringify({ nested: 'value' }));
    });

    it('flushes strings without double quoting', async () => {
      vi.useFakeTimers();
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      const saved = storage.setItem('flush-key', 'plain-string');
      storage.flushPendingWrites();
      await saved;
      expect(mockLocalStorage.data.get('flush-key')).toBe('plain-string');
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
      const storage = new WorkerStorageClass(mockWorkerUrl, mockStorageAdapter);
      await exchangeStorageRequest(storage, mockWorker, {
        key: 'routing-key',
        operation: 'getItem',
      });
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('routing-key');
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
