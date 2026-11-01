import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TerminalEvent } from '@brainstrike/agent-host/protocol';
import type { IDisposable, IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandSessionManager } from '../../src/command-sessions/command-session-manager.ts';
import { createPtyTerminals } from '../../src/command-sessions/pty-terminals.ts';

const control = vi.hoisted(() => ({
  reaps: [] as ((error?: Error) => void)[],
}));
vi.mock('@brainstrike/state-store/native-children', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/state-store/native-children')>()),
  terminateTree: () =>
    new Promise<void>((resolve, reject) => {
      control.reaps.push((error) => (error ? reject(error) : resolve()));
    }),
}));

/** One shell node-pty would start: its output and exit are pushed by the test. */
function fakePty(pid: number) {
  let output: (data: string) => void = () => undefined;
  let exited: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  const kill = vi.fn();
  const written: string[] = [];
  const disposable: IDisposable = { dispose: () => undefined };
  const pty: IPty = {
    clear: () => undefined,
    cols: 80,
    handleFlowControl: false,
    kill,
    onData: (listener) => {
      output = listener;
      return disposable;
    },
    onExit: (listener) => {
      exited = listener;
      return disposable;
    },
    pause: () => undefined,
    pid,
    process: 'sh',
    resize: () => undefined,
    resume: () => undefined,
    rows: 24,
    write: (data) => {
      written.push(String(data));
    },
  };
  return {
    exit: () => exited({ exitCode: 0, signal: 9 }),
    kill,
    output: (data: string) => output(data),
    pty,
    written,
  };
}

let root: string;
let ptys: ReturnType<typeof fakePty>[];

function terminals() {
  return createPtyTerminals({
    commandSessions: createCommandSessionManager({}),
    resolver: { listRoots: async () => [{ displayName: 'root', path: root, rootId: 'root' }] },
    spawn: () => {
      const next = fakePty(987_000 + ptys.length);
      ptys.push(next);
      return next.pty;
    },
  });
}

async function open(owner: ReturnType<typeof terminals>, events: TerminalEvent[] = []) {
  const session = owner.service.open((event) => events.push(event));
  const created = await session['terminal/create']({ rootId: 'root' });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  const pty = ptys.at(-1);
  if (!pty) {
    throw new Error('No pty was spawned');
  }
  return { events, pty, session, terminalId: created.value.terminalId };
}

beforeEach(async () => {
  control.reaps.length = 0;
  ptys = [];
  root = await mkdtemp(path.join(tmpdir(), 'pty-terminals-'));
  vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { force: true, recursive: true });
});

describe('desktop terminals', () => {
  it('pushes a terminal’s output and exit only to the client that created it', async () => {
    const owner = terminals();
    const mine = await open(owner);
    const otherEvents: TerminalEvent[] = [];
    const other = owner.service.open((event) => otherEvents.push(event));

    mine.pty.output('hello');
    await expect(
      other['terminal/write']({ data: 'rm -rf ~\r', terminalId: mine.terminalId })
    ).resolves.toMatchObject({
      error: { code: 'terminal.not-found', message: `No live terminal "${mine.terminalId}".` },
      ok: false,
    });
    mine.pty.exit();

    expect(mine.events).toEqual([
      { data: 'hello', terminalId: mine.terminalId, type: 'data' },
      { exitCode: 0, signal: 9, terminalId: mine.terminalId, type: 'exit' },
    ]);
    expect(otherEvents).toEqual([]);
    expect(mine.pty.written).toEqual([]);
  });

  it('starts no shell outside an open folder', async () => {
    const session = terminals().service.open(() => undefined);
    const created = await session['terminal/create']({ cwd: tmpdir(), rootId: 'root' });

    expect(created).toMatchObject({ error: { code: 'workspace.cwd-outside-root' }, ok: false });
    expect(ptys).toEqual([]);
  });
});

describe('terminal shutdown joins physical cleanup', () => {
  it('host close joins the reap a closed client started', async () => {
    const owner = terminals();
    const { pty, session } = await open(owner);
    void session.close();
    let settled = false;
    const drain = owner.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(control.reaps).toHaveLength(1);
    control.reaps[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    pty.exit();
    await drain;
    expect(settled).toBe(true);
  });

  it('repeated closes join the same tree walk and PTY exit', async () => {
    const owner = terminals();
    const { pty } = await open(owner);
    const first = owner.close();
    const second = owner.close();
    expect(control.reaps).toHaveLength(1);
    pty.exit();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    control.reaps[0]?.();
    await Promise.all([first, second]);
    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it('does not kill a PTY whose native exit callback already completed', async () => {
    const owner = terminals();
    const { pty } = await open(owner);
    pty.exit();
    await new Promise((resolve) => setImmediate(resolve));
    await owner.close();
    expect(control.reaps).toHaveLength(0);
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it('reports a failed tree walk even when the PTY subsequently exits', async () => {
    const owner = terminals();
    const failed = await open(owner);
    const other = await open(owner);
    const drain = owner.close();
    let settled = false;
    void drain.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const failure = expect(drain).rejects.toThrow('Terminal shutdown cleanup failed');
    control.reaps[0]?.(new Error('tree walk failed'));
    failed.pty.exit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    control.reaps[1]?.();
    other.pty.exit();
    await failure;
    await expect(owner.close()).rejects.toThrow('Terminal shutdown cleanup failed');
    expect(control.reaps).toHaveLength(2);
  });
});
