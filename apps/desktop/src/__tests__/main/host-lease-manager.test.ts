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
    await expect(owner.acquire()).rejects.toThrow('closing');
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
      const child = new Child();
      const owner = createDesktopHostLease({ fork: () => child, root });
      const acquiring = owner.acquire();
      const rejected =
        reason === undefined
          ? expect(acquiring).rejects.toThrow('closing')
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
