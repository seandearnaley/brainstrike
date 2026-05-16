/**
 * Contract tests for the oxc-IPC parser adapter (Phase 4 Cycle 4.4).
 *
 * Mocks the dynamic `import('electron')` to provide a fake `ipcRenderer`
 * with a controllable `invoke` mock. Verifies the adapter:
 *   - identifies as 'oxc-native'
 *   - sends correctly-shaped requests via IPC
 *   - returns the AstNode on success
 *   - throws on failure responses, malformed responses, missing renderer
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 4)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: invokeMock,
  },
}));

const baseOptions = {
  errorRecovery: true,
  jsx: false,
  language: 'javascript',
} as const;

beforeEach(async () => {
  invokeMock.mockReset();
  // Reset the adapter's lazy-loaded renderer cache between tests so each
  // test sees a fresh import('electron') chain with the current invokeMock.
  const { __resetIpcRendererCacheForTesting } = await import('../parsers/oxc-ipc-adapter');
  __resetIpcRendererCacheForTesting();
});

afterEach(() => {
  vi.resetModules();
});

describe('oxcIpcAdapter', () => {
  it('identifies itself as oxc-native', async () => {
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    expect(oxcIpcAdapter.id).toBe('oxc-native');
  });

  it('sends a correctly-shaped request to the parser-host:parse channel', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      requestId: 'whatever',
      root: { type: 'Program' },
    });
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    await oxcIpcAdapter.parse('const x = 1', baseOptions);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = invokeMock.mock.calls[0] ?? [];
    expect(channel).toBe('parser-host:parse');
    expect(payload).toMatchObject({
      content: 'const x = 1',
      options: baseOptions,
    });
    expect(typeof (payload as { requestId?: unknown }).requestId).toBe('string');
  });

  it('returns the root AstNode on a success response', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      requestId: 'r-1',
      root: { type: 'Program', start: 0, end: 11 },
    });
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    const result = await oxcIpcAdapter.parse('const x = 1', baseOptions);

    expect(result.type).toBe('Program');
    expect(result.start).toBe(0);
  });

  it('throws when the host returns a failure response', async () => {
    invokeMock.mockResolvedValue({ ok: false, requestId: 'r-2', error: 'oxc died' });
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    await expect(oxcIpcAdapter.parse('const x = 1', baseOptions)).rejects.toThrow(/oxc died/);
  });

  it('throws when the host returns a malformed response', async () => {
    invokeMock.mockResolvedValue({ surprise: 'no requestId or ok' });
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    await expect(oxcIpcAdapter.parse('const x = 1', baseOptions)).rejects.toThrow(/malformed/i);
  });

  it('generates unique requestIds across calls', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      requestId: 'echoed',
      root: { type: 'Program' },
    });
    const { oxcIpcAdapter } = await import('../parsers/oxc-ipc-adapter');

    await oxcIpcAdapter.parse('a', baseOptions);
    await oxcIpcAdapter.parse('b', baseOptions);

    const id1 = (invokeMock.mock.calls[0]?.[1] as { requestId: string }).requestId;
    const id2 = (invokeMock.mock.calls[1]?.[1] as { requestId: string }).requestId;
    expect(id1).not.toBe(id2);
  });
});
