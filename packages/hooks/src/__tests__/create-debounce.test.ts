import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebounce } from '../create-debounce';

describe('createDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces calls and uses latest arguments', async () => {
    const mockFn = vi.fn();
    const { run } = createDebounce(mockFn, 100);

    run('a');
    run('b');
    run('c');

    expect(mockFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith('c');
  });

  it('handles async functions', async () => {
    const mockAsyncFn = vi.fn().mockResolvedValue(undefined);
    const { run } = createDebounce(mockAsyncFn, 50);

    run('x');

    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();

    expect(mockAsyncFn).toHaveBeenCalledWith('x');
  });

  it('flush executes pending call immediately', async () => {
    const mockFn = vi.fn();
    const { run, flush } = createDebounce(mockFn, 100);

    run('test');

    await flush();

    expect(mockFn).toHaveBeenCalledWith('test');
  });

  it('flush resolves when nothing pending', async () => {
    const mockFn = vi.fn();
    const { flush } = createDebounce(mockFn, 100);

    await flush();

    expect(mockFn).not.toHaveBeenCalled();
  });

  it('flush after timer finished does not repeat call', async () => {
    const mockFn = vi.fn();
    const { run, flush } = createDebounce(mockFn, 100);

    run('t');

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledWith('t');

    await flush();

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('run resets timer with latest args', async () => {
    const mockFn = vi.fn();
    const { run } = createDebounce(mockFn, 100);

    run('first');
    vi.advanceTimersByTime(50);
    run('second');
    vi.advanceTimersByTime(50);
    run('third');

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith('third');
  });

  it('ignores errors when no onError callback is provided', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('err'));
    const { run } = createDebounce(mockFn, 100);

    run('boom');

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledWith('boom');
  });

  it('passes run errors to onError callback', async () => {
    const error = new Error('run error');
    const mockFn = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const { run } = createDebounce(mockFn, 100, { onError });

    run('boom');

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledWith('boom');
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('passes flush errors to onError callback', async () => {
    const error = new Error('flush error');
    const mockFn = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const { run, flush } = createDebounce(mockFn, 100, { onError });

    run('test');
    await flush();

    expect(mockFn).toHaveBeenCalledWith('test');
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('should not clear timer when timer is already null', async () => {
    const mockFn = vi.fn();
    const { run, flush } = createDebounce(mockFn, 100);

    // Call run without timer set
    run('test');
    await flush(); // This clears the timer

    // Call flush again - should handle null timer gracefully
    await flush();
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should properly reset timer on multiple rapid calls', async () => {
    const mockFn = vi.fn();
    const { run } = createDebounce(mockFn, 100);

    run('a');
    vi.advanceTimersByTime(50);
    run('b'); // Should clear previous timer
    vi.advanceTimersByTime(50);

    expect(mockFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith('b');
  });

  it('should handle consecutive run calls that clear existing timer', async () => {
    const mockFn = vi.fn();
    const { run } = createDebounce(mockFn, 100);

    run('first');
    expect(mockFn).not.toHaveBeenCalled();

    // Immediately call again before timer fires
    run('second');
    expect(mockFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith('second');
  });
});
