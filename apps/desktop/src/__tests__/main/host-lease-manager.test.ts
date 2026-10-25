import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { authenticateHostClient, type HostClient } from '@brainstrike/agent-host/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HostStdio, openHostStdio } from '../../host-stdio';

// Main's own client is authenticated on the channel it opens on the child's stdio; the
// protocol itself is covered where the host serves it.
const client = vi.hoisted(() => ({ close: vi.fn(async () => undefined) }));
vi.mock('@brainstrike/agent-host/client', () => ({
  authenticateHostClient: vi.fn(async () => client),
}));

/**
 * The host's side of its stdio: what it reports, the channels Main opens, and Main's
 * controls. Its `exit` comes before the end of its stdout, as a real process's can.
 */
class Child extends EventEmitter {
  pid: number | undefined = 123;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly channels: string[] = [];
  readonly controls: unknown[] = [];
  /** How many times Main asked it to close. */
  closes = 0;
  exitOnClose = true;
  readonly kill = vi.fn(() => {
    this.exit(null, 'SIGKILL');
    return true;
  });
  readonly #stdio: HostStdio;
  constructor() {
    super();
    this.#stdio = openHostStdio(this.stdin, this.stdout, {
      invalid: (cause) => {
        throw cause;
      },
      message: (message) => {
        this.controls.push(message);
        if (JSON.stringify(message) === '{"method":"close"}') {
          this.closes += 1;
          if (this.exitOnClose) {
            this.exit(0);
          }
        }
      },
      opened: (channel) => this.channels.push(channel),
    });
  }
  report(message: unknown): void {
    void this.#stdio.message(message);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.pid === undefined) {
      return;
    }
    this.pid = undefined;
    this.emit('exit', code, signal);
    this.stdout.end();
  }
}
const root = '/private/host-lease-test';
/** A spawn whose child reports ready at once. */
const readySpawn = (child: Child) => () => {
  child.report({ event: 'ready' });
  return child;
};
const closes = (child: Child): number => child.closes;
beforeEach(() => {
  client.close.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('desktop host child', () => {
  it('spawns the host with its platform channel, waits for ready, then connects Main on its own channel', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const started = Promise.withResolvers<void>();
    const spawn = vi.fn((_entry: string, _args: readonly string[]) => child);
    const platformClose = vi.fn(async () => undefined);
    const owner = createDesktopHostLease({
      entryPath: '/entry.js',
      onChildStarted: () => started.resolve(),
      platform: () => ({ close: platformClose }),
      platformModule: '/platform.js',
      root,
      spawn,
    });
    let acquired: HostClient | undefined;
    const acquisition = owner.acquire().then((value) => {
      acquired = value;
    });
    try {
      await started.promise;
      expect(spawn.mock.calls[0]?.[0]).toBe('/entry.js');
      expect(JSON.parse(spawn.mock.calls[0]?.[1][0] ?? 'null')).toEqual({
        modulePath: '/platform.js',
        root,
      });
      await vi.waitFor(() => expect(child.channels).toEqual(['platform']));
      expect(acquired).toBeUndefined();
      child.report({ event: 'ready' });
      await acquisition;
      expect(acquired).toBe(client);
      await vi.waitFor(() => expect(child.channels).toEqual(['platform', 'main']));
    } finally {
      await owner.close();
    }
    expect(closes(child)).toBe(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(platformClose).toHaveBeenCalledOnce();
  });

  it('waits for a host slow to report ready, with no startup deadline, and spawns it once', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const spawn = vi.fn(() => child);
    const owner = createDesktopHostLease({ root, spawn });
    vi.useFakeTimers();
    const acquired = owner.acquire();
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(child.kill).not.toHaveBeenCalled();
      expect(closes(child)).toBe(0);
      vi.useRealTimers();
      child.report({ event: 'ready' });
      await expect(acquired).resolves.toBe(client);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await owner.close();
    }
  });

  it('fails a startup the child reported failed, or that exited before ready, and ends it', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const reported = new Child();
    reported.exitOnClose = true;
    const failing = createDesktopHostLease({
      root,
      spawn: () => {
        reported.report({ event: 'failed', kind: 'error', message: 'no platform' });
        return reported;
      },
    });
    await expect(failing.acquire()).rejects.toThrow('no platform');
    expect(reported.pid).toBeUndefined();

    const exited = new Child();
    const lost = createDesktopHostLease({
      root,
      spawn: () => {
        queueMicrotask(() => exited.exit(1));
        return exited;
      },
    });
    await expect(lost.acquire()).rejects.toThrow('Agent host exited before ready (1)');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a startup on a Root another owner holds with that owner, never a native-process failure of its own',
    async () => {
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { RootLock, RootLockedError } = await import('@brainstrike/state-store');
      const { createDesktopHostLease } = await import('../../host-lease-manager');
      const held = await mkdtemp(join(tmpdir(), 'host-lease-held-'));
      const owner = RootLock.acquire(held);
      try {
        const child = new Child();
        const lease = createDesktopHostLease({
          platform: () => ({ close: async () => undefined }),
          root: held,
          spawn: () => {
            child.report({ event: 'failed', kind: 'root-locked', message: 'in use' });
            return child;
          },
        });
        await expect(lease.acquire()).rejects.toBeInstanceOf(RootLockedError);
      } finally {
        owner.release();
        await rm(held, { force: true, recursive: true });
      }
    }
  );

  it('kills a host still running after the close grace, and joins its exit', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = false;
    const owner = createDesktopHostLease({ closeGraceMs: 5000, root, spawn: readySpawn(child) });
    await owner.acquire();
    vi.useFakeTimers();
    const closed = owner.close();
    await vi.advanceTimersByTimeAsync(4999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closed;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(closes(child)).toBe(1);
  });

  it('ends a quit at the host’s exit while a process the host started still holds its stderr', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const directory = await mkdtemp(join(tmpdir(), 'host-stderr-holder-'));
    const entry = join(directory, 'host.mjs');
    const holderPid = join(directory, 'holder.pid');
    // A real host process: it starts a child that inherits its stderr and outlives it, then
    // reports ready and exits when Main asks it to close.
    await writeFile(
      entry,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'inherit'] });
holder.unref();
writeFileSync(${JSON.stringify(holderPid)}, String(holder.pid));
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'host/message', params: { event: 'ready' } }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'host/message' && frame.params.method === 'close') {
    process.exit(0);
  }
});
`
    );
    let holder: number | undefined;
    try {
      const host = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
      const kill = vi.spyOn(host, 'kill');
      const owner = createDesktopHostLease({ root, spawn: () => host });
      await owner.acquire();
      holder = Number(await readFile(holderPid, 'utf8'));
      await owner.close();
      expect(kill).not.toHaveBeenCalled();
      expect(host.exitCode).toBe(0);
      // The pipe was still held when the quit ended.
      expect(() => process.kill(holder ?? 0, 0)).not.toThrow();
    } finally {
      if (holder !== undefined) {
        process.kill(holder, 'SIGKILL');
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('ends a ready host that never answers Main’s initialize when the app closes', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const { isHostLeaseClosed } = await import('../../desktop-shutdown-state');
    // The handshake settles only when its transport closes, as a silent host's would.
    vi.mocked(authenticateHostClient).mockImplementationOnce(
      async (_connection, _record, _closeTransport, transportClosed) => {
        await transportClosed;
        throw new Error('The host closed before initialize');
      }
    );
    const child = new Child();
    child.exitOnClose = false;
    const owner = createDesktopHostLease({ root, spawn: readySpawn(child) });
    const outcome = owner.acquire().then(
      () => undefined,
      (cause: unknown) => cause
    );
    await vi.waitFor(() => expect(child.channels).toContain('main'));
    vi.useFakeTimers();
    const closed = owner.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closed;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(isHostLeaseClosed(await outcome)).toBe(true);
  });

  it('reports a ready host that exits without being asked as lost, and never a close it asked for', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const crashed = new Child();
    const onLost = vi.fn();
    const owner = createDesktopHostLease({ onLost, root, spawn: readySpawn(crashed) });
    await owner.acquire();
    crashed.exit(9);
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledWith(9, { requested: false }));
    await owner.close();
    expect(closes(crashed)).toBe(0);

    const asked = new Child();
    const quiet = vi.fn();
    const closing = createDesktopHostLease({ onLost: quiet, root, spawn: readySpawn(asked) });
    await closing.acquire();
    await closing.close();
    expect(quiet).not.toHaveBeenCalled();
  });

  it('ends a startup its own close cancels with the typed closing refusal', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const { isHostLeaseClosed } = await import('../../desktop-shutdown-state');
    const child = new Child();
    const spawn = vi.fn(() => child);
    const owner = createDesktopHostLease({ root, spawn });
    const outcome = owner.acquire().then(
      () => undefined,
      (cause: unknown) => cause
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    await owner.close();
    expect(isHostLeaseClosed(await outcome)).toBe(true);
    expect(child.pid).toBeUndefined();
  });
});

describe('stop for relaunch', () => {
  async function readyOwner(child: Child) {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const onLost = vi.fn();
    let ready: import('../../host-lease-manager').DesktopHostChild | undefined;
    const owner = createDesktopHostLease({
      onChildReady: (readyChild) => {
        ready = readyChild;
      },
      onLost,
      root,
      spawn: readySpawn(child),
    });
    await owner.acquire();
    if (!ready) {
      throw new Error('The lease reported no ready child');
    }
    return { onLost, owner, ready };
  }

  it('asks the child to close and reports its exit as a requested loss, so the profile recovers', async () => {
    const child = new Child();
    const { onLost, owner, ready } = await readyOwner(child);
    expect(await ready.stopForRelaunch()).toBe(0);
    expect(onLost).toHaveBeenCalledWith(0, { requested: true });
    await owner.close();
    expect(closes(child)).toBe(1);
  });

  it('a quit during the restart joins the same stop: one close, at most one kill', async () => {
    const child = new Child();
    child.exitOnClose = false;
    const { owner, ready } = await readyOwner(child);
    vi.useFakeTimers();
    const restarting = ready.stopForRelaunch();
    const quitting = owner.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await restarting).toBe(137);
    await quitting;
    expect(closes(child)).toBe(1);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe('agent host startup reporting', () => {
  const startupLogger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn() });
  it.each([false, true])(
    'reports a startup its own lease owner closed as a cancellation, never an error (shutdown=%s)',
    async (shuttingDown) => {
      const { createDesktopHostLease } = await import('../../host-lease-manager');
      const { reportAgentHostStartupFailure } = await import('../../native-index-activation-error');
      const child = new Child();
      const spawn = vi.fn(() => child);
      const owner = createDesktopHostLease({ root, spawn });
      const outcome = owner.acquire().then(
        () => undefined,
        (cause: unknown) => cause
      );
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      await owner.close();
      const logger = startupLogger();
      reportAgentHostStartupFailure(await outcome, shuttingDown, logger);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'Agent host startup cancelled: its lease owner closed'
      );
    }
  );
  it('answers a client connect waiting on that close with its typed refusal, never an untyped failure', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const { settleIpcResult } = await import('../../platform/desktop-ipc-registry');
    const { addLogListener, LogLevel } = await import('@brainstrike/logging');
    const errors: unknown[] = [];
    const stop = addLogListener((record) => {
      if (record.level >= LogLevel.ERROR) {
        errors.push(record.message);
      }
    });
    const connect = { category: 'availability', code: 'agent-host-connect-failed' } as const;
    try {
      const child = new Child();
      const spawn = vi.fn(() => child);
      const owner = createDesktopHostLease({ root, spawn });
      const connecting = settleIpcResult(connect, () => owner.acquire());
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      await owner.close();
      expect(await connecting).toMatchObject({
        error: { code: 'desktop.host-lease-closed', kind: 'refusal' },
        ok: false,
      });
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe('parent-only content clear', () => {
  it('never kills a host whose content clear is still deleting, and returns its committed receipt', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const owner = createDesktopHostLease({ closeGraceMs: 10, root, spawn: readySpawn(child) });
    await owner.acquire();
    vi.useFakeTimers();
    const clearing = owner.clearAndRetireContent();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
    await vi.waitFor(() => expect(child.controls).toEqual([{ method: 'clear-content' }]));
    child.report({ deletedChunks: 3, deletedFiles: 2, event: 'content-cleared' });
    child.exit(0);
    await expect(clearing).resolves.toEqual({ deletedChunks: 3, deletedFiles: 2 });
    expect(closes(child)).toBe(0);
  });

  it('never fabricates a receipt from the exit alone', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const owner = createDesktopHostLease({ root, spawn: readySpawn(child) });
    await owner.acquire();
    const clearing = owner.clearAndRetireContent();
    child.exit(0);
    await expect(clearing).rejects.toThrow('without a content-clear receipt');
  });
});
