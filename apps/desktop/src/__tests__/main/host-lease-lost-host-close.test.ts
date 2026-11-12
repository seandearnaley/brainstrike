// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostAttachment, HostLaunchOptions } from '@brainstrike/host-lease';
import { RootLock } from '@brainstrike/state-store';
import type { MessagePortMain } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * ADR-0017, BST-2477: the next owner's own acquisition is the one place that refuses a Root a
 * native process of a lost host still holds (host-lease's native-tail integration test). Main's
 * close of that host takes no hold of the Root itself, so it never refuses that owner, nor fails
 * because that owner already holds the Root.
 */
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
  readonly kill = vi.fn(() => true);
  /** Its end of Main's lifetime channel, which closes with its process. */
  private lifetime: { close(): void } | undefined;
  postMessage(message: unknown, transfer?: readonly { close(): void }[]): void {
    if (JSON.stringify(message) === '{"event":"lifetime"}') {
      this.lifetime = transfer?.[0];
    }
  }
  /** It finished on its own: its ports close, then Electron reports its exit. */
  exit(): void {
    this.lifetime?.close();
    this.pid = undefined;
    fake.live = false;
    this.emit('exit', 0);
  }
}
const record = {
  endpoint: '/private/socket',
  hostVersion: '0.1.0',
  pid: 123,
  protocolVersion: 2,
  start: 'child',
  token: 'a'.repeat(64),
};
const dataRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  launch.mockReset();
  await Promise.all(dataRoots.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/** A ready host on a real Root that finished, releasing the Root, and exited without Main asking. */
async function lostHost(): Promise<{
  readonly dataRoot: string;
  readonly owner: import('../../host-lease-manager').DesktopHostLease;
}> {
  const { createDesktopHostLease } = await import('../../host-lease-manager');
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-lost-host-'));
  dataRoots.push(dataRoot);
  (await RootLock.acquire(dataRoot)).release();
  const attachment: HostAttachment = {
    close: vi.fn(async () => undefined),
    closed: new Promise<void>(() => undefined),
    record,
  };
  launch.mockImplementation(async (_root: string, options: HostLaunchOptions) => {
    await options.spawn(
      { lifetime: 'app', parent: { pid: 42, start: 'parent' }, root: dataRoot },
      new AbortController().signal
    );
    return attachment;
  });
  fake.live = true;
  const child = new Child();
  const onLost = vi.fn();
  const owner = createDesktopHostLease({
    fork: () => {
      queueMicrotask(() => child.emit('message', { event: 'ready', record }));
      return child;
    },
    lifetimeChannel: () => {
      const port1 = Object.assign(new EventEmitter(), { close: vi.fn(), start: vi.fn() });
      return {
        port1: port1 as unknown as MessagePortMain,
        port2: { close: () => port1.emit('close') } as unknown as MessagePortMain,
      };
    },
    onLost,
    platform: () => ({ close: async () => undefined, port: {} as MessagePortMain }),
    root: dataRoot,
  });
  await owner.acquire();
  child.exit();
  expect(onLost).toHaveBeenCalledExactlyOnceWith({ requested: false });
  return { dataRoot, owner };
}

it('never refuses the next owner that takes the Root while Main closes the host it lost', async () => {
  const { dataRoot, owner } = await lostHost();
  const refusals: unknown[] = [];
  const nextOwner = (): Promise<void> =>
    RootLock.acquire(dataRoot).then(
      (lock) => lock.release(),
      (cause: unknown) => {
        refusals.push(cause);
      }
    );
  // The seam: the first time this process takes an flock while the close runs, the next owner
  // asks for the Root at that moment, while that flock is held.
  const flock: typeof import('@brainstrike/secure-fs-native') = createRequire(import.meta.url)(
    '@brainstrike/secure-fs-native'
  );
  const take = flock.tryExclusiveFlock;
  const asked: Promise<void>[] = [];
  let closing = true;
  vi.spyOn(flock, 'tryExclusiveFlock').mockImplementation((fd) => {
    const held = take(fd);
    if (closing && held) {
      closing = false;
      asked.push(nextOwner());
    }
    return held;
  });
  await owner.close();
  closing = false;
  asked.push(nextOwner());
  await Promise.all(asked);
  expect(refusals).toEqual([]);
});

it('closes the host it lost without failing when the next owner already holds the Root', async () => {
  const { dataRoot, owner } = await lostHost();
  const next = await RootLock.acquire(dataRoot);
  try {
    await expect(owner.close()).resolves.toBeUndefined();
  } finally {
    next.release();
  }
});
