import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantRunDiscoveryResource } from '../assistant-run-discovery-resource';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('assistant run discovery resource', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps immutable cached snapshots and ignores a disposed attempt', async () => {
    const first = deferred<{ type: 'ready'; value: string }>();
    const resource = new AssistantRunDiscoveryResource<string>('pending', '');
    const listener = vi.fn();
    const unsubscribe = resource.subscribe(listener);
    const initial = resource.getSnapshot();
    expect(resource.getSnapshot()).toBe(initial);
    const firstExecute = vi.fn(() => first.promise);
    const stop = resource.start({ execute: firstExecute, onRetry: vi.fn(), timeoutMs: 1000 });
    stop();
    first.resolve({ type: 'ready', value: 'stale' });
    await Promise.resolve();
    expect(firstExecute).not.toHaveBeenCalled();
    expect(resource.getSnapshot().status).toBe('pending');

    const second = deferred<{ type: 'ready'; value: string }>();
    resource.start({ execute: () => second.promise, onRetry: vi.fn(), timeoutMs: 1000 });
    second.resolve({ type: 'ready', value: 'current' });
    await vi.waitFor(() =>
      expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 'current' })
    );
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('times out a hung admission and restarts after StrictMode cleanup', async () => {
    vi.useFakeTimers();
    const resource = new AssistantRunDiscoveryResource<string>('pending', '');
    const firstSignal = vi.fn();
    const stop = resource.start({
      execute: async (signal) => {
        firstSignal.mockImplementation(() => signal.aborted);
        return new Promise<never>(() => undefined);
      },
      onRetry: vi.fn(),
      timeoutMs: 30_000,
    });
    stop();
    expect(firstSignal).not.toHaveBeenCalled();
    resource.start({
      execute: async () => new Promise<never>(() => undefined),
      onRetry: vi.fn(),
      timeoutMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resource.getSnapshot()).toEqual({
      error: expect.objectContaining({ message: 'Assistant run discovery timed out.' }),
      status: 'error',
    });
  });

  it('publishes a synchronous executor failure without leaking a running attempt', async () => {
    const resource = new AssistantRunDiscoveryResource<string>('pending', '');
    const stop = resource.start({
      execute: () => {
        throw new Error('executor failed');
      },
      onRetry: vi.fn(),
      timeoutMs: 1000,
    });
    await vi.waitFor(() =>
      expect(resource.getSnapshot()).toEqual({
        error: expect.objectContaining({ message: 'executor failed' }),
        status: 'error',
      })
    );
    stop();
  });
});
