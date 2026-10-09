import { describe, expect, it, vi } from 'vitest';
import {
  CommandSessionError,
  type CommandSessionManager,
} from '../assistant-server/command-session-manager';
import {
  createCommandSessionIpcHandlers,
  withHostCommandSessions,
} from '../command-session-ipc-handlers';

function createManager(): CommandSessionManager {
  return {
    dispose: vi.fn(async () => 0),
    disposeRoot: vi.fn(async () => 0),
    get: vi.fn(),
    list: vi.fn(() => [
      {
        createdAt: 1,
        cwd: '/repo',
        id: 'session-1',
        pid: 42,
        rootId: 'root-1',
        status: 'running' as const,
      },
    ]),
    read: vi.fn(() => ({
      bufferStartCursor: 0,
      hasMore: true,
      nextCursor: 32_768,
      output: 'a'.repeat(32_768),
      requestedCursor: 0,
      truncatedBeforeCursor: false,
    })),
    remove: vi.fn(async () => undefined),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    stopDelegatedThreads: vi.fn(async () => undefined),
    write: vi.fn(),
  };
}

describe('command session IPC handlers', () => {
  it('lists only the requested workspace root', () => {
    const manager = createManager();
    const handlers = createCommandSessionIpcHandlers({ manager });

    expect(handlers.list({ rootId: 'root-1' })).toEqual({
      ok: true,
      value: expect.objectContaining({ sessions: [expect.objectContaining({ id: 'session-1' })] }),
    });
    expect(manager.list).toHaveBeenCalledWith('root-1');
  });

  it('returns a bounded advancing output page', () => {
    const manager = createManager();
    const handlers = createCommandSessionIpcHandlers({ manager });

    const result = handlers.read({ cursor: 0, rootId: 'root-1', sessionId: 'session-1' });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        hasMore: true,
        nextCursor: 32_768,
        output: 'a'.repeat(32_768),
      }),
    });
    expect(JSON.stringify(result).length).toBeLessThan(34_000);
    expect(manager.read).toHaveBeenCalledWith('root-1', 'session-1', 0, 32_768);
  });

  it('fails loudly when the manager violates the IPC page ceiling', () => {
    const manager = createManager();
    vi.mocked(manager.read).mockReturnValueOnce({
      bufferStartCursor: 0,
      hasMore: false,
      nextCursor: 32_769,
      output: 'x'.repeat(32_769),
      requestedCursor: 0,
      truncatedBeforeCursor: false,
    });
    const handlers = createCommandSessionIpcHandlers({ manager });

    expect(handlers.read({ cursor: 0, rootId: 'root-1', sessionId: 'session-1' })).toEqual({
      error: {
        code: 'internal',
        message: 'Command-session manager returned an oversized IPC page.',
      },
      ok: false,
    });
  });

  it('preserves the manager live-tail cursor', () => {
    const manager = createManager();
    vi.mocked(manager.read).mockReturnValueOnce({
      bufferStartCursor: 10,
      hasMore: false,
      nextCursor: 90,
      output: '',
      requestedCursor: -1,
      truncatedBeforeCursor: false,
    });
    const handlers = createCommandSessionIpcHandlers({ manager });

    expect(handlers.read({ cursor: -1, rootId: 'root-1', sessionId: 'session-1' })).toEqual({
      ok: true,
      value: expect.objectContaining({ hasMore: false, nextCursor: 90, output: '' }),
    });
  });

  it('surfaces typed manager failures without throwing across IPC', async () => {
    const manager = createManager();
    vi.mocked(manager.stop).mockRejectedValueOnce(
      new CommandSessionError('session-not-found', 'No command session "missing".')
    );
    const handlers = createCommandSessionIpcHandlers({ manager });

    await expect(handlers.stop({ rootId: 'wrong-root', sessionId: 'missing' })).resolves.toEqual({
      error: { code: 'session-not-found', message: 'No command session "missing".' },
      ok: false,
    });
  });

  it('delegates write, stop, and remove with the owning root', async () => {
    const manager = createManager();
    const handlers = createCommandSessionIpcHandlers({ manager });

    expect(handlers.write({ data: 'y\n', rootId: 'root-1', sessionId: 'session-1' })).toEqual({
      ok: true,
    });
    await expect(handlers.stop({ rootId: 'root-1', sessionId: 'session-1' })).resolves.toEqual({
      ok: true,
    });
    await expect(handlers.remove({ rootId: 'root-1', sessionId: 'session-1' })).resolves.toEqual({
      ok: true,
    });
    expect(manager.write).toHaveBeenCalledWith('root-1', 'session-1', 'y\n');
    expect(manager.stop).toHaveBeenCalledWith('root-1', 'session-1');
    expect(manager.remove).toHaveBeenCalledWith('root-1', 'session-1');
  });

  it('keeps Main’s own answer when no agent host is connected, and asks the host for a session Main lacks', async () => {
    const manager = createManager();
    vi.mocked(manager.stop).mockRejectedValue(
      new CommandSessionError('session-not-found', 'No command session "host-session".')
    );
    const host = {
      list: vi.fn(),
      read: vi.fn(),
      remove: vi.fn(),
      stop: vi.fn(async () => ({ ok: true as const })),
      write: vi.fn(),
    };
    let connected: typeof host | undefined;
    const panel = withHostCommandSessions(
      createCommandSessionIpcHandlers({ manager }),
      () => connected
    );
    const identity = { rootId: 'root-1', sessionId: 'host-session' };

    await expect(panel.stop(identity)).resolves.toMatchObject({
      error: { code: 'session-not-found' },
      ok: false,
    });
    await expect(panel.list({ rootId: 'root-1' })).resolves.toMatchObject({
      ok: true,
      value: { sessions: [expect.objectContaining({ id: 'session-1' })] },
    });
    connected = host;
    await expect(panel.stop(identity)).resolves.toEqual({ ok: true });
    expect(host.stop).toHaveBeenCalledWith(identity);
  });
});
