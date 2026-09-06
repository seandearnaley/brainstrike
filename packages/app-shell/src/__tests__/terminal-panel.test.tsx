import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommandSessionBridge,
  CommandSessionInfo,
  CommandSessionReadPage,
  CommandSessionResult,
} from '../terminal-panel/command-session-bridge';
import { CommandSessionInventory } from '../terminal-panel/command-session-inventory';
import type {
  TerminalBridge,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResult,
} from '../terminal-panel/terminal-bridge';

// ── Controllable active-root + toast spies ────────────────────────────────────
const mockRoot: {
  handle: {
    kind: 'directory';
    name: string;
    path: string;
    platform: string;
    rootId?: string;
  } | null;
} = {
  handle: {
    kind: 'directory',
    name: 'repo',
    path: '/abs/repo',
    platform: 'electron',
    rootId: 'root-1',
  },
};

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    rootDirectoryHandle: mockRoot.handle,
    rootIdByPath: new Map<string, string>(),
  }),
}));

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    useToast: () => ({ dismiss: vi.fn(), toast: toastSpy, toasts: [] }),
  };
});

// xterm renders to a real canvas/DOM that jsdom cannot drive — mock it so the
// session wiring is asserted via the captured instance instead of pixels. The
// CSS import is a no-op in the test environment.
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

interface FakeTerminal {
  cols: number;
  dispose: ReturnType<typeof vi.fn>;
  /** Test helper: simulate the user typing into the terminal. */
  emitInput: (data: string) => void;
  focus: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  open: ReturnType<typeof vi.fn>;
  rows: number;
  write: ReturnType<typeof vi.fn>;
}

const terminals: FakeTerminal[] = [];
function lastTerminal(): FakeTerminal {
  const term = terminals.at(-1);
  if (!term) {
    throw new Error('no Terminal constructed');
  }
  return term;
}

vi.mock('@xterm/xterm', () => {
  // A real class so `new Terminal()` works (an arrow/`vi.fn` impl is not a
  // constructor here). Each instance is captured for assertions.
  class MockTerminal {
    cols = 80;
    rows = 24;
    open = vi.fn();
    write = vi.fn();
    loadAddon = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    private inputCb: ((data: string) => void) | null = null;
    onData(cb: (data: string) => void) {
      this.inputCb = cb;
      return { dispose: vi.fn() };
    }
    emitInput(data: string) {
      this.inputCb?.(data);
    }
    constructor() {
      terminals.push(this as unknown as FakeTerminal);
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    activate = vi.fn();
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  }
  return { FitAddon };
});

vi.mock('@xterm/addon-web-links', () => {
  class WebLinksAddon {
    activate = vi.fn();
  }
  return { WebLinksAddon };
});

import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { TerminalPanel } from '../terminal-panel/terminal-panel';

// ── Bridge fixtures ───────────────────────────────────────────────────────────
// `TerminalResult<T>` is a conditional type (void → no `value`), so build the
// value-carrying success shape directly rather than via the deferred generic.
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

let dataCallback: ((event: TerminalDataEvent) => void) | null = null;
let exitCallback: ((event: TerminalExitEvent) => void) | null = null;
const offData = vi.fn();
const offExit = vi.fn();
const resizeObserverDisconnect = vi.fn();

function installBridge(bridge: Partial<TerminalBridge> = {}): TerminalBridge {
  const full: TerminalBridge = {
    create: vi.fn(async () => ok({ cwd: '/abs/repo', terminalId: 'pty-1' })),
    destroy: vi.fn(async () => ({ ok: true }) as TerminalResult),
    onData: vi.fn((cb: (event: TerminalDataEvent) => void) => {
      dataCallback = cb;
      return offData;
    }),
    onExit: vi.fn((cb: (event: TerminalExitEvent) => void) => {
      exitCallback = cb;
      return offExit;
    }),
    resize: vi.fn(async () => ({ ok: true }) as TerminalResult),
    write: vi.fn(async () => ({ ok: true }) as TerminalResult),
    ...bridge,
  };
  (window as unknown as { terminal?: TerminalBridge }).terminal = full;
  return full;
}

function installCommandSessionBridge(
  bridge: Partial<CommandSessionBridge> = {}
): CommandSessionBridge {
  const full: CommandSessionBridge = {
    list: vi.fn(
      async (): Promise<
        CommandSessionResult<{ rootId: string; sessions: readonly CommandSessionInfo[] }>
      > => ({
        ok: true,
        value: {
          rootId: 'root-1',
          sessions: [
            {
              createdAt: 1,
              cwd: '/abs/repo/apps/web',
              id: 'command-session-1234567890',
              pid: 314,
              rootId: 'root-1',
              status: 'running',
            },
          ],
        },
      })
    ),
    read: vi.fn(
      async (): Promise<CommandSessionResult<CommandSessionReadPage>> => ({
        ok: true,
        value: {
          bufferStartCursor: 0,
          hasMore: false,
          nextCursor: 12,
          output: 'server ready\n',
          requestedCursor: 0,
          session: {
            createdAt: 1,
            cwd: '/abs/repo/apps/web',
            id: 'command-session-1234567890',
            pid: 314,
            rootId: 'root-1',
            status: 'running',
          },
          truncatedBeforeCursor: false,
        },
      })
    ),
    remove: vi.fn(async () => ({ ok: true }) as CommandSessionResult),
    stop: vi.fn(async () => ({ ok: true }) as CommandSessionResult),
    write: vi.fn(async () => ({ ok: true }) as CommandSessionResult),
    ...bridge,
  };
  (window as unknown as { commandSessions?: CommandSessionBridge }).commandSessions = full;
  return full;
}

describe('TerminalPanel', () => {
  beforeEach(() => {
    mockRoot.handle = {
      kind: 'directory',
      name: 'repo',
      path: '/abs/repo',
      platform: 'electron',
      rootId: 'root-1',
    };
    terminals.length = 0;
    dataCallback = null;
    exitCallback = null;
    toastSpy.mockReset();
    useTerminalTargetStore.getState().reset();
    offData.mockReset();
    offExit.mockReset();
    resizeObserverDisconnect.mockReset();
    // jsdom has no ResizeObserver — stub it so the session effect can observe.
    // `disconnect` is a spy (not a no-op) so unmount tests can prove the
    // observer this effect creates is actually torn down, not just replaced
    // by a fresh one next render.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {
        /* no-op */
      }
      disconnect() {
        resizeObserverDisconnect();
      }
      unobserve() {
        /* no-op */
      }
    };
  });

  afterEach(() => {
    Reflect.deleteProperty(window as unknown as { terminal?: TerminalBridge }, 'terminal');
    Reflect.deleteProperty(
      window as unknown as { commandSessions?: CommandSessionBridge },
      'commandSessions'
    );
    vi.clearAllMocks();
  });

  it('creates a pty for the active root and reaches the ready state', async () => {
    const bridge = installBridge();
    render(<TerminalPanel />);

    expect(await screen.findByTestId('terminal-panel')).toBeInTheDocument();
    await waitFor(() =>
      expect(bridge.create).toHaveBeenCalledWith(
        expect.objectContaining({ cols: 80, rootId: 'root-1', rows: 24 })
      )
    );
    // The captured Terminal was opened on the host element.
    await waitFor(() => expect(lastTerminal().open).toHaveBeenCalled());
  });

  it('writes pty onData chunks into the terminal', async () => {
    installBridge();
    render(<TerminalPanel />);
    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(dataCallback).not.toBeNull());

    dataCallback?.({ data: 'hello\r\n', terminalId: 'pty-1' });
    expect(lastTerminal().write).toHaveBeenCalledWith('hello\r\n');
  });

  it('ignores data events for a different terminalId', async () => {
    installBridge();
    render(<TerminalPanel />);
    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(dataCallback).not.toBeNull());

    dataCallback?.({ data: 'nope', terminalId: 'other-pty' });
    expect(lastTerminal().write).not.toHaveBeenCalledWith('nope');
  });

  it('sends user keystrokes to the pty via bridge.write', async () => {
    const bridge = installBridge();
    render(<TerminalPanel />);
    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(lastTerminal().focus).toHaveBeenCalled());

    lastTerminal().emitInput('ls\r');
    expect(bridge.write).toHaveBeenCalledWith({ data: 'ls\r', terminalId: 'pty-1' });
  });

  it('reassembles a surrogate pair split across two onData chunks (no replacement char)', async () => {
    installBridge();
    render(<TerminalPanel />);
    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(dataCallback).not.toBeNull());

    const emoji = '😀';
    const high = String.fromCharCode(emoji.charCodeAt(0));
    const low = String.fromCharCode(emoji.charCodeAt(1));

    // First event ends with the lone high surrogate.
    dataCallback?.({ data: `done ${high}`, terminalId: 'pty-1' });
    // Second event begins with its low half.
    dataCallback?.({ data: `${low}!`, terminalId: 'pty-1' });

    const writes = lastTerminal().write.mock.calls.map((call) => call[0] as string);
    // No write contains a replacement char, and the joined output is the emoji.
    expect(writes.join('')).toBe(`done ${emoji}!`);
    for (const written of writes) {
      expect(written).not.toContain('�');
    }
  });

  it('shows the exited state with a restart affordance when the pty exits', async () => {
    installBridge();
    render(<TerminalPanel />);
    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(exitCallback).not.toBeNull());

    exitCallback?.({ exitCode: 0, signal: null, terminalId: 'pty-1' });

    expect(await screen.findByTestId('terminal-panel-exited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart terminal' })).toBeInTheDocument();
  });

  it('shows an error state (not a blank panel) when create returns { ok:false }', async () => {
    installBridge({
      create: vi.fn(
        async (): Promise<TerminalResult<{ terminalId: string; cwd: string }>> => ({
          error: 'spawn failed',
          ok: false,
        })
      ),
    });
    render(<TerminalPanel />);

    expect(await screen.findByTestId('terminal-panel-error')).toBeInTheDocument();
    expect(screen.getByText('spawn failed')).toBeInTheDocument();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Terminal failed to start', variant: 'destructive' })
    );
  });

  it('silently retries create while the workspace root has not reconciled into the DB yet', async () => {
    // Right after boot the renderer can be interactive BEFORE roots
    // reconciliation lands the workspace row in the DB; the main process then
    // rejects create with the transient "No open folder matches root id"
    // error. The panel must keep the starting state and retry — no dead
    // error state, no toast.
    const create = vi.fn(
      async (): Promise<TerminalResult<{ terminalId: string; cwd: string }>> =>
        ok({ cwd: '/abs/repo', terminalId: 'pty-1' })
    );
    create.mockResolvedValueOnce({
      error: 'No open folder matches root id "root-1".',
      ok: false,
    });
    create.mockResolvedValueOnce({ error: 'Workspace roots are unavailable.', ok: false });
    installBridge({ create: create as TerminalBridge['create'] });
    render(<TerminalPanel />);

    await waitFor(() => expect(create.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 5000,
    });
    await waitFor(() => expect(lastTerminal().focus).toHaveBeenCalled(), { timeout: 5000 });
    expect(screen.queryByTestId('terminal-panel-error')).not.toBeInTheDocument();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('unsubscribes and destroys the pty on unmount', async () => {
    const bridge = installBridge();
    const { unmount } = render(<TerminalPanel />);
    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    // Let the create promise resolve + listeners attach.
    await waitFor(() => expect(offData.mock.calls.length).toBe(0)); // not yet
    await waitFor(() => expect(lastTerminal().focus).toHaveBeenCalled());

    unmount();

    await waitFor(() => expect(bridge.destroy).toHaveBeenCalledWith({ terminalId: 'pty-1' }));
    expect(offData).toHaveBeenCalled();
    expect(offExit).toHaveBeenCalled();
    expect(lastTerminal().dispose).toHaveBeenCalled();
    // The resize ResizeObserver this session's effect created is disconnected
    // on unmount too — not left subscribed to a container the component no
    // longer owns.
    expect(resizeObserverDisconnect).toHaveBeenCalled();
  });

  it('restarts a fresh pty after an exit', async () => {
    const bridge = installBridge();
    const user = userEvent.setup();
    render(<TerminalPanel />);
    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(exitCallback).not.toBeNull());

    exitCallback?.({ exitCode: 1, signal: null, terminalId: 'pty-1' });
    await screen.findByTestId('terminal-panel-exited');

    const createCallsBefore = (bridge.create as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Restart terminal' }));

    await waitFor(() =>
      expect((bridge.create as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        createCallsBefore
      )
    );
  });

  it("does not leak a prior root's exited overlay onto a freshly-starting root", async () => {
    // root-2's create stays pending so we can observe the switch-over window:
    // the gap between the old session's teardown and the new create resolving.
    // A holder object (not a `let`) keeps the resolver typed across the executor
    // closure — a closure-assigned `let` would be flow-narrowed to its initializer.
    type CreateResult = TerminalResult<{ terminalId: string; cwd: string }>;
    const deferred: { resolve: (result: CreateResult) => void } = {
      resolve: () => {
        throw new Error('root-2 create resolved before it was pending');
      },
    };
    const create = vi.fn((args: { rootId: string }): Promise<CreateResult> => {
      if (args.rootId === 'root-2') {
        return new Promise<CreateResult>((resolve) => {
          deferred.resolve = resolve;
        });
      }
      return Promise.resolve(ok({ cwd: '/abs/repo', terminalId: 'pty-1' }));
    });
    installBridge({ create: create as TerminalBridge['create'] });

    const { rerender } = render(<TerminalPanel />);
    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(exitCallback).not.toBeNull());

    // root-1's shell exits → its exited overlay paints.
    exitCallback?.({ exitCode: 0, signal: null, terminalId: 'pty-1' });
    await screen.findByTestId('terminal-panel-exited');

    // Focus a DIFFERENT workspace root. Its create is still pending, so the
    // session is `starting` — root-1's stale `exited` outcome must NOT leak.
    mockRoot.handle = {
      kind: 'directory',
      name: 'repo2',
      path: '/abs/repo2',
      platform: 'electron',
      rootId: 'root-2',
    };
    rerender(<TerminalPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId('terminal-panel-exited')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('terminal-host')).toBeInTheDocument();

    // Resolving root-2's create surfaces ITS cwd — not the stale one.
    deferred.resolve(ok({ cwd: '/abs/repo2', terminalId: 'pty-2' }));
    await waitFor(() => expect(screen.getByText('/abs/repo2')).toBeInTheDocument());
  });

  it('renders the no-root empty state when no workspace is focused', async () => {
    mockRoot.handle = null;
    installBridge();
    render(<TerminalPanel />);

    expect(await screen.findByTestId('terminal-panel-no-root')).toBeInTheDocument();
  });

  it('reattaches to an assistant command session and exposes its bounded output', async () => {
    installBridge();
    const commandSessions = installCommandSessionBridge();
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole('button', { name: 'Command sessions' }));

    expect(await screen.findByText('server ready')).toBeInTheDocument();
    expect(screen.getByText(/command-session-1234567890/)).toBeInTheDocument();
    expect(screen.getByText(/PID 314/)).toBeInTheDocument();
    expect(commandSessions.list).toHaveBeenCalledWith({ rootId: 'root-1' });
    expect(commandSessions.read).toHaveBeenCalledWith({
      rootId: 'root-1',
      sessionId: 'command-session-1234567890',
    });
  });

  it('does not duplicate retained output when React replays mount effects', async () => {
    installCommandSessionBridge();
    render(
      <StrictMode>
        <CommandSessionInventory rootId="root-1" />
      </StrictMode>
    );

    const output = await screen.findByRole('log', { name: 'Command session output' });
    await waitFor(() => expect(output).toHaveTextContent('server ready'));
    expect(output.textContent?.match(/server ready/g)).toHaveLength(1);
  });

  it('starts from the retained-output cursor when refresh selects a replacement session', async () => {
    const replacement: CommandSessionInfo = {
      createdAt: 2,
      cwd: '/abs/repo/apps/desktop',
      id: 'command-session-replacement',
      pid: 2718,
      rootId: 'root-1',
      status: 'running',
    };
    const commandSessions = installCommandSessionBridge();
    vi.mocked(commandSessions.list)
      .mockResolvedValueOnce({
        ok: true,
        value: {
          rootId: 'root-1',
          sessions: [
            {
              createdAt: 1,
              cwd: '/abs/repo/apps/web',
              id: 'command-session-1234567890',
              pid: 314,
              rootId: 'root-1',
              status: 'running',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { rootId: 'root-1', sessions: [replacement] },
      });
    vi.mocked(commandSessions.read).mockResolvedValueOnce({
      ok: true,
      value: {
        bufferStartCursor: 0,
        hasMore: false,
        nextCursor: 12,
        output: 'server ready\n',
        requestedCursor: 0,
        session: {
          createdAt: 1,
          cwd: '/abs/repo/apps/web',
          id: 'command-session-1234567890',
          pid: 314,
          rootId: 'root-1',
          status: 'running',
        },
        truncatedBeforeCursor: false,
      },
    });
    vi.mocked(commandSessions.read).mockResolvedValueOnce({
      ok: true,
      value: {
        bufferStartCursor: 0,
        hasMore: false,
        nextCursor: 18,
        output: 'replacement ready\n',
        requestedCursor: 0,
        session: replacement,
        truncatedBeforeCursor: false,
      },
    });
    const user = userEvent.setup();
    render(<CommandSessionInventory rootId="root-1" />);
    await screen.findByText('server ready');

    await user.click(screen.getByRole('button', { name: 'Refresh command sessions' }));

    expect(await screen.findByText('replacement ready')).toBeInTheDocument();
    expect(commandSessions.read).toHaveBeenLastCalledWith({
      rootId: 'root-1',
      sessionId: 'command-session-replacement',
    });
  });

  it('discards a late read after the selected command session changes', async () => {
    const firstSession: CommandSessionInfo = {
      createdAt: 1,
      cwd: '/abs/repo/apps/web',
      id: 'command-session-first',
      pid: 314,
      rootId: 'root-1',
      status: 'running',
    };
    const secondSession: CommandSessionInfo = {
      createdAt: 2,
      cwd: '/abs/repo/apps/desktop',
      id: 'command-session-second',
      pid: 2718,
      rootId: 'root-1',
      status: 'running',
    };
    let resolveFirstRead:
      | ((value: CommandSessionResult<CommandSessionReadPage>) => void)
      | undefined;
    const firstRead = new Promise<CommandSessionResult<CommandSessionReadPage>>((resolve) => {
      resolveFirstRead = resolve;
    });
    const commandSessions = installCommandSessionBridge({
      list: vi.fn(
        async (): Promise<
          CommandSessionResult<{ rootId: string; sessions: readonly CommandSessionInfo[] }>
        > => ({
          ok: true,
          value: { rootId: 'root-1', sessions: [firstSession, secondSession] },
        })
      ),
      read: vi.fn(
        async ({
          sessionId,
        }: {
          readonly cursor?: number;
          readonly rootId: string;
          readonly sessionId: string;
        }): Promise<CommandSessionResult<CommandSessionReadPage>> => {
          if (sessionId === firstSession.id) {
            return firstRead;
          }
          return {
            ok: true,
            value: {
              bufferStartCursor: 0,
              hasMore: false,
              nextCursor: 13,
              output: 'second ready\n',
              requestedCursor: 0,
              session: secondSession,
              truncatedBeforeCursor: false,
            },
          };
        }
      ),
    });
    const user = userEvent.setup();
    render(<CommandSessionInventory rootId="root-1" />);

    await waitFor(() =>
      expect(commandSessions.read).toHaveBeenCalledWith({
        rootId: 'root-1',
        sessionId: firstSession.id,
      })
    );
    await user.click(screen.getByRole('button', { name: /desktop/i }));
    expect(await screen.findByText('second ready')).toBeInTheDocument();

    resolveFirstRead?.({
      ok: true,
      value: {
        bufferStartCursor: 0,
        hasMore: false,
        nextCursor: 11,
        output: 'stale first\n',
        requestedCursor: 0,
        session: firstSession,
        truncatedBeforeCursor: false,
      },
    });

    await waitFor(() => expect(screen.queryByText('stale first')).not.toBeInTheDocument());
    expect(screen.getByText('second ready')).toBeInTheDocument();
  });

  it('stops, writes to, and removes the selected command session', async () => {
    installBridge();
    const commandSessions = installCommandSessionBridge();
    const user = userEvent.setup();
    render(<TerminalPanel />);
    await user.click(screen.getByRole('button', { name: 'Command sessions' }));
    await screen.findByText('server ready');

    await user.type(screen.getByRole('textbox', { name: 'Command session input' }), 'y');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(commandSessions.write).toHaveBeenCalledWith({
      data: 'y\n',
      rootId: 'root-1',
      sessionId: 'command-session-1234567890',
    });
    expect(commandSessions.stop).toHaveBeenCalledWith({
      rootId: 'root-1',
      sessionId: 'command-session-1234567890',
    });
    expect(commandSessions.remove).toHaveBeenCalledWith({
      rootId: 'root-1',
      sessionId: 'command-session-1234567890',
    });
  });

  it('creates the session at the FOCUSED root when nothing is pinned', async () => {
    const bridge = installBridge();
    render(<TerminalPanel />);

    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(1));
    const params = vi.mocked(bridge.create).mock.calls[0]?.[0];
    expect(params?.rootId).toBe('root-1');
    // No pin ⇒ no cwd key at all, so main takes its original root-cwd path.
    expect(params && 'cwd' in params).toBe(false);
  });

  it('creates the session at the PINNED checkout, carrying both rootId and cwd', async () => {
    const bridge = installBridge({
      create: vi.fn(async () =>
        ok({ cwd: '/abs/repo/.claude/worktrees/bright-fox', terminalId: 'pty-2' })
      ),
    });
    useTerminalTargetStore
      .getState()
      .openTerminalAt({ cwd: '/abs/repo/.claude/worktrees/bright-fox', rootId: 'root-1' });
    render(<TerminalPanel />);

    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(1));
    expect(bridge.create).toHaveBeenCalledWith({
      cols: 80,
      cwd: '/abs/repo/.claude/worktrees/bright-fox',
      rootId: 'root-1',
      rows: 24,
    });
    // The header reports the cwd main actually resolved, not the request.
    expect(await screen.findByText('/abs/repo/.claude/worktrees/bright-fox')).toBeInTheDocument();
  });

  it('offers "Follow focused folder" only while a target is pinned, and releasing it restarts at the root', async () => {
    const bridge = installBridge();
    render(<TerminalPanel />);
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('terminal-panel-clear-target')).not.toBeInTheDocument();

    await act(async () => {
      useTerminalTargetStore.getState().openTerminalAt({ cwd: '/abs/repo/sub', rootId: 'root-1' });
    });
    const release = await screen.findByTestId('terminal-panel-clear-target');
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(2));
    expect(vi.mocked(bridge.create).mock.calls[1]?.[0]).toMatchObject({ cwd: '/abs/repo/sub' });

    await userEvent.click(release);

    expect(screen.queryByTestId('terminal-panel-clear-target')).not.toBeInTheDocument();
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(3));
    const third = vi.mocked(bridge.create).mock.calls[2]?.[0];
    expect(third?.rootId).toBe('root-1');
    expect(third && 'cwd' in third).toBe(false);
  });

  it('does not surface the previous target’s outcome after the pin changes within one root', async () => {
    // The freshness gate must key on the (rootId, cwd) PAIR: the lifecycle
    // effect re-runs on a cwd change WITHOUT bumping sessionId, so a gate that
    // keyed on rootId alone would leak the previous checkout's `exited`
    // overlay onto the freshly-starting one. This is the same bug class the
    // existing rootId note in use-terminal-session.ts describes.
    const bridge = installBridge();
    render(<TerminalPanel />);
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(1));
    await act(async () => {
      exitCallback?.({ exitCode: 0, signal: null, terminalId: 'pty-1' });
    });
    expect(await screen.findByTestId('terminal-panel-exited')).toBeInTheDocument();

    await act(async () => {
      useTerminalTargetStore.getState().openTerminalAt({ cwd: '/abs/repo/sub', rootId: 'root-1' });
    });

    await waitFor(() =>
      expect(screen.queryByTestId('terminal-panel-exited')).not.toBeInTheDocument()
    );
  });

  it('selects the shell surface on an explicit Open in Terminal, even if command-sessions was active', async () => {
    // PR #2675 review: `openTerminalAt` changes rootId/cwd and reopens the
    // Terminal tab, but before this fix nothing forced `surface` back to
    // 'shell' — the requested PTY started invisibly behind the
    // command-sessions view whenever that tab was last selected.
    installBridge();
    installCommandSessionBridge();
    const user = userEvent.setup();
    render(<TerminalPanel />);
    await user.click(screen.getByRole('button', { name: 'Command sessions' }));
    await screen.findByText('server ready');
    expect(screen.getByTestId('terminal-host')).not.toBeVisible();

    await act(async () => {
      useTerminalTargetStore.getState().openTerminalAt({ cwd: '/abs/repo/sub', rootId: 'root-1' });
    });

    await waitFor(() => expect(screen.getByTestId('terminal-host')).toBeVisible());
    expect(screen.getByRole('button', { name: 'Shell' })).toHaveAttribute('aria-current', 'page');
  });

  it("scopes CommandSessionInventory's rootId to the FOCUSED root, never the pin", async () => {
    // PR #2675 review: a pin is a SHELL pin by design — its destructive
    // stop/remove/write actions must never silently retarget onto whatever
    // root a shell happens to be pinned to. Pin a DIFFERENT root than the
    // one actually focused (mockRoot stays 'root-1') and assert the
    // inventory still queries the focused root.
    installBridge();
    const commandSessions = installCommandSessionBridge();
    const user = userEvent.setup();
    useTerminalTargetStore.getState().openTerminalAt({ cwd: '/other/repo/sub', rootId: 'root-2' });
    render(<TerminalPanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Shell' })).toHaveAttribute('aria-current', 'page')
    );

    await user.click(screen.getByRole('button', { name: 'Command sessions' }));

    await waitFor(() => expect(commandSessions.list).toHaveBeenCalledWith({ rootId: 'root-1' }));
    expect(commandSessions.list).not.toHaveBeenCalledWith({ rootId: 'root-2' });
  });
});
