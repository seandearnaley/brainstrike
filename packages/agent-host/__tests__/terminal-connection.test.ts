import { describe, expect, it, vi } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostMethodHandler } from '../src/auth-connection.js';
import type { HostClientOrigin, HostTerminalSession, HostTerminals } from '../src/ports.js';
import { type HostMethod, TERMINAL_EVENT, type TerminalEvent } from '../src/protocol.js';
import { bindHostTerminalMethods } from '../src/terminal-connection.js';

function bound(terminals: HostTerminals, origin: HostClientOrigin) {
  const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
  const handle: HostMethodHandler = (method, request) => {
    handlers.set(
      method,
      async (params) => await request(params as never, new AbortController().signal)
    );
  };
  const sendNotification = vi.fn(async () => undefined);
  const binding = bindHostTerminalMethods(
    handle,
    { dispose: vi.fn(), sendNotification } as unknown as MessageConnection,
    terminals,
    origin
  );
  return { binding, handlers, sendNotification };
}

function terminals() {
  let push: (event: TerminalEvent) => void = () => undefined;
  const close = vi.fn(async () => undefined);
  const session: HostTerminalSession = {
    close,
    'terminal/create': vi.fn(async () => ({
      ok: true as const,
      value: { cwd: '/repo', terminalId: 'pty-1' },
    })),
    'terminal/destroy': vi.fn(async () => ({ ok: true as const, value: null })),
    'terminal/resize': vi.fn(async () => ({ ok: true as const, value: null })),
    'terminal/write': vi.fn(async () => ({ ok: true as const, value: null })),
  };
  const open = vi.fn((send: (event: TerminalEvent) => void) => {
    push = send;
    return session;
  });
  const owner: HostTerminals = {
    'command-sessions/list': vi.fn(async () => ({
      ok: true as const,
      value: { rootId: 'root', sessions: [] },
    })),
    'command-sessions/read': vi.fn(),
    'command-sessions/remove': vi.fn(),
    'command-sessions/stop': vi.fn(),
    'command-sessions/write': vi.fn(),
    open,
  };
  return { close, open, owner, push: (event: TerminalEvent) => push(event) };
}

/** ADR-0029 stage 3: the Terminal panel is the desktop user's, one connection at a time. */
describe('host terminal methods', () => {
  it('opens one terminal session per connection, streams it, and ends it with the connection', async () => {
    const service = terminals();
    const { binding, handlers, sendNotification } = bound(service.owner, 'desktop-ui');

    await expect(handlers.get('terminal/create')?.({ rootId: 'root' })).resolves.toEqual({
      ok: true,
      value: { cwd: '/repo', terminalId: 'pty-1' },
    });
    await handlers.get('terminal/write')?.({ data: 'ls\r', terminalId: 'pty-1' });
    service.push({ data: 'README.md', terminalId: 'pty-1', type: 'data' });
    binding.dispose();

    expect(service.open).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledWith(TERMINAL_EVENT, {
      data: 'README.md',
      terminalId: 'pty-1',
      type: 'data',
    });
    expect(service.close).toHaveBeenCalledOnce();
  });

  it('refuses every terminal and command-session method to a public-socket client', async () => {
    const service = terminals();
    const { handlers } = bound(service.owner, 'public-socket');

    for (const method of [
      'command-sessions/list',
      'command-sessions/read',
      'command-sessions/remove',
      'command-sessions/stop',
      'command-sessions/write',
      'terminal/create',
      'terminal/destroy',
      'terminal/resize',
      'terminal/write',
    ] as const) {
      await expect(handlers.get(method)?.({})).rejects.toThrow(
        "Terminals are available only to the desktop's private client"
      );
    }
    expect(service.open).not.toHaveBeenCalled();
    expect(service.owner['command-sessions/list']).not.toHaveBeenCalled();
  });
});
