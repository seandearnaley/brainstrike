/**
 * Contract tests for the oxc-IPC parser adapter (Phase 4 Cycle 4.4).
 *
 * The adapter runs inside a Web Worker and bridges parse requests to its
 * parent renderer via `self.postMessage` (which the renderer routes to the
 * Electron main process via the contextBridge-exposed `window.parserHost`).
 *
 * These tests install a fake `self` on globalThis that captures
 * postMessage calls and lets the test simulate reply messages — the same
 * shape the renderer-side bridge would produce in production.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 4)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PostedMessage {
  payload?: unknown;
  requestId: string;
  type: string;
}
type MessageListener = (event: { data?: unknown }) => void;

interface FakeWorkerSelf {
  addEventListener: ReturnType<typeof vi.fn<(type: 'message', listener: MessageListener) => void>>;
  emit: (data: unknown) => void;
  postMessage: ReturnType<typeof vi.fn<(m: PostedMessage) => void>>;
}

function installFakeSelf(): FakeWorkerSelf {
  const listeners: MessageListener[] = [];
  const fake: FakeWorkerSelf = {
    addEventListener: vi.fn((type, listener) => {
      if (type === 'message') {
        listeners.push(listener);
      }
    }),
    emit: (data: unknown) => {
      for (const l of listeners) {
        l({ data });
      }
    },
    postMessage: vi.fn(),
  };
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: fake,
    writable: true,
  });
  // Ensure `window` !== `self` so the adapter's worker-context heuristic
  // recognizes this as a worker realm.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: undefined,
    writable: true,
  });
  return fake;
}

function restoreSelf(): void {
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: undefined,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

const baseOptions = {
  errorRecovery: true,
  jsx: false,
  language: 'javascript',
} as const;

let fakeSelf: FakeWorkerSelf;

beforeEach(async () => {
  fakeSelf = installFakeSelf();
  const { __resetIpcAdapterForTesting } = await import('../parsers/oxc-ipc-adapter');
  __resetIpcAdapterForTesting();
});

afterEach(() => {
  restoreSelf();
  vi.resetModules();
});

describe('oxcIpcAdapter', () => {
  it('releases its timer immediately when postMessage throws synchronously', async () => {
    vi.useFakeTimers();
    const sendError = new Error('worker send failed');
    fakeSelf.postMessage.mockImplementation(() => {
      throw sendError;
    });
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');
    try {
      await expect(oxcIpcAdapter.parse('source', baseOptions)).rejects.toBe(sendError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      const { __resetIpcAdapterForTesting } = await import('../parsers/oxc-ipc-adapter');
      __resetIpcAdapterForTesting();
      vi.useRealTimers();
    }
  });

  it('ignores mismatched inner request ids and accepts a later valid response', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');
    const attempt = oxcIpcAdapter.parse('source', baseOptions);
    const sent = fakeSelf.postMessage.mock.calls[0]?.[0];
    if (!sent) {
      throw new Error('parse did not post');
    }
    const wrongRoot = { type: 'WrongProgram' };
    const validRoot = { type: 'Program' };
    fakeSelf.emit({
      requestId: sent.requestId,
      response: { ok: true, requestId: 'different-request', root: wrongRoot },
      type: 'parser-host:reply',
    });
    fakeSelf.emit({
      requestId: sent.requestId,
      response: { ok: true, requestId: sent.requestId, root: validRoot },
      type: 'parser-host:reply',
    });
    await expect(attempt).resolves.toBe(validRoot);
  });

  it('preserves array envelope, response and opaque root identity', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');
    const attempt = oxcIpcAdapter.parse('source', baseOptions);
    const requestId = fakeSelf.postMessage.mock.calls[0]?.[0].requestId;
    const root = Object.assign([], { sentinel: 'original' });
    const response = Object.assign([], { ok: true, requestId, root });
    fakeSelf.emit(Object.assign([], { requestId, response, type: 'parser-host:reply' }));
    await expect(attempt).resolves.toBe(root);
  });

  it('retains synchronous success before a subsequent postMessage throw', async () => {
    vi.useFakeTimers();
    const root = { type: 'Program' };
    fakeSelf.postMessage.mockImplementation(({ requestId }) => {
      fakeSelf.emit({
        requestId,
        response: { ok: true, requestId, root },
        type: 'parser-host:reply',
      });
      throw new Error('after reply');
    });
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');
    try {
      const attempt = oxcIpcAdapter.parse('source', baseOptions);
      expect(fakeSelf.postMessage).toHaveBeenCalledTimes(1);
      await expect(attempt).resolves.toBe(root);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains synchronous host failure before a subsequent postMessage throw', async () => {
    vi.useFakeTimers();
    fakeSelf.postMessage.mockImplementation(({ requestId }) => {
      fakeSelf.emit({
        requestId,
        response: { error: 'first failure', ok: false, requestId },
        type: 'parser-host:reply',
      });
      throw new Error('after reply');
    });
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');
    try {
      await expect(oxcIpcAdapter.parse('source', baseOptions)).rejects.toThrow(
        'oxc-ipc-adapter: parser host failure: first failure'
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out normally after mismatched and malformed responses', async () => {
    vi.useFakeTimers();
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');
    try {
      const attempt = oxcIpcAdapter.parse('source', baseOptions);
      const requestId = fakeSelf.postMessage.mock.calls[0]?.[0].requestId;
      const rejection = expect(attempt).rejects.toThrow('oxc-ipc-adapter: timeout after 30000ms');
      for (const response of [
        null,
        { ok: true, requestId, root: null },
        { ok: false, requestId },
        { ok: 'true', requestId, root: {} },
        { ok: true, requestId: 'mismatch', root: {} },
      ]) {
        fakeSelf.emit({ requestId, response, type: 'parser-host:reply' });
      }
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates concurrent out-of-order replies, failed sends and late replies', async () => {
    vi.useFakeTimers();
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');
    const sendError = new Error('third send');
    fakeSelf.postMessage
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw sendError;
      });
    try {
      const first = oxcIpcAdapter.parse('first', baseOptions);
      const second = oxcIpcAdapter.parse('second', baseOptions);
      const third = oxcIpcAdapter.parse('third', baseOptions);
      await expect(third).rejects.toBe(sendError);
      expect(vi.getTimerCount()).toBe(2);
      const ids = fakeSelf.postMessage.mock.calls.map(([message]) => message.requestId);
      const firstRoot = { sentinel: 'first' };
      const secondRoot = { sentinel: 'second' };
      const reply = (requestId: string | undefined, root: object): void => {
        fakeSelf.emit({
          requestId,
          response: { ok: true, requestId, root },
          type: 'parser-host:reply',
        });
      };
      reply(ids[2], { sentinel: 'late failed send' });
      reply(ids[1], secondRoot);
      await expect(second).resolves.toBe(secondRoot);
      expect(vi.getTimerCount()).toBe(1);
      reply(ids[1], { sentinel: 'duplicate' });
      reply(ids[0], firstRoot);
      await expect(first).resolves.toBe(firstRoot);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the exact owned timer on success and retains one shared listener', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');
    try {
      for (const content of ['first', 'second']) {
        const attempt = oxcIpcAdapter.parse(content, baseOptions);
        const handle = timers.mock.results.at(-1)?.value;
        const requestId = fakeSelf.postMessage.mock.calls.at(-1)?.[0].requestId;
        const root = { content };
        fakeSelf.emit({
          requestId,
          response: { ok: true, requestId, root },
          type: 'parser-host:reply',
        });
        await expect(attempt).resolves.toBe(root);
        expect(clear).toHaveBeenCalledWith(handle);
      }
      expect(fakeSelf.addEventListener).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timers.mockRestore();
      clear.mockRestore();
      vi.useRealTimers();
    }
  });

  it('identifies itself as oxc-native', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    expect(oxcIpcAdapter.id).toBe('oxc-native');
  });

  it('posts a parser-host:invoke envelope with the correct payload', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    const parsePromise = oxcIpcAdapter.parse('const x = 1', baseOptions);

    // Capture the invoke envelope sent to the parent.
    expect(fakeSelf.postMessage).toHaveBeenCalledTimes(1);
    const sent = fakeSelf.postMessage.mock.calls[0]?.[0] as {
      type: string;
      requestId: string;
      payload: { content: string; options: typeof baseOptions; requestId: string };
    };
    expect(sent.type).toBe('parser-host:invoke');
    expect(sent.payload.content).toBe('const x = 1');
    expect(sent.payload.options).toEqual(baseOptions);
    expect(typeof sent.requestId).toBe('string');
    expect(sent.payload.requestId).toBe(sent.requestId);

    // Now simulate the renderer replying with success.
    fakeSelf.emit({
      requestId: sent.requestId,
      response: { ok: true, requestId: sent.requestId, root: { type: 'Program' } },
      type: 'parser-host:reply',
    });

    const result = await parsePromise;
    expect(result.type).toBe('Program');
  });

  it('rejects when the renderer replies with a failure response', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    const parsePromise = oxcIpcAdapter.parse('const x = 1', baseOptions);
    const sent = fakeSelf.postMessage.mock.calls[0]?.[0] as { requestId: string };

    fakeSelf.emit({
      requestId: sent.requestId,
      response: { error: 'oxc died', ok: false, requestId: sent.requestId },
      type: 'parser-host:reply',
    });

    await expect(parsePromise).rejects.toThrow(/oxc died/);
  });

  it('ignores reply messages for unknown requestIds', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    const parsePromise = oxcIpcAdapter.parse('const x = 1', baseOptions);
    const sent = fakeSelf.postMessage.mock.calls[0]?.[0] as { requestId: string };

    // Spurious reply for an unrelated requestId — should not resolve our promise.
    fakeSelf.emit({
      requestId: 'someone-elses-request',
      response: { ok: true, requestId: 'someone-elses-request', root: { type: 'Program' } },
      type: 'parser-host:reply',
    });

    // Now the real reply.
    fakeSelf.emit({
      requestId: sent.requestId,
      response: {
        ok: true,
        requestId: sent.requestId,
        root: { sentinel: 'real', type: 'Program' },
      },
      type: 'parser-host:reply',
    });

    const result = await parsePromise;
    expect((result as { sentinel?: string }).sentinel).toBe('real');
  });

  it('ignores non-reply messages on the same worker channel', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    const parsePromise = oxcIpcAdapter.parse('const x = 1', baseOptions);
    const sent = fakeSelf.postMessage.mock.calls[0]?.[0] as { requestId: string };

    // The chunking worker has its own message types (init, chunk-file, etc.) —
    // those should not be misinterpreted as parser-host replies.
    fakeSelf.emit({ type: 'init' });
    fakeSelf.emit({ chunks: [], type: 'chunking:result' });
    fakeSelf.emit('totally not an envelope');

    // Real reply still resolves.
    fakeSelf.emit({
      requestId: sent.requestId,
      response: { ok: true, requestId: sent.requestId, root: { type: 'Program' } },
      type: 'parser-host:reply',
    });

    const result = await parsePromise;
    expect(result.type).toBe('Program');
  });

  it('rejects with a clear error when not running in a worker realm', async () => {
    // Reinstall fake self where `window` === `self` (renderer main thread shape).
    restoreSelf();
    const sharedSelf = { addEventListener: vi.fn(), postMessage: vi.fn() };
    Object.defineProperty(globalThis, 'self', {
      configurable: true,
      value: sharedSelf,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: sharedSelf,
      writable: true,
    });
    vi.resetModules();
    const { oxcIpcAdapter, __resetIpcAdapterForTesting } = await import(
      '../parsers/oxc-ipc-adapter'
    );
    __resetIpcAdapterForTesting();

    await expect(oxcIpcAdapter.parse('const x = 1', baseOptions)).rejects.toThrow(
      /parent worker scope not detected/
    );
  });

  it('generates unique requestIds across calls', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    const first = oxcIpcAdapter.parse('a', baseOptions);
    const second = oxcIpcAdapter.parse('b', baseOptions);

    const id1 = (fakeSelf.postMessage.mock.calls[0]?.[0] as { requestId: string } | undefined)
      ?.requestId;
    const id2 = (fakeSelf.postMessage.mock.calls[1]?.[0] as { requestId: string } | undefined)
      ?.requestId;
    expect(id1).not.toBe(id2);
    for (const requestId of [id1, id2]) {
      fakeSelf.emit({
        requestId,
        response: { ok: true, requestId, root: {} },
        type: 'parser-host:reply',
      });
    }
    await Promise.all([first, second]);
  });

  it('uses crypto.randomUUID-backed oxc-ipc requestIds', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    const attempt = oxcIpcAdapter.parse('const x = 1', baseOptions);

    const sent = fakeSelf.postMessage.mock.calls[0]?.[0] as { requestId: string };
    expect(sent.requestId).toMatch(
      /^oxc-ipc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    fakeSelf.emit({
      requestId: sent.requestId,
      response: { ok: true, requestId: sent.requestId, root: {} },
      type: 'parser-host:reply',
    });
    await attempt;
  });

  it('throws when crypto.randomUUID is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
      writable: true,
    });
    vi.resetModules();
    fakeSelf = installFakeSelf();
    const { oxcIpcAdapter, __resetIpcAdapterForTesting } = await import(
      '../parsers/oxc-ipc-adapter'
    );
    __resetIpcAdapterForTesting();

    try {
      expect(() => {
        void oxcIpcAdapter.parse('const x = 1', baseOptions);
      }).toThrow(/crypto\.randomUUID/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
        writable: true,
      });
    }
  });
});
