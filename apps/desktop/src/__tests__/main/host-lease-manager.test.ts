import { EventEmitter } from 'node:events';
import type { HostAttachment, HostLaunchOptions, HostStartOptions } from '@brainstrike/host-lease';
import type { MessagePortMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/host-lease', async (original) => ({
  ...(await original<typeof import('@brainstrike/host-lease')>()),
  launchHost: launch,
}));

class Child extends EventEmitter {
  pid: number | undefined = 123;
  readonly posts: unknown[] = [];
  readonly kill = vi.fn();
  exitOnClose = true;
  postMessage(message: unknown): void {
    this.posts.push(message);
    // Only the close control ends the utility; the lifetime port arrives at spawn.
    if (this.exitOnClose && JSON.stringify(message) === '{"method":"close"}') {
      queueMicrotask(() => this.exit(0));
    }
  }
  exit(code: number): void {
    this.pid = undefined;
    this.emit('exit', code);
  }
}
const root = '/private/host-lease-test';
const start: HostStartOptions = { lifetime: 'app', parent: { pid: 42, start: 'parent' }, root };
let attachment: HostAttachment;
beforeEach(() => {
  launch.mockReset();
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
      child.emit('message', { event: 'ready' });
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
        queueMicrotask(() => child.emit('message', { event: 'ready' }));
        return child;
      },
      root,
    });
    await owner.acquire();
    await expect(owner.close()).rejects.toBe(cause);
    expect(child.pid).toBeUndefined();
    await expect(owner.close()).rejects.toBe(cause);
  });
  it('keeps failed startup cleanup visible to the reset close barrier', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = false;
    const owner = createDesktopHostLease({
      closeTimeoutMs: 20,
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready', extra: true }));
        return child;
      },
      root,
    });
    await expect(owner.acquire()).rejects.toBeInstanceOf(AggregateError);
    await expect(owner.close()).rejects.toThrow('did not exit');
    expect(child.kill).not.toHaveBeenCalled();
    child.exit(0);
  });
  it('coalesces acquisition and joins its own cooperative exit after detaching', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const fork = vi.fn(() => {
      queueMicrotask(() => child.emit('message', { event: 'ready' }));
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
          queueMicrotask(() => child.emit('message', { event: 'ready' }));
          return child;
        },
        onLost,
        root,
      });
      await owner.acquire();
      child.exit(code);
      expect(onLost).toHaveBeenCalledExactlyOnceWith(code);
      // The loss was reported when it happened; retiring the owner is not a failed close.
      await owner.close();
      expect(child.posts).not.toContainEqual({ method: 'close' });
    }
  });
  it('never reports a loss for a close it asked for, or for a child that exits before ready (BST-2004)', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const asked = new Child();
    const onAskedLost = vi.fn();
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => asked.emit('message', { event: 'ready' }));
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
      closeTimeoutMs: 200,
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready' }));
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
  });
  it('keeps the platform port open while a timed-out host is still cleaning up, and closes it once that host exits', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    // Slow startup: the launcher's startup deadline fires before the host is ready.
    launch.mockImplementation(async (_root: string, options: HostLaunchOptions) => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new Error('Host startup timed out')), 10);
      await options.spawn(start, deadline.signal);
      return attachment;
    });
    // Slow cleanup: the cancelled host outlives the close deadline, still using its platform.
    const child = new Child();
    child.exitOnClose = false;
    const platformClose = vi.fn(async () => undefined);
    const owner = createDesktopHostLease({
      closeTimeoutMs: 20,
      fork: () => child,
      platform: () => ({ close: platformClose, port: {} as MessagePortMain }),
      root,
    });
    await expect(owner.acquire()).rejects.toThrow('Host acquisition and cleanup failed');
    expect(child.posts).toContainEqual({ method: 'close' });
    expect(child.pid).toBe(123);
    expect(platformClose).not.toHaveBeenCalled();
    await expect(owner.close()).rejects.toThrow('did not exit');

    child.exit(0);
    await vi.waitFor(() => expect(platformClose).toHaveBeenCalledOnce());
    // Once that host has exited, its release is complete rather than a stale deadline failure.
    await expect(owner.close()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('gives the host its lifetime port at spawn and lets go of it only after the host exited', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = false;
    const order: string[] = [];
    const owner = createDesktopHostLease({
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready' }));
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
  it('names the utility pid Electron reports at spawn in a close timeout', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    // Electron's utilityProcess has no pid until its spawn event.
    const child = new Child();
    child.pid = undefined;
    child.exitOnClose = false;
    const owner = createDesktopHostLease({
      closeTimeoutMs: 20,
      fork: () => {
        queueMicrotask(() => {
          child.pid = 123;
          child.emit('spawn');
          child.emit('message', { event: 'ready' });
        });
        return child;
      },
      root,
    });
    await owner.acquire();
    await expect(owner.close()).rejects.toThrow('Owned host utility pid 123 did not exit');
    child.exit(0);
  });
  it('surfaces a cleanup timeout without killing its child or claiming the lease is released', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    child.exitOnClose = false;
    const owner = createDesktopHostLease({
      closeTimeoutMs: 20,
      fork: () => {
        queueMicrotask(() => child.emit('message', { event: 'ready' }));
        return child;
      },
      root,
    });
    await owner.acquire();
    await expect(owner.close()).rejects.toThrow('did not exit');
    expect(child.pid).toBe(123);
    expect(child.kill).not.toHaveBeenCalled();
    child.exit(0);
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
        queueMicrotask(() => child.emit('message', { event: 'ready' }));
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
  it('refuses to clear a foreign attached host and never fabricates a receipt from exit alone', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    launch.mockResolvedValue(attachment);
    const owner = createDesktopHostLease({ root });
    await owner.acquire();
    await expect(owner.clearAndRetireContent()).rejects.toThrow();
    await owner.close();
  });
});
