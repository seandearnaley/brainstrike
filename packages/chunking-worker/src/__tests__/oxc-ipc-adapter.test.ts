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
  addEventListener: (type: 'message', listener: MessageListener) => void;
  emit: (data: unknown) => void;
  postMessage: ReturnType<typeof vi.fn<(m: PostedMessage) => void>>;
}

function installFakeSelf(): FakeWorkerSelf {
  const listeners: MessageListener[] = [];
  const fake: FakeWorkerSelf = {
    addEventListener: (type, listener) => {
      if (type === 'message') {
        listeners.push(listener);
      }
    },
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

    void oxcIpcAdapter.parse('a', baseOptions);
    void oxcIpcAdapter.parse('b', baseOptions);

    const id1 = (fakeSelf.postMessage.mock.calls[0]?.[0] as { requestId: string }).requestId;
    const id2 = (fakeSelf.postMessage.mock.calls[1]?.[0] as { requestId: string }).requestId;
    expect(id1).not.toBe(id2);
  });

  it('uses crypto.randomUUID-backed oxc-ipc requestIds', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    void oxcIpcAdapter.parse('const x = 1', baseOptions);

    const sent = fakeSelf.postMessage.mock.calls[0]?.[0] as { requestId: string };
    expect(sent.requestId).toMatch(
      /^oxc-ipc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
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
