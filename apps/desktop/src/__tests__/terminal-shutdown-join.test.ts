import type { WebContents } from 'electron';
import type { IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalIpcHandlers, disposeAllTerminals } from '../terminal-ipc-handlers';

const control = vi.hoisted(() => ({
  reaps: [] as ((error?: Error) => void)[],
}));
vi.mock('tree-kill', () => ({
  default: (_pid: number, _signal: string, callback: (error?: Error) => void) => {
    control.reaps.push(callback);
  },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../workspace-root-cwd', () => ({
  resolveContainedCwd: async () => ({ ok: true, value: '/root' }),
  resolveRootCwd: async () => ({ ok: true, value: '/root' }),
}));

function fixture(): {
  destroyed: () => void;
  exit: () => void;
  kill: ReturnType<typeof vi.fn>;
  owner: WebContents;
  spawn: typeof import('node-pty').spawn;
} {
  let destroyed: () => void = () => undefined;
  let exit: () => void = () => undefined;
  let isDestroyed = false;
  const kill = vi.fn();
  const owner = {
    id: 900,
    isDestroyed: () => isDestroyed,
    once: (_event: string, callback: () => void) => {
      destroyed = callback;
    },
    send: vi.fn(),
  } as unknown as WebContents;
  const process = {
    kill,
    onData: vi.fn(),
    onExit: (callback: (event: { exitCode: number; signal: number }) => void) => {
      exit = () => callback({ exitCode: 0, signal: 9 });
    },
    pid: 987_654,
  } as unknown as IPty;
  return {
    destroyed: () => {
      isDestroyed = true;
      destroyed();
    },
    exit: () => exit(),
    kill,
    owner,
    spawn: (() => process) as typeof import('node-pty').spawn,
  };
}

async function create(): Promise<ReturnType<typeof fixture>> {
  const f = fixture();
  const handlers = createTerminalIpcHandlers({
    resolver: { listRoots: async () => [] },
    spawn: f.spawn,
  });
  expect((await handlers.create(f.owner, { rootId: 'root' })).ok).toBe(true);
  return f;
}

beforeEach(() => {
  control.reaps.length = 0;
  vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe('terminal shutdown joins physical cleanup', () => {
  it('joins a renderer-triggered reap after IPC admission was removed', async () => {
    const f = await create();
    f.destroyed();
    let settled = false;
    const drain = Promise.resolve(disposeAllTerminals()).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(control.reaps).toHaveLength(1);
    control.reaps[0]?.();
    await Promise.resolve();
    expect(f.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    f.exit();
    await drain;
    expect(settled).toBe(true);
  });

  it('repeated drains join the same tree walk and PTY exit', async () => {
    const f = await create();
    const first = Promise.resolve(disposeAllTerminals());
    const second = Promise.resolve(disposeAllTerminals());
    expect(control.reaps).toHaveLength(1);
    f.exit();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    control.reaps[0]?.();
    await Promise.all([first, second]);
    expect(f.kill).toHaveBeenCalledOnce();
  });

  it('does not kill a PTY whose native exit callback already completed', async () => {
    const f = await create();
    f.exit();
    await expect(disposeAllTerminals()).resolves.toBe(0);
    expect(control.reaps).toHaveLength(0);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it('reports a failed tree walk even when the PTY subsequently exits', async () => {
    const f = await create();
    const other = await create();
    const drain = disposeAllTerminals();
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
    f.exit();
    await Promise.resolve();
    expect(settled).toBe(false);
    control.reaps[1]?.();
    other.exit();
    await failure;
    await expect(disposeAllTerminals()).rejects.toThrow('Terminal shutdown cleanup failed');
    expect(control.reaps).toHaveLength(2);
  });
});
