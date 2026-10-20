/**
 * Lifecycle redesign PR A (R2, R3): readiness is the started host's ready
 * message, and only an exit or a failed report ends a start. The launch that
 * started a host attaches to it from the record its ready message carried: it
 * never rediscovers that host through host.json or the root lease, and no
 * clock retires it or forks another while it is slow.
 */
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LockOwner } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { HostAttachment } from '../src/client.js';
import { launchHost } from '../src/launcher.js';
import { HOST_VERSION, type HostRecord, PROTOCOL_VERSION } from '../src/record.js';
import type { HostStartOptions } from '../src/runtime.js';

const fixture = vi.hoisted(() => ({
  lease: undefined as LockOwner | undefined,
  /** Reads of host.json once the launch's own host has reported ready. */
  readsOfStartedHost: 0,
  started: false,
}));
const CHILD = { pid: 4242, start: 'child-start' } as const;
vi.mock('@brainstrike/state-store', async (original) => {
  const actual = await original<typeof import('@brainstrike/state-store')>();
  return {
    ...actual,
    assertNotSyncedRoot: () => undefined,
    canonicalRoot: (root: string) => root,
    processStartTime: (pid: number) =>
      pid === CHILD.pid ? CHILD.start : actual.processStartTime(pid),
    RootLock: {
      inspect: () => (fixture.lease ? { gen: 1, owner: fixture.lease } : null),
    },
  };
});
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  stat: async () => ({ mode: 0o4_0700, uid: process.getuid?.() }),
}));
// A loaded machine: once the host has published, reading its record takes 5 s.
vi.mock('../src/record-file.js', async (original) => ({
  ...(await original<typeof import('../src/record-file.js')>()),
  readHostRecord: async () => {
    if (!fixture.started) {
      return null;
    }
    fixture.readsOfStartedHost += 1;
    await sleep(5000);
    return record;
  },
}));

const root = '/private/brainstrike-launcher-ready-record';
const record: HostRecord = {
  endpoint: '/private/brainstrike-launcher-ready-record/s',
  hostVersion: HOST_VERSION,
  pid: CHILD.pid,
  protocolVersion: PROTOCOL_VERSION,
  start: CHILD.start,
  token: 'a'.repeat(64),
};
function attachment(): HostAttachment {
  return { close: async () => undefined, closed: new Promise(() => undefined), record };
}
/** The child holds the root and has published its record, as it does before it reports ready. */
function publish(): void {
  fixture.lease = { host: hostname(), pid: CHILD.pid, root, start: CHILD.start, token: 'lease' };
  fixture.started = true;
}
function startedHost() {
  const started = {
    identity: { pid: CHILD.pid, start: CHILD.start },
    record,
    release: vi.fn(async () => undefined),
    retire: vi.fn(async () => undefined),
  };
  return started;
}

beforeEach(() => {
  fixture.lease = undefined;
  fixture.readsOfStartedHost = 0;
  fixture.started = false;
});
afterEach(() => {
  vi.useRealTimers();
});

test('a host that reported ready is attached from its ready record however slow the attach', async () => {
  const started = startedHost();
  const own = attachment();
  // Ready at t=0: the starter returns at once.
  const spawn = vi.fn(async (_options: HostStartOptions, _signal: AbortSignal) => {
    publish();
    return started;
  });
  // The public socket handshake, and the started host's own initialize, each take 5 s.
  const attach = vi.fn(async (_record: HostRecord, _timeoutMs: number) => {
    await sleep(5000);
    return attachment();
  });
  const attachStarted = vi.fn(async (_record: HostRecord) => {
    await sleep(5000);
    return own;
  });
  const options = { attach, attachStarted, lifetime: 'app' as const, spawn };

  await expect(launchHost(root, options)).resolves.toBe(own);

  expect(spawn).toHaveBeenCalledOnce();
  expect(attachStarted).toHaveBeenCalledExactlyOnceWith(record);
  expect(fixture.readsOfStartedHost).toBe(0);
  expect(attach).not.toHaveBeenCalled();
  expect(started.retire).not.toHaveBeenCalled();
  expect(started.release).toHaveBeenCalledOnce();
}, 20_000);

test('a host silent for 40 s is not retired or forked again; it is attached once ready', async () => {
  vi.useFakeTimers();
  let started: ReturnType<typeof startedHost> | undefined;
  const spawn = vi.fn(
    (_options: HostStartOptions, signal: AbortSignal) =>
      new Promise<ReturnType<typeof startedHost>>((resolve, reject) => {
        const ready = setTimeout(() => {
          publish();
          started = startedHost();
          resolve(started);
        }, 40_000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(ready);
            reject(signal.reason);
          },
          { once: true }
        );
      })
  );
  const own = attachment();
  const attachStarted = vi.fn(async (_record: HostRecord) => own);
  const options = { attachStarted, lifetime: 'app' as const, spawn };

  const outcome = launchHost(root, options).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.advanceTimersByTimeAsync(40_000);

  expect(await outcome).toEqual({ value: own });
  expect(spawn).toHaveBeenCalledOnce();
  expect(started?.retire).not.toHaveBeenCalled();
  expect(attachStarted).toHaveBeenCalledExactlyOnceWith(record);
});
