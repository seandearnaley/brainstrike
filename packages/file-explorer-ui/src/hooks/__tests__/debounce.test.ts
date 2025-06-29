import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebounce } from '../debounce';

describe('createDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should debounce function calls', async () => {
    const mockFn = vi.fn();
    const { run } = createDebounce(mockFn, 100);

    run('arg1');
    run('arg2');
    run('arg3');

    expect(mockFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith('arg3');
  });

  it('should handle async functions', async () => {
    const mockAsyncFn = vi.fn().mockResolvedValue(undefined);
    const { run } = createDebounce(mockAsyncFn, 100);

    run('test');

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockAsyncFn).toHaveBeenCalledWith('test');
  });

  it('should flush pending calls immediately without deadlock', async () => {
    const mockFn = vi.fn();
    const { run, flush } = createDebounce(mockFn, 100);

    run('test');

    // Flush should complete immediately without waiting for the timeout
    const flushPromise = flush();

    // Advance timers to ensure flush doesn't wait for the original timeout
    vi.advanceTimersByTime(50);

    // This should resolve immediately without deadlock
    await flushPromise;

    // The original function should not have been called since flush cancelled it
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should handle multiple flush calls without issues', async () => {
    const mockFn = vi.fn();
    const { run, flush } = createDebounce(mockFn, 100);

    run('test');

    // Multiple flush calls should not cause issues
    await flush();
    await flush();
    await flush();

    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should handle flush when no pending operations exist', async () => {
    const mockFn = vi.fn();
    const { flush } = createDebounce(mockFn, 100);

    // Flush with no pending operations should complete immediately
    await flush();

    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should handle flush after timeout has already completed', async () => {
    const mockFn = vi.fn();
    const { run, flush } = createDebounce(mockFn, 100);

    run('test');

    // Let the timeout complete
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledWith('test');

    // Flush after completion should not cause issues
    await flush();
  });

  it('should reset timeout when run is called multiple times', async () => {
    const mockFn = vi.fn();
    const { run } = createDebounce(mockFn, 100);

    run('first');
    vi.advanceTimersByTime(50);

    run('second');
    vi.advanceTimersByTime(50);

    // Should not have been called yet
    expect(mockFn).not.toHaveBeenCalled();

    run('third');
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    // Should only be called once with the last argument
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith('third');
  });

  it('should handle errors in the debounced function', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('Test error'));
    const { run } = createDebounce(mockFn, 100);

    run('test');

    vi.advanceTimersByTime(100);

    // Should not throw when the debounced function throws
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledWith('test');
  });
});
