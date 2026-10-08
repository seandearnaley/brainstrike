import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthFlowCancelledError,
  ProviderAuthFlowError,
} from '../../src/provider-auth/errors.js';
import { guardedFetchText } from '../../src/provider-auth/fetch-guards.js';

function options(fetchFn: typeof fetch) {
  return {
    fetchFn,
    init: { method: 'POST' },
    onTimeout: () => new ProviderAuthFlowError('device_flow_failed', 'request timed out'),
    timeoutMs: 100,
    url: 'https://provider.test/token',
  } as const;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('guardedFetchText', () => {
  it('times out an uncooperative fetch and aborts its request signal', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    });

    const assertion = expect(guardedFetchText(options(fetchFn))).rejects.toMatchObject({
      code: 'device_flow_failed',
      message: 'request timed out',
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('bounds a stalled response body within the same request deadline', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        text: async () => await new Promise<string>(() => undefined),
      } as Response;
    });

    const assertion = expect(guardedFetchText(options(fetchFn))).rejects.toMatchObject({
      code: 'device_flow_failed',
      message: 'request timed out',
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('creates one timeout error when aborting a cooperative fetch', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(
      () => new ProviderAuthFlowError('device_flow_failed', 'request timed out')
    );
    const fetchFn = vi.fn<typeof fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );

    const assertion = expect(
      guardedFetchText({ ...options(fetchFn), onTimeout })
    ).rejects.toMatchObject({ code: 'device_flow_failed' });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('cancels promptly, aborts fetch, and does not call an already-aborted request', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    });

    const pending = guardedFetchText({
      ...options(fetchFn),
      cancelSignal: controller.signal,
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ProviderAuthFlowCancelledError);
    expect(requestSignal?.aborted).toBe(true);

    await expect(
      guardedFetchText({ ...options(fetchFn), cancelSignal: controller.signal, timeoutMs: 10_000 })
    ).rejects.toBeInstanceOf(ProviderAuthFlowCancelledError);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('preserves an unrelated network rejection by identity', async () => {
    const failure = new Error('offline');
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw failure;
    });

    await expect(guardedFetchText(options(fetchFn))).rejects.toBe(failure);
  });

  it('clears the deadline and caller listener after a successful body read', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const onTimeout = vi.fn(
      () => new ProviderAuthFlowError('device_flow_failed', 'request timed out')
    );
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response('{"ok":true}', { status: 200 });
    });

    await expect(
      guardedFetchText({ ...options(fetchFn), cancelSignal: caller.signal, onTimeout })
    ).resolves.toMatchObject({ text: '{"ok":true}' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stalled body without accepting its late completion', async () => {
    const caller = new AbortController();
    let bodyStarted: (() => void) | undefined;
    let resolveBody: ((body: string) => void) | undefined;
    const reachedBody = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => {
            bodyStarted?.();
            return await new Promise<string>((resolve) => {
              resolveBody = resolve;
            });
          },
        }) as Response
    );

    const pending = guardedFetchText({
      ...options(fetchFn),
      cancelSignal: caller.signal,
      timeoutMs: 10_000,
    });
    await reachedBody;
    caller.abort();
    await expect(pending).rejects.toBeInstanceOf(ProviderAuthFlowCancelledError);
    resolveBody?.('{"access_token":"late"}');
    await Promise.resolve();
  });

  it('rejects invalid deadlines before starting a request', async () => {
    const fetchFn = vi.fn<typeof fetch>();

    await expect(guardedFetchText({ ...options(fetchFn), timeoutMs: -1 })).rejects.toBeInstanceOf(
      RangeError
    );
    await expect(guardedFetchText({ ...options(fetchFn), timeoutMs: 0.5 })).rejects.toBeInstanceOf(
      RangeError
    );
    await expect(
      guardedFetchText({ ...options(fetchFn), timeoutMs: 4_294_967_296 })
    ).rejects.toBeInstanceOf(RangeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts a zero deadline and lets an immediate response win', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}'));

    await expect(guardedFetchText({ ...options(fetchFn), timeoutMs: 0 })).resolves.toMatchObject({
      text: '{}',
    });
  });

  it('observes a late fetch rejection after the deadline', async () => {
    vi.useFakeTimers();
    let rejectFetch: ((error: Error) => void) | undefined;
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        await new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        })
    );
    const assertion = expect(guardedFetchText(options(fetchFn))).rejects.toMatchObject({
      code: 'device_flow_failed',
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    rejectFetch?.(new Error('late network failure'));
    await vi.advanceTimersByTimeAsync(0);
  });
});
