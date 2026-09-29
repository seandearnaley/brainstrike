import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMaintenanceTriggerRuntime } from '../maintenance-trigger-runtime';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('maintenance trigger runtime', () => {
  it('fires after the initial delay, then at fixed intervals, and stops without a late tick', async () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const unsubscribe = vi.fn();
    const runtime = createMaintenanceTriggerRuntime({
      initialDelayMs: 30,
      intervalMs: 100,
      onCloseError: vi.fn(),
      subscribe: () => unsubscribe,
      tick,
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(29);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(tick).toHaveBeenCalledTimes(3);

    runtime.stop();
    await runtime.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('releases a subscription if timer acquisition fails', async () => {
    const unsubscribe = vi.fn();
    const failure = new Error('timer unavailable');
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
      throw failure;
    });
    const runtime = createMaintenanceTriggerRuntime({
      initialDelayMs: 30,
      intervalMs: 100,
      onCloseError: vi.fn(),
      subscribe: () => unsubscribe,
      tick: vi.fn(),
    });

    await expect(runtime.start()).rejects.toBe(failure);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not let an old generation clear or tick a restarted one', async () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const runtime = createMaintenanceTriggerRuntime({
      initialDelayMs: 30,
      intervalMs: 100,
      onCloseError: vi.fn(),
      tick,
    });

    await runtime.start();
    runtime.stop();
    const oldClose = runtime.close();
    await runtime.start();
    await oldClose;
    await vi.advanceTimersByTimeAsync(30);
    expect(tick).toHaveBeenCalledTimes(1);
    runtime.stop();
    await runtime.close();
  });

  it('does not arm the interval when the first tick synchronously stops the owner', async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const tick = vi.fn(() => runtime.stop());
    const runtime = createMaintenanceTriggerRuntime({
      initialDelayMs: 30,
      intervalMs: 100,
      onCloseError: vi.fn(),
      subscribe: () => unsubscribe,
      tick,
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(530);
    await runtime.close();

    expect(tick).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports both the acquisition and finalizer failures', async () => {
    const acquisitionError = new Error('timer unavailable');
    const finalizerError = new Error('unsubscribe failed');
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
      throw acquisitionError;
    });
    const runtime = createMaintenanceTriggerRuntime({
      initialDelayMs: 30,
      intervalMs: 100,
      onCloseError: vi.fn(),
      subscribe: () => () => {
        throw finalizerError;
      },
      tick: vi.fn(),
    });

    await expect(runtime.start()).rejects.toMatchObject({
      errors: [acquisitionError, finalizerError],
    });
  });

  it('releases a start that is stopped before its acquisition promise settles', async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const tick = vi.fn();
    const runtime = createMaintenanceTriggerRuntime({
      initialDelayMs: 30,
      intervalMs: 100,
      onCloseError: vi.fn(),
      subscribe,
      tick,
    });

    const firstStart = runtime.start();
    const sameStart = runtime.start();
    expect(sameStart).toBe(firstStart);
    runtime.stop();
    await Promise.all([firstStart, runtime.close()]);
    await vi.advanceTimersByTimeAsync(530);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
