/**
 * BST-2176: which deadline bounds each phase of a launch. Acquisition runs
 * under the launch's startup deadline, 30 s by default. The host this launch
 * started then attaches under its own budget, `attachTimeoutMs` from the
 * moment its starter reported ready, never what the startup deadline has
 * left. An existing owner, or a start race's winner, attaches within what the
 * launch's one deadline has left (BST-2142).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type LockOwner, RootLock, RootLockedError } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { attachHost, type HostAttachment } from '../src/client.js';
import { LiveHostUnavailableError, launchHost, type StartedHost } from '../src/launcher.js';
import {
  decodeHostRecord,
  HOST_VERSION,
  type HostRecord,
  PROTOCOL_VERSION,
} from '../src/record.js';
import { publishHostRecord, secureDirectory } from '../src/record-file.js';
import { type HostRuntime, startHost } from '../src/runtime.js';

const roots: string[] = [];
const hosts: HostRuntime[] = [];
const clients: HostAttachment[] = [];
const locks: RootLock[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-launch-deadline-'));
  roots.push(root);
  await secureDirectory(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  const fixtureRoots = roots.splice(0);
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const lock of locks.splice(0)) {
    lock.release();
  }
  await Promise.all(fixtureRoots.map((root) => rm(root, { force: true, recursive: true })));
});

// A slow cold start: ready 700 ms into a 1000 ms startup deadline leaves 300 ms
// of it, less than the 500 ms its handshake takes and well within an 800 ms
// attach budget.
const STARTUP_MS = 1000;
const READY_AT_MS = 700;
const ATTACH_BUDGET_MS = 800;
const HANDSHAKE_MS = 500;

/**
 * An attach whose handshake takes `takesMs`: offered at least that long it
 * attaches; offered less, it times out at the budget it was offered.
 */
function slowAttach(takesMs: number, offered: number[]) {
  return async (record: HostRecord, timeoutMs: number): Promise<HostAttachment> => {
    offered.push(timeoutMs);
    if (timeoutMs < takesMs) {
      await sleep(timeoutMs);
      throw new Error(`Host pid ${record.pid} initialize/attach timed out`);
    }
    await sleep(takesMs);
    return attachHost(record, timeoutMs);
  };
}

interface Settled {
  released: number;
  retired: number;
}
/** A starter whose in-process host reports ready `READY_AT_MS` into the launch. */
function lateStarter(launchedAt: number, settled: Settled) {
  return async (options: Parameters<typeof startHost>[0]): Promise<StartedHost> => {
    const host = await startHost(options);
    hosts.push(host);
    await sleep(Math.max(0, launchedAt + READY_AT_MS - Date.now()));
    return {
      release: async () => {
        settled.released += 1;
      },
      retire: async () => {
        settled.retired += 1;
        await host.close();
      },
    };
  };
}

interface LateOwner {
  readonly lease: LockOwner;
  /** Settles once the owner's record is published, `READY_AT_MS` into the launch. */
  readonly published: Promise<void>;
  readonly record: HostRecord;
}
/** An owner in this process that holds the root now and publishes its record late. */
async function lateOwner(root: string, launchedAt: number): Promise<LateOwner> {
  const lock = await RootLock.acquire(root);
  locks.push(lock);
  const lease = RootLock.inspect(root)?.owner;
  if (!lease) {
    throw new Error('the fixture owner holds no lease');
  }
  const record = decodeHostRecord({
    endpoint:
      process.platform === 'win32'
        ? String.raw`\\.\pipe\brainstrike-late-${process.pid}-${Date.now()}`
        : join(root, 'late.sock'),
    hostVersion: HOST_VERSION,
    pid: lease.pid,
    protocolVersion: PROTOCOL_VERSION,
    start: lease.start,
    token: 'd'.repeat(64),
  });
  const published = sleep(Math.max(0, launchedAt + READY_AT_MS - Date.now())).then(() =>
    publishHostRecord(root, record)
  );
  return { lease, published, record };
}

function rootFree(root: string): boolean {
  const owner = RootLock.inspect(root)?.owner;
  return owner === undefined || owner.released === true;
}

test('a host this launch started late in its startup deadline still gets its whole attach budget', async () => {
  const root = await freshRoot();
  const settled = { released: 0, retired: 0 };
  const offered: number[] = [];
  const attachment = await launchHost(root, {
    attach: slowAttach(HANDSHAKE_MS, offered),
    attachTimeoutMs: ATTACH_BUDGET_MS,
    lifetime: 'cli',
    spawn: lateStarter(Date.now(), settled),
    startupTimeoutMs: STARTUP_MS,
  });
  clients.push(attachment);

  expect(settled).toEqual({ released: 1, retired: 0 });
  expect(hosts[0]?.clientCount).toBe(1);
  expect(offered).toHaveLength(1);
  expect(offered[0]).toBeGreaterThan(STARTUP_MS - READY_AT_MS);
  expect(offered[0]).toBeLessThanOrEqual(ATTACH_BUDGET_MS);
});

test('a host this launch started that overruns its own attach budget is retired, and the root is free', async () => {
  const root = await freshRoot();
  const settled = { released: 0, retired: 0 };
  const offered: number[] = [];
  const refused = await launchHost(root, {
    attach: slowAttach(ATTACH_BUDGET_MS + 200, offered),
    attachTimeoutMs: ATTACH_BUDGET_MS,
    lifetime: 'cli',
    spawn: lateStarter(Date.now(), settled),
    startupTimeoutMs: STARTUP_MS,
  }).catch((cause: unknown) => cause);

  expect(refused).toBeInstanceOf(LiveHostUnavailableError);
  expect(settled).toEqual({ released: 0, retired: 1 });
  expect(rootFree(root)).toBe(true);
  expect(offered).toHaveLength(1);
  expect(offered[0]).toBeLessThanOrEqual(ATTACH_BUDGET_MS);
});

test('an existing owner that publishes late is attached within what the launch deadline has left', async () => {
  const root = await freshRoot();
  const offered: number[] = [];
  const owner = await lateOwner(root, Date.now());
  let started = false;
  const refused = await launchHost(root, {
    attach: slowAttach(HANDSHAKE_MS, offered),
    attachTimeoutMs: ATTACH_BUDGET_MS,
    lifetime: 'cli',
    spawn: async () => {
      started = true;
      throw new Error('This launch must not start a host');
    },
    startupTimeoutMs: STARTUP_MS,
  }).catch((cause: unknown) => cause);
  await owner.published;

  expect(refused).toBeInstanceOf(LiveHostUnavailableError);
  expect(refused).toMatchObject({ pid: owner.record.pid });
  expect(started).toBe(false);
  expect(offered).toHaveLength(1);
  expect(offered[0]).toBeLessThanOrEqual(STARTUP_MS - READY_AT_MS);
});

test('a start race winner that publishes late is attached within what the launch deadline has left', async () => {
  const root = await freshRoot();
  const offered: number[] = [];
  const launchedAt = Date.now();
  let winner: LateOwner | undefined;
  const refused = await launchHost(root, {
    attach: slowAttach(HANDSHAKE_MS, offered),
    attachTimeoutMs: ATTACH_BUDGET_MS,
    lifetime: 'cli',
    // This starter loses the race to an owner that took the root first.
    spawn: async () => {
      winner = await lateOwner(root, launchedAt);
      throw new RootLockedError(winner.lease);
    },
    startupTimeoutMs: STARTUP_MS,
  }).catch((cause: unknown) => cause);
  await winner?.published;

  expect(refused).toBeInstanceOf(LiveHostUnavailableError);
  expect(refused).toMatchObject({ pid: winner?.record.pid });
  expect(offered).toHaveLength(1);
  expect(offered[0]).toBeLessThanOrEqual(STARTUP_MS - READY_AT_MS);
});

test('by default a launch gives the host it starts 30 s to report ready', async () => {
  const root = await freshRoot();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const spawned = Promise.withResolvers<AbortSignal>();
  const launching = launchHost(root, {
    lifetime: 'cli',
    spawn: (_options, signal) => {
      spawned.resolve(signal);
      return new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
    },
  }).catch((cause: unknown) => cause);
  const signal = await spawned.promise;

  vi.advanceTimersByTime(29_999);
  expect(signal.aborted).toBe(false);
  vi.advanceTimersByTime(1);
  expect(signal.aborted).toBe(true);
  expect(await launching).toMatchObject({ message: 'Host startup timed out' });
});
