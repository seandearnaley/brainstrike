// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { HostAttachment, HostLaunchOptions, HostStartOptions } from '@brainstrike/host-lease';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * Lifecycle redesign PR A (R3, owner decision 7.1(i)): a host that is slow to
 * report ready is waited for. Main logs one warning naming the stage it is
 * waiting on; it never retires that host or forks another.
 */
const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@brainstrike/logging', async (original) => ({
  ...(await original<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: logs.warn }),
}));
const launch = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/host-lease', async (original) => ({
  ...(await original<typeof import('@brainstrike/host-lease')>()),
  launchHost: launch,
}));
// The fake utility's pid 123 names no real process: its start time is the one its record
// carries, and it has none once the fake exited, so the owner's exit join completes.
const fake = vi.hoisted(() => ({ live: true }));
vi.mock('@brainstrike/state-store', async (original) => {
  const actual = await original<typeof import('@brainstrike/state-store')>();
  return {
    ...actual,
    processStartTime: (pid: number) =>
      pid === 123 ? (fake.live ? 'child' : null) : actual.processStartTime(pid),
  };
});

class Child extends EventEmitter {
  pid: number | undefined = 123;
  readonly posts: unknown[] = [];
  /** It exits on its cooperative close, so the lease never escalates to this. */
  readonly kill = vi.fn(() => true);
  postMessage(message: unknown): void {
    this.posts.push(message);
    if (JSON.stringify(message) === '{"method":"close"}') {
      queueMicrotask(() => {
        this.pid = undefined;
        fake.live = false;
        this.emit('exit', 0);
      });
    }
  }
}
const root = '/private/host-lease-startup-stall';
const start: HostStartOptions = { lifetime: 'app', parent: { pid: 42, start: 'parent' }, root };
const record = {
  endpoint: '/private/socket',
  hostVersion: '0.1.0',
  pid: 123,
  protocolVersion: 2,
  start: 'child',
  token: 'a'.repeat(64),
};

afterEach(() => {
  vi.useRealTimers();
  logs.warn.mockReset();
  launch.mockReset();
});

it('logs one stall warning for a host silent for 40 s, then attaches the one host it forked', async () => {
  vi.useFakeTimers();
  const attachment: HostAttachment = {
    close: vi.fn(async () => undefined),
    closed: new Promise<void>(() => undefined),
    record,
  };
  launch.mockImplementation(async (_root: string, options: HostLaunchOptions) => {
    await options.spawn(start, new AbortController().signal);
    return attachment;
  });
  const { createDesktopHostLease } = await import('../../host-lease-manager');
  const child = new Child();
  const fork = vi.fn(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const owner = createDesktopHostLease({ fork, root });
  const acquired = owner.acquire();
  try {
    await vi.advanceTimersByTimeAsync(9999);
    expect(logs.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith(
      'The agent host has not reported ready; still waiting for it',
      { elapsedMs: 10_000, pid: 123, stage: 'spawned' }
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(logs.warn).toHaveBeenCalledOnce();
    expect(child.posts).toEqual([{ event: 'lifetime' }]);

    child.emit('message', { event: 'ready', record });
    await expect(acquired).resolves.toBe(attachment);
    expect(fork).toHaveBeenCalledOnce();
    expect(logs.warn).toHaveBeenCalledOnce();
  } finally {
    await owner.close();
  }
});
