import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    offData.mockReset();
    offExit.mockReset();
    // jsdom has no ResizeObserver — stub it so the session effect can observe.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {
        /* no-op */
      }
      disconnect() {
        /* no-op */
      }
      unobserve() {
        /* no-op */
      }
    };
  });

  afterEach(() => {
    Reflect.deleteProperty(window as unknown as { terminal?: TerminalBridge }, 'terminal');
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
});
