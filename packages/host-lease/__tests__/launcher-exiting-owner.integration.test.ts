/**
 * BST-2142: `launchHost` waits out an owner that is starting or exiting. An
 * owner that leaves while it is attached to or raced against sends the
 * launcher back to acquisition, within its one deadline, instead of an error
 * that names an owner that is gone. A live owner that keeps the root stays
 * refused.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForeignLockError, RootLock, RootLockedError } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachHost, type HostAttachment } from '../src/client.js';
import { LiveHostUnavailableError, launchHost } from '../src/launcher.js';
import {
  decodeHostRecord,
  HOST_VERSION,
  type HostRecord,
  PROTOCOL_VERSION,
} from '../src/record.js';
import { publishHostRecord, secureDirectory } from '../src/record-file.js';
import { type HostRuntime, startHost } from '../src/runtime.js';
import { RootContentionError, startupFailure } from '../src/startup-failure.js';

const roots: string[] = [];
const hosts: HostRuntime[] = [];
const clients: HostAttachment[] = [];
const locks: RootLock[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-launch-exit-'));
  roots.push(root);
  await secureDirectory(root);
  return root;
}

afterEach(async () => {
  const fixtureRoots = roots.splice(0);
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const lock of locks.splice(0)) {
    lock.release();
  }
  await Promise.all(fixtureRoots.map((root) => rm(root, { force: true, recursive: true })));
});

/** A live owner in this process: the root lease plus its published record. */
async function liveOwner(root: string): Promise<{ lock: RootLock; record: HostRecord }> {
  const lock = await RootLock.acquire(root);
  locks.push(lock);
  const owner = RootLock.inspect(root)?.owner;
  if (!owner) {
    throw new Error('the fixture owner holds no lease');
  }
  const record = decodeHostRecord({
    endpoint:
      process.platform === 'win32'
        ? String.raw`\\.\pipe\brainstrike-exiting-${process.pid}-${Date.now()}`
        : join(root, 'exiting.sock'),
    hostVersion: HOST_VERSION,
    pid: owner.pid,
    protocolVersion: PROTOCOL_VERSION,
    start: owner.start,
    token: 'e'.repeat(64),
  });
  await publishHostRecord(root, record);
  return { lock, record };
}

/** As a host's close does: retire the record, then give up the root. */
async function exit(root: string, lock: RootLock): Promise<void> {
  await rm(join(root, 'host.json'), { force: true });
  lock.release();
}

const realHost =
  (started: { count: number }) => async (options: Parameters<typeof startHost>[0]) => {
    hosts.push(await startHost(options));
    started.count += 1;
  };

test('an owner that refuses attach because it is closing is waited out, then a new host starts', async () => {
  const root = await freshRoot();
  const exiting = await liveOwner(root);
  const started = { count: 0 };
  const attached: string[] = [];
  const attachment = await launchHost(root, {
    attach: async (target, timeoutMs) => {
      attached.push(target.token);
      if (target.token === exiting.record.token) {
        setTimeout(() => void exit(root, exiting.lock), 50);
        throw new Error('Host is closing');
      }
      return attachHost(target, timeoutMs);
    },
    lifetime: 'cli',
    spawn: realHost(started),
  });
  clients.push(attachment);

  expect(started.count).toBe(1);
  expect(attached).toEqual([exiting.record.token, attachment.record.token]);
});

test('a live owner that keeps the root is refused at the deadline, with its attach failure as cause', async () => {
  const root = await freshRoot();
  const stuck = await liveOwner(root);
  const refusal = new Error('write EPIPE');
  let started = false;
  const at = Date.now();
  const refused = await launchHost(root, {
    attach: () => Promise.reject(refusal),
    lifetime: 'cli',
    spawn: async () => {
      started = true;
    },
    startupTimeoutMs: 300,
  }).catch((cause: unknown) => cause);

  expect(refused).toBeInstanceOf(LiveHostUnavailableError);
  expect(refused).toMatchObject({ cause: refusal, pid: stuck.record.pid });
  expect(Date.now() - at).toBeLessThan(5000);
  expect(started).toBe(false);
});

test('a losing starter whose winner releases before publishing acquires again instead of throwing', async () => {
  const root = await freshRoot();
  const started = { count: 0 };
  let spawns = 0;
  const attachment = await launchHost(root, {
    lifetime: 'cli',
    spawn: async (options) => {
      spawns += 1;
      if (spawns === 1) {
        // The race's winner holds the root, never publishes, and leaves.
        const winner = await RootLock.acquire(root);
        locks.push(winner);
        const owner = RootLock.inspect(root)?.owner;
        setTimeout(() => winner.release(), 50);
        throw new RootLockedError(owner as NonNullable<typeof owner>);
      }
      await realHost(started)(options);
    },
  });
  clients.push(attachment);

  expect(spawns).toBe(2);
  expect(started.count).toBe(1);
});

test('a refusal that arrives after the winner released acquires again', async () => {
  const root = await freshRoot();
  const started = { count: 0 };
  let spawns = 0;
  const attachment = await launchHost(root, {
    lifetime: 'cli',
    spawn: async (options) => {
      spawns += 1;
      if (spawns === 1) {
        throw new RootContentionError('data root is in use by pid 1 on another-host');
      }
      await realHost(started)(options);
    },
  });
  clients.push(attachment);

  expect(spawns).toBe(2);
  expect(started.count).toBe(1);
});

test('a starter report maps to the launcher’s vocabulary by the lease it finds', async () => {
  const root = await freshRoot();
  const refusal = { event: 'failed', kind: 'root-locked', message: 'data root is in use' } as const;
  expect(startupFailure(root, refusal)).toBeInstanceOf(RootContentionError);

  const held = await RootLock.acquire(root);
  locks.push(held);
  expect(startupFailure(root, refusal)).toBeInstanceOf(RootLockedError);
  expect(
    startupFailure(root, { event: 'failed', kind: 'foreign-lock', message: 'foreign' })
  ).toBeInstanceOf(ForeignLockError);

  held.release();
  expect(startupFailure(root, refusal)).toBeInstanceOf(RootContentionError);
  const other = startupFailure(root, { event: 'failed', kind: 'error', message: 'boom' });
  expect(other).not.toBeInstanceOf(RootContentionError);
  expect(other.message).toBe('boom');
});
