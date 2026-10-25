import { EventEmitter } from 'node:events';
import type { HostAttachment, HostLaunchOptions, HostStartOptions } from '@brainstrike/host-lease';
import { CHILD_CLOSE_BUDGET_MS } from '@brainstrike/state-store';
import type { MessagePortMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/host-lease', async (original) => ({
  ...(await original<typeof import('@brainstrike/host-lease')>()),
  launchHost: launch,
}));
// The fake utility's pid 123 names no real process: the start time its ready
// record is checked against is the one that record carries (BST-2176), and it
// has none once every fake utility exited, so the owner's exit join completes.
const liveFakes = vi.hoisted(() => new Set<object>());
vi.mock('@brainstrike/state-store', async (original) => {
  const actual = await original<typeof import('@brainstrike/state-store')>();
  return {
    ...actual,
    processStartTime: (pid: number) =>
      pid === 123 ? (liveFakes.size > 0 ? 'child' : null) : actual.processStartTime(pid),
  };
});

class Child extends EventEmitter {
  pid: number | undefined = 123;
  readonly posts: unknown[] = [];
  /** Electron's kill: SIGTERM, then SIGKILL; the utility's exit follows (code 15 here). */
  readonly kill = vi.fn(() => {
    if (this.exitOnKill) {
      queueMicrotask(() => this.exit(15));
    }
    return true;
  });
  exitOnClose = true;
  exitOnKill = true;
  constructor() {
    super();
    liveFakes.add(this);
  }
  postMessage(message: unknown): void {
    this.posts.push(message);
    // Only the close control ends the utility; the lifetime port arrives at spawn.
    if (this.exitOnClose && JSON.stringify(message) === '{"method":"close"}') {
      queueMicrotask(() => this.exit(0));
    }
  }
  exit(code: number): void {
    this.pid = undefined;
    liveFakes.delete(this);
    this.emit('exit', code);
  }
}
const root = '/private/host-lease-test';
/** What the fake utility's ready report carries: its own pid and start time. */
const readyRecord = {
  endpoint: '/private/socket',
  hostVersion: '0.1.0',
  pid: 123,
  protocolVersion: 2,
  start: 'child',
  token: 'a'.repeat(64),
};
const start: HostStartOptions = { lifetime: 'app', parent: { pid: 42, start: 'parent' }, root };
let attachment: HostAttachment;
beforeEach(() => {
  launch.mockReset();
  liveFakes.clear();
  attachment = {
    close: vi.fn(async () => undefined),
    closed: new Promise<void>(() => undefined),
    record: {
      endpoint: '/private/socket',
      hostVersion: '1',
      pid: 123,
      protocolVersion: 1,
      start: 'child',
      token: 'a'.repeat(64),
    },
  };
  launch.mockImplementation(async (_root: string, options: HostLaunchOptions) => {
    await options.spawn(start, new AbortController().signal);
    return attachment;
  });
});

describe('desktop host lease ownership', () => {
  it('reports the real fork with its lifetime port transferred before host readiness', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const launched = Promise.withResolvers<void>();
    const fork = vi.fn(() => child);
    const owner = createDesktopHostLease({ fork, onChildStarted: () => launched.resolve(), root });
    let ready = false;
    const acquisition = owner.acquire().then(() => {
      ready = true;
    });
    try {
      await launched.promise;
      expect(fork).toHaveBeenCalledOnce();
      expect(child.posts).toEqual([{ event: 'lifetime' }]);
      expect(ready).toBe(false);
      child.emit('message', { event: 'ready', record: readyRecord });
      await acquisition;
    } finally {
      await owner.close();
    }
  });
  it('joins its child even when attachment cleanup fails and preserves that failure', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const cause = new Error('socket cleanup failed');
    attachment.close = vi.fn(async () => {
      throw cause;
    });
    const child = new Child();
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
        return child;
      },
      root,
    });
    await owner.acquire();
    await expect(owner.close()).rejects.toBe(cause);
    expect(child.pid).toBeUndefined();
    await expect(owner.close()).rejects.toBe(cause);
  });
  it('escalates failed startup cleanup to kill after the cooperative rung and joins that exit', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = false;
    const owner = createDesktopHostLease({
      cooperativeCloseMs: 20,
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready', extra: true }));
        return child;
      },
      root,
    });
    // The startup failure itself, not a cleanup failure: the ladder joined the exit.
    await expect(owner.acquire()).rejects.not.toBeInstanceOf(AggregateError);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.pid).toBeUndefined();
    await expect(owner.close()).resolves.toBeUndefined();
  });
  it('coalesces acquisition and joins its own cooperative exit after detaching', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const fork = vi.fn(() => {
      queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
      return child;
    });
    const owner = createDesktopHostLease({ entryPath: '/entry.js', fork, root });
    const first = owner.acquire();
    expect(owner.acquire()).toBe(first);
    expect(await first).toBe(attachment);
    await owner.close();
    expect(fork).toHaveBeenCalledTimes(1);
    expect(child.posts).toEqual([{ event: 'lifetime' }, { method: 'close' }]);
    expect(child.pid).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(attachment.close).toHaveBeenCalledTimes(1);
    const { isHostLeaseClosed } = await import('../../desktop-shutdown-state');
    await expect(owner.acquire().catch((cause: unknown) => isHostLeaseClosed(cause))).resolves.toBe(
      true
    );
  });
  it('detaches an existing CLI owner without spawning or terminating it', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    launch.mockResolvedValue(attachment);
    const fork = vi.fn(() => new Child());
    const owner = createDesktopHostLease({ fork, root });
    await owner.acquire();
    await owner.close();
    expect(fork).not.toHaveBeenCalled();
    expect(attachment.close).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, new Error('Reset replacement cancelled by quit')])(
    'closes startup with the original cancellation cause: %s',
    async (reason) => {
      const { createDesktopHostLease } = await import('../../host-lease-manager');
      const { isHostLeaseClosed } = await import('../../desktop-shutdown-state');
      const child = new Child();
      const owner = createDesktopHostLease({ fork: () => child, root });
      const acquiring = owner.acquire();
      const rejected =
        reason === undefined
          ? expect(acquiring.catch((cause: unknown) => isHostLeaseClosed(cause))).resolves.toBe(
              true
            )
          : expect(acquiring).rejects.toBe(reason);
      await vi.waitFor(() => expect(child.listenerCount('message')).toBe(1));
      await owner.close(reason);
      await rejected;
      expect(child.posts).toEqual([{ event: 'lifetime' }, { method: 'close' }]);
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
    }
  );
  it('preserves malformed startup failure while still closing its process', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready', token: 'secret' }));
        return child;
      },
      root,
    });
    await expect(owner.acquire()).rejects.toThrow();
    expect(child.posts).toEqual([{ event: 'lifetime' }, { method: 'close' }]);
    expect(child.pid).toBeUndefined();
  });
  it('reports a ready host that exits without being asked, cleanly or not, and still joins it (BST-2004)', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    for (const code of [0, 9]) {
      const child = new Child();
      const onLost = vi.fn();
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
          return child;
        },
        onLost,
        root,
      });
      await owner.acquire();
      child.exit(code);
      expect(onLost).toHaveBeenCalledExactlyOnceWith(code, { requested: false });
      // The loss was reported when it happened; retiring the owner is not a failed close.
      await owner.close();
      expect(child.posts).not.toContainEqual({ method: 'close' });
    }
  });
  it('retires a lost host whose connection it reset as it exited, and keeps every other close failure (BST-2143)', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const reset = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const lostOwner = (close: () => Promise<void>) => {
      const child = new Child();
      attachment = { ...attachment, close: vi.fn(close) };
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
          return child;
        },
        onLost: vi.fn(),
        root,
      });
      return { child, owner };
    };

    // Main's unread catalog request makes the dying host's kernel reset the
    // socket: that reset is the loss already reported, not a failed release.
    const peerReset = lostOwner(async () => {
      throw new AggregateError([reset(), reset()], 'Host client receive and disposal failed');
    });
    await peerReset.owner.acquire();
    peerReset.child.exit(0);
    await peerReset.owner.close();

    const other = new Error('socket cleanup failed');
    const failedCleanup = lostOwner(async () => {
      throw new AggregateError([reset(), other], 'Host client receive and disposal failed');
    });
    await failedCleanup.owner.acquire();
    failedCleanup.child.exit(0);
    await expect(failedCleanup.owner.close()).rejects.toThrow('receive and disposal failed');

    // A content clear asks the host to close before the lease closes its
    // attachment: a reset after that ask stays a close failure.
    const asked = new Child();
    asked.exitOnClose = false;
    attachment = {
      ...attachment,
      close: vi.fn(async () => {
        throw reset();
      }),
    };
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => asked.emit('message', { event: 'ready', record: readyRecord }));
        return asked;
      },
      platformModule: '/fixture.js',
      root,
    });
    await owner.acquire();
    const clearing = owner.clearAndRetireContent();
    asked.emit('message', { deletedChunks: null, deletedFiles: 0, event: 'content-cleared' });
    asked.exit(0);
    await expect(clearing).rejects.toThrow('ECONNRESET');
  });
  it('retires a host that reset its connection while closing on its own, and still joins its exit (BST-2192)', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    // A signal to Main's process group closes the host too. It ends Main's
    // connection with Main's write in flight, and exits only after Main's
    // shutdown has started releasing the lease.
    const reset = (): Error => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const selfClosing = () => {
      const child = new Child();
      child.exitOnClose = false;
      attachment = {
        ...attachment,
        close: vi.fn(async () => {
          throw reset();
        }),
      };
      const onLost = vi.fn();
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
          return child;
        },
        onLost,
        root,
      });
      return { child, onLost, owner };
    };

    const clean = selfClosing();
    await clean.owner.acquire();
    const released = clean.owner.close();
    await vi.waitFor(() => expect(clean.child.posts).toContainEqual({ method: 'close' }));
    clean.child.exit(0);
    await released;
    expect(clean.onLost).not.toHaveBeenCalled();

    // The reset is the host's own close, not proof of it: a failed exit still fails the release.
    const failed = selfClosing();
    await failed.owner.acquire();
    const failing = failed.owner.close();
    await vi.waitFor(() => expect(failed.child.posts).toContainEqual({ method: 'close' }));
    failed.child.exit(1);
    await expect(failing).rejects.toThrow('exited with code 1');

    // A host this app only attached to has no exit for this owner to join.
    launch.mockResolvedValue(attachment);
    const attached = createDesktopHostLease({ root });
    await attached.acquire();
    await expect(attached.close()).rejects.toThrow('EPIPE');
  });
  it('never reports a loss for a close it asked for, or for a child that exits before ready (BST-2004)', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const asked = new Child();
    const onAskedLost = vi.fn();
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => asked.emit('message', { event: 'ready', record: readyRecord }));
        return asked;
      },
      onLost: onAskedLost,
      root,
    });
    await owner.acquire();
    await owner.close();
    expect(asked.posts).toContainEqual({ method: 'close' });
    expect(onAskedLost).not.toHaveBeenCalled();

    const early = new Child();
    const onEarlyLost = vi.fn();
    const failing = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => early.exit(1));
        return early;
      },
      onLost: onEarlyLost,
      root,
    });
    await expect(failing.acquire()).rejects.toThrow('exited before ready');
    expect(onEarlyLost).not.toHaveBeenCalled();
  });
  it('reports a nonzero owned exit and refuses later acquisition', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = false;
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
        return child;
      },
      root,
    });
    await owner.acquire();
    const closing = owner.close();
    await vi.waitFor(() => expect(child.posts).toContainEqual({ method: 'close' }));
    child.exit(7);
    await expect(closing).rejects.toThrow('7');
    await expect(owner.acquire()).rejects.toThrow('closing');
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('keeps the platform port open while a cancelled host is still cleaning up, and closes it once that host exits', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    // A startup the launcher cancels before the host is ready.
    launch.mockImplementation(async (_root: string, options: HostLaunchOptions) => {
      const cancelled = new AbortController();
      setTimeout(() => cancelled.abort(new Error('Host startup cancelled')), 10);
      await options.spawn(start, cancelled.signal);
      return attachment;
    });
    // Slow cleanup: the cancelled host ignores close, and even its kill takes a while to land.
    const child = new Child();
    child.exitOnClose = false;
    child.exitOnKill = false;
    const platformClose = vi.fn(async () => undefined);
    const owner = createDesktopHostLease({
      cooperativeCloseMs: 20,
      fork: () => child,
      platform: () => ({ close: platformClose, port: {} as MessagePortMain }),
      root,
    });
    let settled = false;
    const acquiring = owner.acquire().finally(() => {
      settled = true;
    });
    acquiring.catch(() => undefined);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce());
    expect(child.posts).toContainEqual({ method: 'close' });
    // Nothing is released while the host still runs: no caller-side deadline gives up on it.
    expect(platformClose).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    child.exit(15);
    // The cancellation stays the outcome; the joined cleanup is not a failure.
    await expect(acquiring).rejects.toThrow('Host startup cancelled');
    expect(platformClose).toHaveBeenCalledOnce();
    await expect(owner.close()).resolves.toBeUndefined();
  });
  it('gives the host its lifetime port at spawn and lets go of it only after the host exited', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = false;
    const order: string[] = [];
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
        return child;
      },
      lifetimeChannel: () => ({
        port1: { close: () => order.push('lifetime released') } as unknown as MessagePortMain,
        port2: {} as MessagePortMain,
      }),
      root,
    });
    await owner.acquire();
    expect(child.posts).toEqual([{ event: 'lifetime' }]);
    const closing = owner.close();
    await vi.waitFor(() => expect(child.posts).toContainEqual({ method: 'close' }));
    expect(order).toEqual([]);
    order.push('host exited');
    child.exit(0);
    await closing;
    expect(order).toEqual(['host exited', 'lifetime released']);
  });
  it('escalates a host that ignores close to kill after the cooperative rung, joins its exit and reports no failure', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const { addLogListener, LogLevel } = await import('@brainstrike/logging');
    const warnings: unknown[] = [];
    const stop = addLogListener((record) => {
      if (record.scope === 'DesktopHostLease' && record.level !== LogLevel.DEBUG) {
        warnings.push({ args: record.args, level: record.level, message: record.message });
      }
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const child = new Child();
      child.exitOnClose = false;
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
          return child;
        },
        root,
      });
      await owner.acquire();
      let released = false;
      const closing = owner.close().then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(CHILD_CLOSE_BUDGET_MS - 1);
      expect(child.posts).toContainEqual({ method: 'close' });
      expect(child.kill).not.toHaveBeenCalled();
      expect(released).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.pid).toBeUndefined();
      expect(warnings).toEqual([
        expect.objectContaining({
          level: LogLevel.WARN,
          message: 'The owned agent host did not exit after close; killing it',
        }),
      ]);
      expect(JSON.stringify(warnings)).toContain('"pid":123');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      stop();
    }
  });
  it('logs a refused kill as an error, keeps joining the exit and never excuses its exit code', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const { addLogListener, LogLevel } = await import('@brainstrike/logging');
    const errors: string[] = [];
    const stop = addLogListener((record) => {
      if (record.scope === 'DesktopHostLease' && record.level === LogLevel.ERROR) {
        errors.push(record.message ?? '');
      }
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const child = new Child();
      child.exitOnClose = false;
      child.exitOnKill = false;
      child.kill.mockReturnValue(false);
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
          return child;
        },
        root,
      });
      await owner.acquire();
      const closing = owner.close();
      closing.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(CHILD_CLOSE_BUDGET_MS);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(errors).toEqual(['Could not kill the owned agent host; still waiting for it to exit']);

      child.exit(1);
      await expect(closing).rejects.toThrow('Owned host utility exited with code 1');
    } finally {
      vi.useRealTimers();
      stop();
    }
  });
  it('joins Main’s delayed view of the host exit inside the ladder (E2E child-exit point)', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const { createLifecycleDelaySeam } = await import('../../lifecycle-delay-seam');
    const { LIFECYCLE_DELAYS_ENV } = await import('@brainstrike/host-lease/lifecycle-delays');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const child = new Child();
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
          return child;
        },
        lifecycleDelays: createLifecycleDelaySeam(
          { [LIFECYCLE_DELAYS_ENV]: 'child-exit:4000' },
          () => true
        ),
        root,
      });
      await owner.acquire();
      let released = false;
      const closing = owner.close().then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(3999);
      expect(child.pid).toBeUndefined();
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// BST-1880 restart, ADR-0026: the lease stops its own child for a relaunch over the
// child's control port and joins the exit under its one close ladder.
describe('stop for relaunch', () => {
  async function readyOwner(options: { readonly exitOnClose: boolean }) {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = options.exitOnClose;
    const onLost = vi.fn();
    let ready: import('../../host-lease-manager').DesktopHostChild | undefined;
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
        return child;
      },
      onChildReady: (readyChild) => {
        ready = readyChild;
      },
      onLost,
      root,
    });
    await owner.acquire();
    if (!ready) {
      throw new Error('The lease reported no ready child');
    }
    return { child, cooperativeMs: CHILD_CLOSE_BUDGET_MS, onLost, owner, ready };
  }
  const closes = (child: Child): number =>
    child.posts.filter((post) => JSON.stringify(post) === '{"method":"close"}').length;

  it('asks the child to close and reports its exit as a requested loss, so the profile recovers', async () => {
    const { child, onLost, owner, ready } = await readyOwner({ exitOnClose: true });

    await expect(ready.stopForRelaunch()).resolves.toBe(0);

    expect(closes(child)).toBe(1);
    expect(child.kill).not.toHaveBeenCalled();
    // The lost path (BST-2004): the profile fails this owner and the next acquire relaunches.
    expect(onLost).toHaveBeenCalledExactlyOnceWith(0, { requested: true });
    // Retiring the failed owner is not a failed close.
    await expect(owner.close()).resolves.toBeUndefined();
    expect(closes(child)).toBe(1);
  });

  it('joins a child that takes longer than any old refusal, escalating to kill only after the cooperative rung', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { child, cooperativeMs, onLost, ready } = await readyOwner({ exitOnClose: false });
      let exitCode: number | undefined;
      const stopping = ready.stopForRelaunch().then((code) => {
        exitCode = code;
      });
      await vi.advanceTimersByTimeAsync(cooperativeMs - 1);
      expect(child.kill).not.toHaveBeenCalled();
      expect(exitCode).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(exitCode).toBe(15);
      expect(onLost).toHaveBeenCalledExactlyOnceWith(15, { requested: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a quit during the restart joins the same exit: one close, one kill at most, no failed close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { child, cooperativeMs, onLost, owner, ready } = await readyOwner({
        exitOnClose: false,
      });
      const stopping = ready.stopForRelaunch();
      const quitting = owner.close();
      await vi.advanceTimersByTimeAsync(cooperativeMs);
      await expect(Promise.all([stopping, quitting])).resolves.toEqual([15, undefined]);
      expect(closes(child)).toBe(1);
      expect(child.kill).toHaveBeenCalledOnce();
      // The lease itself was closing when the child exited: no relaunch recovery is due.
      expect(onLost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a quit during the restart does not fail when the child exits as requested', async () => {
    const { child, onLost, owner, ready } = await readyOwner({ exitOnClose: false });
    const stopping = ready.stopForRelaunch();
    const quitting = owner.close();
    await vi.waitFor(() => expect(closes(child)).toBe(1));
    child.exit(0);
    await expect(Promise.all([stopping, quitting])).resolves.toEqual([0, undefined]);
    expect(closes(child)).toBe(1);
    expect(child.kill).not.toHaveBeenCalled();
    // The exit landed before the lease's own close began: it is the relaunch's requested
    // loss, which a retiring profile ignores, and the lease close still succeeds.
    expect(onLost).toHaveBeenCalledExactlyOnceWith(0, { requested: true });
  });

  it('keeps the request on that child: a later child that crashes is still an unrequested loss', async () => {
    const relaunched = await readyOwner({ exitOnClose: true });
    await relaunched.ready.stopForRelaunch();
    expect(relaunched.onLost).toHaveBeenCalledExactlyOnceWith(0, { requested: true });

    const next = await readyOwner({ exitOnClose: true });
    next.child.exit(9);
    expect(next.onLost).toHaveBeenCalledExactlyOnceWith(9, { requested: false });
  });
});

// BST-2118: Main reports the profile's boot acquisition through this reporter.
describe('agent host startup reporting', () => {
  const startupLogger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn() });
  it.each([false, true])(
    'reports a startup its own lease owner closed as a cancellation, never an error (shutdown=%s)',
    async (shuttingDown) => {
      const { createDesktopHostLease } = await import('../../host-lease-manager');
      const { isHostLeaseClosed } = await import('../../desktop-shutdown-state');
      const { reportAgentHostStartupFailure } = await import('../../native-index-activation-error');
      const child = new Child();
      const owner = createDesktopHostLease({ fork: () => child, root });
      const outcome = owner.acquire().then(
        () => undefined,
        (cause: unknown) => cause
      );
      await vi.waitFor(() => expect(child.listenerCount('message')).toBe(1));
      await owner.close();
      const cancelled = await outcome;
      expect(isHostLeaseClosed(cancelled)).toBe(true);
      const logger = startupLogger();
      reportAgentHostStartupFailure(cancelled, shuttingDown, logger);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'Agent host startup cancelled: its lease owner closed'
      );
    }
  );
  it.each([false, true])(
    'still reports a startup that failed without a close as an error (shutdown=%s)',
    async (shuttingDown) => {
      const { createDesktopHostLease } = await import('../../host-lease-manager');
      const { reportAgentHostStartupFailure } = await import('../../native-index-activation-error');
      const child = new Child();
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => child.exit(1));
          return child;
        },
        root,
      });
      const failure = await owner.acquire().then(
        () => undefined,
        (cause: unknown) => cause
      );
      expect(failure).toEqual(new Error('Host utility exited before ready (1)'));
      const logger = startupLogger();
      reportAgentHostStartupFailure(failure, shuttingDown, logger);
      expect(logger.error).toHaveBeenCalledWith('Agent host startup failed', { error: failure });
      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
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
      const owner = createDesktopHostLease({ fork: () => child, root });
      const connecting = settleIpcResult(connect, () => owner.acquire());
      await vi.waitFor(() => expect(child.listenerCount('message')).toBe(1));
      await owner.close();
      expect(await connecting).toMatchObject({
        error: { code: 'desktop.host-lease-closed', kind: 'refusal' },
        ok: false,
      });
      expect(errors).toEqual([]);

      // A host that exits before ready, with no close, is still an untyped fault.
      const failed = new Child();
      const failing = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => failed.exit(1));
          return failed;
        },
        root,
      });
      expect(await settleIpcResult(connect, () => failing.acquire())).toMatchObject({
        error: { kind: 'fault' },
        ok: false,
      });
      expect(errors).toEqual(['Untyped failure crossed a process boundary']);
    } finally {
      stop();
    }
  });
});

describe('parent-only content clear', () => {
  it('waits for both the committed receipt and physical exit without posting ordinary close first', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = false;
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
        return child;
      },
      platformModule: '/fixture.js',
      root,
    });
    await owner.acquire();
    let settled = false;
    const clearing = owner.clearAndRetireContent().then((receipt) => {
      settled = true;
      return receipt;
    });
    await vi.waitFor(() => expect(child.posts).toContainEqual({ method: 'clear-content' }));
    expect(child.posts).not.toContainEqual({ method: 'close' });
    child.emit('message', { deletedChunks: null, deletedFiles: 3, event: 'content-cleared' });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.exit(0);
    expect(await clearing).toEqual({ deletedChunks: null, deletedFiles: 3 });
    expect(attachment.close).toHaveBeenCalledOnce();
    await expect(owner.acquire()).rejects.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('never kills a host whose content clear is still deleting, however long it takes', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const child = new Child();
      child.exitOnClose = false;
      const owner = createDesktopHostLease({
        cooperativeCloseMs: 20,
        fork: () => {
          queueMicrotask(() => child.emit('message', { event: 'ready', record: readyRecord }));
          return child;
        },
        platformModule: '/fixture.js',
        root,
      });
      await owner.acquire();
      const clearing = owner.clearAndRetireContent();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.kill).not.toHaveBeenCalled();
      child.emit('message', { deletedChunks: null, deletedFiles: 1, event: 'content-cleared' });
      child.exit(0);
      await expect(clearing).resolves.toEqual({ deletedChunks: null, deletedFiles: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
  it('refuses to clear a foreign attached host and never fabricates a receipt from exit alone', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    launch.mockResolvedValue(attachment);
    const owner = createDesktopHostLease({ root });
    await owner.acquire();
    await expect(owner.clearAndRetireContent()).rejects.toThrow();
    await owner.close();
  });
});
