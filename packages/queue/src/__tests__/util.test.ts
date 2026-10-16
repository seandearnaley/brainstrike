import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerReadyWaiter,
  DEFAULT_WORKER_READY_TIMEOUT_MS,
  estimateHardwareConcurrency,
  isAbortError,
  ProgressEmitter,
  supportsWorkers,
} from '../util.js';

describe('ProgressEmitter', () => {
  interface TestEvent {
    message: string;
    value: number;
  }
  let emitter: ProgressEmitter<TestEvent>;

  beforeEach(() => {
    emitter = new ProgressEmitter<TestEvent>();
  });

  it('should add listeners and return unsubscribe function', () => {
    const listener = vi.fn();
    const unsubscribe = emitter.add(listener);

    expect(typeof unsubscribe).toBe('function');
    expect(listener).not.toHaveBeenCalled();
  });

  it('should emit events to all registered listeners', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const listener3 = vi.fn();

    emitter.add(listener1);
    emitter.add(listener2);
    emitter.add(listener3);

    const event: TestEvent = { message: 'test', value: 42 };
    emitter.emit(event);

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener1).toHaveBeenCalledWith(event);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledWith(event);
    expect(listener3).toHaveBeenCalledTimes(1);
    expect(listener3).toHaveBeenCalledWith(event);
  });

  it('should remove listener when unsubscribe is called', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    const unsubscribe1 = emitter.add(listener1);
    emitter.add(listener2);

    // Unsubscribe first listener
    unsubscribe1();

    const event: TestEvent = { message: 'test', value: 42 };
    emitter.emit(event);

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledWith(event);
  });

  it('should handle multiple unsubscribe calls safely', () => {
    const listener = vi.fn();
    const unsubscribe = emitter.add(listener);

    unsubscribe();
    unsubscribe(); // Should not throw

    const event: TestEvent = { message: 'test', value: 42 };
    emitter.emit(event);

    expect(listener).not.toHaveBeenCalled();
  });

  it('should emit to no listeners when none are registered', () => {
    const event: TestEvent = { message: 'test', value: 42 };
    // Should not throw
    expect(() => emitter.emit(event)).not.toThrow();
  });

  it('should handle listeners that modify the listener set during emission', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    let unsubscribe2: (() => void) | undefined;

    emitter.add(listener1);
    unsubscribe2 = emitter.add(listener2);

    // Listener that unsubscribes another listener
    const listener3 = vi.fn(() => {
      if (unsubscribe2) {
        unsubscribe2();
      }
    });
    emitter.add(listener3);

    const event: TestEvent = { message: 'test', value: 42 };
    emitter.emit(event);

    // All listeners should have been called (unsubscribe takes effect after emission)
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener3).toHaveBeenCalledTimes(1);

    // Second emission should not call listener2
    vi.clearAllMocks();
    emitter.emit(event);
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).not.toHaveBeenCalled();
    expect(listener3).toHaveBeenCalledTimes(1);
  });
});

describe('estimateHardwareConcurrency', () => {
  it('should return navigator.hardwareConcurrency when available', () => {
    const mockNavigator = {
      hardwareConcurrency: 8,
    };
    vi.stubGlobal('navigator', mockNavigator);

    const result = estimateHardwareConcurrency();
    expect(result).toBe(8);

    vi.unstubAllGlobals();
  });

  it('should return default value of 2 when navigator is undefined', () => {
    vi.stubGlobal('navigator', undefined);

    const result = estimateHardwareConcurrency();
    expect(result).toBe(2);

    vi.unstubAllGlobals();
  });

  it('should return default value when hardwareConcurrency is not a finite number', () => {
    const mockNavigator = {
      hardwareConcurrency: Number.POSITIVE_INFINITY,
    };
    vi.stubGlobal('navigator', mockNavigator);

    const result = estimateHardwareConcurrency();
    expect(result).toBe(2);

    vi.unstubAllGlobals();
  });

  it('should return default value when hardwareConcurrency is zero', () => {
    const mockNavigator = {
      hardwareConcurrency: 0,
    };
    vi.stubGlobal('navigator', mockNavigator);

    const result = estimateHardwareConcurrency();
    expect(result).toBe(2);

    vi.unstubAllGlobals();
  });

  it('should return default value when hardwareConcurrency is negative', () => {
    const mockNavigator = {
      hardwareConcurrency: -4,
    };
    vi.stubGlobal('navigator', mockNavigator);

    const result = estimateHardwareConcurrency();
    expect(result).toBe(2);

    vi.unstubAllGlobals();
  });

  it('should return default value when hardwareConcurrency is NaN', () => {
    const mockNavigator = {
      hardwareConcurrency: Number.NaN,
    };
    vi.stubGlobal('navigator', mockNavigator);

    const result = estimateHardwareConcurrency();
    expect(result).toBe(2);

    vi.unstubAllGlobals();
  });
});

describe('isAbortError', () => {
  it('should return true for DOMException with name AbortError', () => {
    const error = new DOMException('Operation aborted', 'AbortError');
    expect(isAbortError(error)).toBe(true);
  });

  it('should return true for Error with name AbortError', () => {
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
  });

  it('should return false for DOMException with different name', () => {
    const error = new DOMException('Not found', 'NotFoundError');
    expect(isAbortError(error)).toBe(false);
  });

  it('should return false for regular Error', () => {
    const error = new Error('Regular error');
    expect(isAbortError(error)).toBe(false);
  });

  it('should return false for string error', () => {
    expect(isAbortError('error string')).toBe(false);
  });

  it('should return false for null', () => {
    expect(isAbortError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isAbortError(undefined)).toBe(false);
  });

  it('should return false for object without name property', () => {
    const error = { message: 'error' };
    expect(isAbortError(error)).toBe(false);
  });

  it('should return false for object with name property but not AbortError', () => {
    const error = { message: 'error', name: 'CustomError' };
    expect(isAbortError(error)).toBe(false);
  });
});

describe('supportsWorkers', () => {
  it('should return true in a window that has Worker', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', function Worker() {});

    const result = supportsWorkers();
    expect(result).toBe(true);

    vi.unstubAllGlobals();
  });

  it('should return true in a worker, which has Worker but no window', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('Worker', function Worker() {});

    const result = supportsWorkers();
    expect(result).toBe(true);

    vi.unstubAllGlobals();
  });

  it('should return false in a window without Worker', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', undefined);

    const result = supportsWorkers();
    expect(result).toBe(false);

    vi.unstubAllGlobals();
  });

  it('should return false when both window and Worker are undefined', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('Worker', undefined);

    const result = supportsWorkers();
    expect(result).toBe(false);

    vi.unstubAllGlobals();
  });
});

describe('createWorkerReadyWaiter (BST-165)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve immediately when already ready', async () => {
    const isReady = () => true;
    const waitForReady = createWorkerReadyWaiter(isReady);

    const result = await waitForReady(1000);
    expect(result).toBe(true);
  });

  it('should resolve true when worker becomes ready within timeout', async () => {
    let ready = false;
    const waitForReady = createWorkerReadyWaiter(() => ready);

    const promise = waitForReady(1000);

    // Simulate worker becoming ready after 100ms
    await vi.advanceTimersByTimeAsync(100);
    ready = true;
    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result).toBe(true);
  });

  it('should resolve false when timeout expires', async () => {
    const isReady = () => false;
    const waitForReady = createWorkerReadyWaiter(isReady);

    const promise = waitForReady(1000);
    await vi.advanceTimersByTimeAsync(1100);

    const result = await promise;
    expect(result).toBe(false);
  });

  it('should use default timeout when none provided', async () => {
    const isReady = () => false;
    const waitForReady = createWorkerReadyWaiter(isReady);

    const promise = waitForReady();
    await vi.advanceTimersByTimeAsync(DEFAULT_WORKER_READY_TIMEOUT_MS + 100);

    const result = await promise;
    expect(result).toBe(false);
  });

  it('should respect custom default timeout option', async () => {
    const isReady = () => false;
    const waitForReady = createWorkerReadyWaiter(isReady, { defaultTimeoutMs: 500 });

    const promise = waitForReady();
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result).toBe(false);
  });

  it('should respect custom poll interval option', async () => {
    let pollCount = 0;
    const isReady = () => {
      pollCount++;
      return pollCount >= 5;
    };
    const waitForReady = createWorkerReadyWaiter(isReady, { pollIntervalMs: 10 });

    const promise = waitForReady(1000);

    // After 50ms with 10ms intervals, should have polled ~5 times
    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result).toBe(true);
    expect(pollCount).toBeGreaterThanOrEqual(5);
  });
});

describe('DEFAULT_WORKER_READY_TIMEOUT_MS', () => {
  it('should be 30 seconds', () => {
    expect(DEFAULT_WORKER_READY_TIMEOUT_MS).toBe(30_000);
  });
});
