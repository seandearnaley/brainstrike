// @vitest-environment jsdom
import type { HostClient } from '@brainstrike/agent-host/browser';
import type { TerminalEvent } from '@brainstrike/agent-host/protocol';
import type { TerminalExitEvent } from '@brainstrike/app-shell/workspace-terminal-services';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopHostConnection } from '../../renderer/desktop-host-connection';
import { createDesktopWorkspaceTerminalServices } from '../../renderer/host-terminals';

// The window's real connector loads the browser JSON-RPC transport; each test injects its host.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

/** One agent host: its terminal event listener, and a way to stop it. */
function fakeHost() {
  let push: (event: TerminalEvent) => void = () => undefined;
  let stop: () => void = () => undefined;
  let created = 0;
  const host = {
    close: vi.fn(async () => undefined),
    closed: new Promise<void>((resolve) => {
      stop = resolve;
    }),
    onTerminal: vi.fn((listener: (event: TerminalEvent) => void) => {
      push = listener;
      return () => undefined;
    }),
    request: vi.fn(async () => {
      created += 1;
      return { ok: true, value: { cwd: '/repo', terminalId: `pty-${created}` } };
    }),
  } as unknown as HostClient;
  return { host, push: (event: TerminalEvent) => push(event), stop: () => stop() };
}

describe('desktop workspace terminals', () => {
  it('shows a terminal exited when its host ends, and starts the next one on the replacement', async () => {
    const first = fakeHost();
    const replacement = fakeHost();
    const hosts = [first.host, replacement.host];
    const connection = createDesktopHostConnection(async () => {
      const next = hosts.shift();
      if (!next) {
        throw new Error('No further agent host');
      }
      return next;
    });
    const { terminal } = createDesktopWorkspaceTerminalServices(connection);
    if (!terminal) {
      throw new Error('Desktop workspace terminal services have no terminal bridge');
    }
    const exits: TerminalExitEvent[] = [];
    const output: string[] = [];
    terminal.onExit((event) => exits.push(event));
    terminal.onData((event) => output.push(event.data));

    await expect(terminal.create({ rootId: 'root' })).resolves.toMatchObject({ ok: true });
    first.push({ data: '$ ', terminalId: 'pty-1', type: 'data' });
    first.stop();
    await vi.waitFor(() =>
      expect(exits).toEqual([{ exitCode: -1, signal: null, terminalId: 'pty-1' }])
    );
    await expect(terminal.create({ rootId: 'root' })).resolves.toMatchObject({
      value: { terminalId: 'pty-1' },
    });

    expect(output).toEqual(['$ ']);
    expect(replacement.host.request).toHaveBeenCalledWith('terminal/create', { rootId: 'root' });
  });
});
