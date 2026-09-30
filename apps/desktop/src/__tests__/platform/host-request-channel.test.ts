import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarnMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
const loggerDebugMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: loggerDebugMock,
      error: loggerErrorMock,
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

import {
  createHostRequestChannel,
  type HostRequestChannelOptions,
  type HostRequestTimeoutContext,
} from '../../platform/host-request-channel';

interface TestRequest {
  readonly id: string;
  readonly kind: 'fast' | 'slow';
}

interface TestResponse {
  readonly id: string;
  readonly type: 'progress' | 'result';
  readonly value?: string;
}

function createChannel(
  overrides: Partial<HostRequestChannelOptions<TestRequest, TestResponse>> = {}
) {
  const send = vi.fn<(request: TestRequest) => void>();
  const channel = createHostRequestChannel<TestRequest, TestResponse>({
    isProgress: (response) => response.type === 'progress',
    requestId: (request) => request.id,
    responseId: (response) => response.id,
    role: 'Test host',
    send,
    timeoutMs: (request) => (request.kind === 'slow' ? 500 : 50),
    ...overrides,
  });
  return { channel, send };
}

async function observe<T>(promise: Promise<T>): Promise<T | Error> {
  return await promise.then(
    (value) => value,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );
}

describe('createHostRequestChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never imports Electron: the module must be constructible before app.whenReady', () => {
    const modulePath = path.resolve(import.meta.dirname, '../../platform/host-request-channel.ts');
    let source: string;
    try {
      source = readFileSync(modulePath, 'utf8');
    } catch (error) {
      throw new Error(
        `This guard reads the channel source directly; expected it at ${modulePath}. If the module moved, update this path.`,
        { cause: error }
      );
    }
    // Anchored on the import forms, so the module's own prose may name Electron
    // without failing this guard: `from 'electron'`, `require('electron')`,
    // `await import('electron')`, backtick specifiers, and subpaths such as
    // 'electron/main'.
    expect(source).not.toMatch(/(?:from|import\(|require\()\s*['"`]electron(?:\/|['"`])/u);
  });

  it('sends the request and resolves with the terminal response for that id', async () => {
    const { channel, send } = createChannel();
    const request: TestRequest = { id: 'req-1', kind: 'fast' };

    const pending = channel.request(request);
    expect(send).toHaveBeenCalledWith(request);
    expect(channel.size()).toBe(1);
    expect(channel.has('req-1')).toBe(true);
    expect(channel.ids()).toEqual(['req-1']);
    expect(channel.inFlight()).toEqual([request]);

    channel.accept({ id: 'req-1', type: 'result', value: 'done' });

    await expect(pending).resolves.toEqual({ id: 'req-1', type: 'result', value: 'done' });
    expect(channel.size()).toBe(0);
    // The deadline timer is released on settle: advancing past it must not reject or warn.
    await vi.advanceTimersByTimeAsync(1000);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('rejects with a per-role timeout error when no response arrives inside the window', async () => {
    const { channel } = createChannel();

    const pending = observe(channel.request({ id: 'req-timeout', kind: 'fast' }));
    await vi.advanceTimersByTimeAsync(49);
    expect(channel.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({
      message: 'Test host request req-timeout timed out after 50ms.',
    });
    expect(channel.size()).toBe(0);
  });

  it('uses the per-request timeout window', async () => {
    const { channel } = createChannel();

    const pending = observe(channel.request({ id: 'req-slow', kind: 'slow' }));
    await vi.advanceTimersByTimeAsync(499);
    expect(channel.has('req-slow')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({
      message: 'Test host request req-slow timed out after 500ms.',
    });
  });

  it('treats progress as liveness: each progress report re-arms the deadline and reaches onProgress', async () => {
    const { channel } = createChannel();
    const onProgress = vi.fn<(response: TestResponse) => void>();

    const pending = observe(channel.request({ id: 'req-progress', kind: 'fast' }, { onProgress }));
    await vi.advanceTimersByTimeAsync(40);
    channel.accept({ id: 'req-progress', type: 'progress', value: '10%' });
    await vi.advanceTimersByTimeAsync(40);
    channel.accept({ id: 'req-progress', type: 'progress', value: '20%' });
    await vi.advanceTimersByTimeAsync(49);

    expect(channel.has('req-progress')).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({
      id: 'req-progress',
      type: 'progress',
      value: '20%',
    });

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      message: 'Test host request req-progress timed out after 50ms.',
    });
  });

  it('re-arms each progress report with progressTimeoutMs when the adapter provides it', async () => {
    const onTimeout = vi.fn(
      (_request: TestRequest, _context: HostRequestTimeoutContext) =>
        ({ error: new Error('phase budget expired'), policy: 'abandon' }) as const
    );
    const { channel } = createChannel({
      onTimeout,
      // The report carries its own budget in ms; the request's first window is 15 ms.
      progressTimeoutMs: (_request, response) => Number(response.value),
      timeoutMs: () => 15,
    });

    const pending = observe(channel.request({ id: 'req-phase', kind: 'slow' }));
    await vi.advanceTimersByTimeAsync(10);
    channel.accept({ id: 'req-phase', type: 'progress', value: '100' });

    // Alive well past the 15 ms first window, and until the 100 ms budget re-armed at t=10 expires.
    await vi.advanceTimersByTimeAsync(50);
    expect(channel.has('req-phase')).toBe(true);
    await vi.advanceTimersByTimeAsync(49);
    expect(channel.has('req-phase')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ message: 'phase budget expired' });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // The context reports the budget that actually expired, not the first window.
    expect(onTimeout.mock.calls[0]?.[1]).toMatchObject({ progressCount: 1, timeoutMs: 100 });
  });

  it('gives every progress report its own budget, replacing the previous one', async () => {
    const onTimeout = vi.fn(
      (_request: TestRequest, _context: HostRequestTimeoutContext) =>
        ({ error: new Error('phase budget expired'), policy: 'abandon' }) as const
    );
    const { channel } = createChannel({
      onTimeout,
      progressTimeoutMs: (_request, response) => Number(response.value),
      timeoutMs: () => 15,
    });

    const pending = observe(channel.request({ id: 'req-phases', kind: 'slow' }));
    channel.accept({ id: 'req-phases', type: 'progress', value: '1000' });
    await vi.advanceTimersByTimeAsync(500);
    channel.accept({ id: 'req-phases', type: 'progress', value: '30' });
    await vi.advanceTimersByTimeAsync(29);
    expect(channel.has('req-phases')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ message: 'phase budget expired' });
    expect(onTimeout.mock.calls[0]?.[1]).toMatchObject({ progressCount: 2, timeoutMs: 30 });
  });

  it('keeps the current deadline, counts no progress and logs at error when progressTimeoutMs throws', async () => {
    const budgetFailure = new RangeError('budget past the longest timer');
    const onProgress = vi.fn<(response: TestResponse) => void>();
    const onTimeout = vi.fn(
      (_request: TestRequest, _context: HostRequestTimeoutContext) =>
        ({ error: new Error('first window expired'), policy: 'abandon' }) as const
    );
    const { channel } = createChannel({
      onTimeout,
      progressTimeoutMs: () => {
        throw budgetFailure;
      },
      timeoutMs: () => 50,
    });

    const pending = observe(
      channel.request({ id: 'req-bad-budget', kind: 'slow' }, { onProgress })
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(() => {
      channel.accept({ id: 'req-bad-budget', type: 'progress', value: 'x' });
    }).not.toThrow();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Test host progress budget failed; the deadline was not re-armed',
      expect.objectContaining({
        error: budgetFailure,
        requestId: 'req-bad-budget',
        role: 'Test host',
      })
    );
    expect(onProgress).not.toHaveBeenCalled();

    // Not re-armed: the original 50 ms window still ends at t=50, not t=70.
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toMatchObject({ message: 'first window expired' });
    expect(onTimeout.mock.calls[0]?.[1]).toMatchObject({ progressCount: 0, timeoutMs: 50 });
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['zero', 0],
    ['fractional', 1.5],
    ['past the longest timer', 2_147_483_648],
  ])(
    'treats a %s window from progressTimeoutMs like a throw: logged, never armed',
    async (_label, windowMs) => {
      const onTimeout = vi.fn(
        (_request: TestRequest, _context: HostRequestTimeoutContext) =>
          ({ error: new Error('first window expired'), policy: 'abandon' }) as const
      );
      const { channel } = createChannel({
        onTimeout,
        progressTimeoutMs: () => windowMs,
        timeoutMs: () => 50,
      });

      const pending = observe(channel.request({ id: 'req-odd-window', kind: 'slow' }));
      await vi.advanceTimersByTimeAsync(20);
      channel.accept({ id: 'req-odd-window', type: 'progress', value: 'x' });

      expect(loggerErrorMock).toHaveBeenCalledWith(
        'Test host progress budget failed; the deadline was not re-armed',
        expect.objectContaining({ requestId: 'req-odd-window', role: 'Test host' })
      );
      // Not re-armed: the original 50 ms window still ends at t=50.
      await vi.advanceTimersByTimeAsync(30);
      await expect(pending).resolves.toMatchObject({ message: 'first window expired' });
      expect(onTimeout.mock.calls[0]?.[1]).toMatchObject({ progressCount: 0, timeoutMs: 50 });
    }
  );

  it('rejects with the abort reason and releases the request when the signal fires', async () => {
    const { channel } = createChannel();
    const controller = new AbortController();

    const pending = observe(
      channel.request({ id: 'req-abort', kind: 'slow' }, { signal: controller.signal })
    );
    const reason = new Error('requester went away');
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
    expect(channel.size()).toBe(0);
    // The deadline timer is released too: nothing fires later.
    await vi.advanceTimersByTimeAsync(1000);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('passes a bare abort() through as the DOMException it already is', async () => {
    const { channel } = createChannel();
    const controller = new AbortController();

    const pending = observe(
      channel.request({ id: 'req-abort-bare', kind: 'fast' }, { signal: controller.signal })
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({ name: 'AbortError' });
  });

  it('wraps a non-Error abort reason in a per-role abort error', async () => {
    const { channel } = createChannel();
    const controller = new AbortController();

    const pending = observe(
      channel.request({ id: 'req-abort-plain', kind: 'fast' }, { signal: controller.signal })
    );
    controller.abort('plain string reason');

    await expect(pending).resolves.toMatchObject({
      message: 'Test host request req-abort-plain was aborted.',
    });
  });

  it('lets the adapter decide the abort error and run its abort side effect', async () => {
    const onAbort = vi.fn(
      (request: TestRequest, context: { reason: unknown; requestId: string }) =>
        new Error(`cancelled ${request.id} because ${String(context.reason)}`)
    );
    const { channel } = createChannel({ onAbort });
    const controller = new AbortController();
    const request: TestRequest = { id: 'req-abort-hook', kind: 'fast' };

    const pending = observe(channel.request(request, { signal: controller.signal }));
    controller.abort('requester destroyed');

    await expect(pending).resolves.toMatchObject({
      message: 'cancelled req-abort-hook because requester destroyed',
    });
    expect(onAbort).toHaveBeenCalledWith(request, {
      reason: 'requester destroyed',
      requestId: 'req-abort-hook',
    });
    expect(channel.size()).toBe(0);
  });

  it('still rejects the request when the adapter abort hook throws', async () => {
    const hookFailure = new Error('cancel send failed: host is gone');
    const onAbort = vi.fn((): Error => {
      throw hookFailure;
    });
    const { channel } = createChannel({ onAbort });
    const controller = new AbortController();

    const pending = observe(
      channel.request({ id: 'req-abort-throws', kind: 'fast' }, { signal: controller.signal })
    );
    controller.abort('requester destroyed');

    await expect(pending).resolves.toBe(hookFailure);
    expect(channel.size()).toBe(0);
  });

  it('rejects without sending when the signal is already aborted', async () => {
    const { channel, send } = createChannel();
    const controller = new AbortController();
    controller.abort(new Error('already gone'));

    await expect(
      channel.request({ id: 'req-pre-aborted', kind: 'fast' }, { signal: controller.signal })
    ).rejects.toThrow('already gone');
    expect(send).not.toHaveBeenCalled();
    expect(channel.size()).toBe(0);
  });

  it('removes its abort listener once the request settles', async () => {
    const { channel } = createChannel();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = channel.request(
      { id: 'req-settled', kind: 'fast' },
      { signal: controller.signal }
    );
    channel.accept({ id: 'req-settled', type: 'result' });
    await pending;

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects a duplicate request id instead of overwriting the in-flight request', async () => {
    const { channel, send } = createChannel();

    const first = channel.request({ id: 'req-dup', kind: 'fast' });
    await expect(channel.request({ id: 'req-dup', kind: 'fast' })).rejects.toThrow(
      'Test host request req-dup is already in flight.'
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(channel.has('req-dup')).toBe(true);

    channel.accept({ id: 'req-dup', type: 'result', value: 'first' });
    await expect(first).resolves.toMatchObject({ value: 'first' });
  });

  it('rejects with a wrapped send failure that preserves the cause and leaves nothing pending', async () => {
    const sendError = new Error('webContents unavailable');
    const { channel } = createChannel({
      send: () => {
        throw sendError;
      },
    });

    await expect(channel.request({ id: 'req-send', kind: 'fast' })).rejects.toMatchObject({
      cause: sendError,
      message: 'Test host request req-send could not be sent: webContents unavailable',
    });
    expect(channel.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('describes a non-Error send failure without a detail suffix', async () => {
    const { channel } = createChannel({
      send: () => {
        // biome-ignore lint/style/useThrowOnlyError: exercising the non-Error transport failure path
        throw 'plain string failure';
      },
    });

    await expect(channel.request({ id: 'req-send-plain', kind: 'fast' })).rejects.toThrow(
      'Test host request req-send-plain could not be sent.'
    );
  });

  it('logs a late response at warn by default instead of dropping it silently', async () => {
    const { channel } = createChannel();

    const pending = observe(channel.request({ id: 'req-late', kind: 'fast' }));
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeInstanceOf(Error);

    channel.accept({ id: 'req-late', type: 'result', value: 'too late' });

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Test host response arrived for a request that is no longer pending',
      expect.objectContaining({ requestId: 'req-late', role: 'Test host' })
    );
  });

  it('never invokes a settled onProgress, and does not warn per trailing frame', async () => {
    const { channel } = createChannel();
    const onProgress = vi.fn();

    const pending = observe(
      channel.request({ id: 'req-late-progress', kind: 'fast' }, { onProgress })
    );
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    // The timeout itself warns once; the trailing frames are what must not.
    loggerWarnMock.mockClear();

    // A streaming host still has frames in flight when its request is
    // cancelled or expires. That is expected, not a correlation fault, so one
    // abandoned request must not produce one warning per frame.
    for (let index = 0; index < 4; index += 1) {
      channel.accept({ id: 'req-late-progress', type: 'progress' });
    }

    expect(onProgress).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(loggerDebugMock).toHaveBeenCalledTimes(4);
  });

  it('never routes trailing progress to the adapter ledger, only terminal responses', async () => {
    const onLateResponse = vi.fn<(requestId: string, response: TestResponse) => void>();
    const { channel } = createChannel({ onLateResponse });

    const pending = observe(channel.request({ id: 'req-trailing', kind: 'fast' }));
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    channel.accept({ id: 'req-trailing', type: 'progress' });
    expect(onLateResponse).not.toHaveBeenCalled();

    // The ledger exists to reason about answers, so a terminal response still
    // reaches it.
    const late: TestResponse = { id: 'req-trailing', type: 'result' };
    channel.accept(late);
    expect(onLateResponse).toHaveBeenCalledWith('req-trailing', late);
  });

  it('routes late responses to onLateResponse when the adapter owns a ledger', async () => {
    const onLateResponse = vi.fn<(requestId: string, response: TestResponse) => void>();
    const { channel } = createChannel({ onLateResponse });

    const pending = observe(channel.request({ id: 'req-ledger', kind: 'fast' }));
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    const late: TestResponse = { id: 'req-ledger', type: 'result' };
    channel.accept(late);

    expect(onLateResponse).toHaveBeenCalledWith('req-ledger', late);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('rejectAll rejects every in-flight request with a shared Error and clears their timers', async () => {
    const { channel } = createChannel();
    const reason = new Error('host gone');

    const first = observe(channel.request({ id: 'req-a', kind: 'fast' }));
    const second = observe(channel.request({ id: 'req-b', kind: 'slow' }));
    channel.rejectAll(reason);

    await expect(first).resolves.toBe(reason);
    await expect(second).resolves.toBe(reason);
    expect(channel.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('rejectAll mints a fresh Error per request when given a factory', async () => {
    const { channel } = createChannel();

    const first = observe(channel.request({ id: 'req-a', kind: 'fast' }));
    const second = observe(channel.request({ id: 'req-b', kind: 'fast' }));
    channel.rejectAll((requestId) => new Error(`stopped (request ${requestId})`));

    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError).toBeInstanceOf(Error);
    expect(secondError).toBeInstanceOf(Error);
    expect(firstError).not.toBe(secondError);
    expect(firstError).toMatchObject({ message: 'stopped (request req-a)' });
    expect(secondError).toMatchObject({ message: 'stopped (request req-b)' });
  });

  it('rejectAll is a no-op with nothing pending', () => {
    const { channel } = createChannel();
    expect(() => channel.rejectAll(new Error('nothing'))).not.toThrow();
  });

  it('hands the adapter a timeout context and rejects with the error it decides on', async () => {
    const contexts: HostRequestTimeoutContext[] = [];
    const { channel } = createChannel({
      onTimeout: (request, context) => {
        contexts.push(context);
        return { error: new Error(`custom timeout for ${request.id}`), policy: 'abandon' };
      },
    });

    const pending = observe(channel.request({ id: 'req-custom', kind: 'fast' }));
    const other = observe(channel.request({ id: 'req-other', kind: 'slow' }));
    await vi.advanceTimersByTimeAsync(20);
    channel.accept({ id: 'req-custom', type: 'progress' });
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toMatchObject({ message: 'custom timeout for req-custom' });
    expect(contexts).toEqual([
      {
        pendingCount: 2,
        progressCount: 1,
        requestId: 'req-custom',
        startedAt: expect.any(Number),
        timedOutAt: expect.any(Number),
        timeoutMs: 50,
      },
    ]);
    expect(contexts[0]?.timedOutAt).toBe((contexts[0]?.startedAt ?? 0) + 70);
    expect(channel.has('req-other')).toBe(true);
    channel.rejectAll(new Error('cleanup'));
    await other;
  });

  it('terminate policy rejects the timed-out request and every other request, then terminates with the channel already drained', async () => {
    let pendingCountAtTerminate = -1;
    let pendingCountAtDecision = -1;
    const terminate = vi.fn((_error: Error) => {
      pendingCountAtTerminate = channel.size();
    });
    const { channel } = createChannel({
      onTimeout: (request, context) => {
        pendingCountAtDecision = context.pendingCount;
        return {
          error: new Error(`transaction ${request.id} timed out`),
          policy: 'terminate',
          terminate,
        };
      },
    });

    const timedOut = observe(channel.request({ id: 'tx-1', kind: 'fast' }));
    const victim = observe(channel.request({ id: 'tx-2', kind: 'slow' }));
    await vi.advanceTimersByTimeAsync(50);

    const [timedOutError, victimError] = await Promise.all([timedOut, victim]);
    expect(timedOutError).toMatchObject({ message: 'transaction tx-1 timed out' });
    expect(victimError).toBe(timedOutError);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(timedOutError);
    expect(pendingCountAtDecision).toBe(2);
    expect(pendingCountAtTerminate).toBe(0);
    // The victim's own deadline was cleared with it: nothing fires later.
    await vi.advanceTimersByTimeAsync(1000);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('rejects the request with the adapter error when onTimeout itself throws, leaving nothing pending', async () => {
    const { channel } = createChannel({
      onTimeout: () => {
        throw new Error('ledger exploded');
      },
    });

    const pending = observe(channel.request({ id: 'req-throwing', kind: 'fast' }));
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toMatchObject({ message: 'ledger exploded' });
    expect(channel.size()).toBe(0);
  });
  it('logs and settles when the terminate hook throws instead of escaping the timer callback', async () => {
    const terminateFailure = new Error('kill failed: the host is already gone');
    const { channel } = createChannel({
      onTimeout: (request) => ({
        error: new Error(`transaction ${request.id} timed out`),
        policy: 'terminate',
        terminate: () => {
          throw terminateFailure;
        },
      }),
    });

    const timedOut = observe(channel.request({ id: 'tx-throw', kind: 'fast' }));
    await vi.advanceTimersByTimeAsync(50);

    await expect(timedOut).resolves.toMatchObject({ message: 'transaction tx-throw timed out' });
    expect(channel.size()).toBe(0);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Test host terminate hook failed while handling a request timeout',
      expect.objectContaining({ error: terminateFailure, requestId: 'tx-throw', role: 'Test host' })
    );
  });

  it('isolates a throwing onLateResponse so the transport listener keeps working', async () => {
    const hookFailure = new Error('ledger lookup failed');
    const onLateResponse = vi.fn((): void => {
      throw hookFailure;
    });
    const { channel } = createChannel({ onLateResponse });

    const pending = observe(channel.request({ id: 'req-late-throws', kind: 'fast' }));
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(() => {
      channel.accept({ id: 'req-late-throws', type: 'result' });
    }).not.toThrow();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Test host late-response hook failed',
      expect.objectContaining({
        error: hookFailure,
        requestId: 'req-late-throws',
        role: 'Test host',
      })
    );
  });

  it('isolates a throwing onProgress and still re-arms the deadline', async () => {
    const hookFailure = new Error('progress forwarding failed');
    const onProgress = vi.fn((): void => {
      throw hookFailure;
    });
    const { channel } = createChannel();

    const pending = observe(
      channel.request({ id: 'req-progress-throws', kind: 'fast' }, { onProgress })
    );
    await vi.advanceTimersByTimeAsync(30);

    expect(() => {
      channel.accept({ id: 'req-progress-throws', type: 'progress' });
    }).not.toThrow();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Test host progress hook failed',
      expect.objectContaining({
        error: hookFailure,
        requestId: 'req-progress-throws',
        role: 'Test host',
      })
    );

    // The re-arm happens before the hook runs, so a throwing consumer cannot
    // shorten the deadline: the original 50ms window has passed by now.
    await vi.advanceTimersByTimeAsync(30);
    expect(channel.has('req-progress-throws')).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toMatchObject({
      message: 'Test host request req-progress-throws timed out after 50ms.',
    });
  });
});
