import { EventEmitter } from 'node:events';
import type { HostAttachment, HostLaunchOptions, HostStartOptions } from '@brainstrike/host-lease';
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
    if (this.exitOnClose) {
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
    expect(child.posts).toEqual([{ method: 'close' }]);
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
  it('closes a newly spawned process when startup is cancelled before ready', async () => {
    const { createDesktopHostLease } = await import('../../host-lease-manager');
    const child = new Child();
    const owner = createDesktopHostLease({ fork: () => child, root });
    const acquiring = owner.acquire();
    const rejected = expect(acquiring).rejects.toThrow('closing');
    await vi.waitFor(() => expect(child.listenerCount('message')).toBe(1));
    await owner.close();
    await rejected;
    expect(child.posts).toEqual([{ method: 'close' }]);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });
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
    expect(child.posts).toEqual([{ method: 'close' }]);
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
    await vi.waitFor(() => expect(child.posts).toHaveLength(1));
    child.exit(7);
    await expect(closing).rejects.toThrow('7');
    await expect(owner.acquire()).rejects.toThrow('closing');
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
