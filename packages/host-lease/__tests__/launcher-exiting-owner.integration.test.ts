/**
 * BST-2142: `launchHost` waits out an owner that is starting or exiting. An
 * owner that leaves while it is attached to or raced against sends the
 * launcher back to acquisition, within its one deadline, instead of an error
 * that names an owner that is gone. A live owner that keeps the root stays
 * refused.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForeignLockError, RootLock, RootLockedError } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachHost, type HostAttachment } from '../src/client.js';
import { LiveHostUnavailableError, launchHost, type StartedHost } from '../src/launcher.js';
import {
  decodeHostRecord,
  HOST_VERSION,
  type HostRecord,
  PROTOCOL_VERSION,
} from '../src/record.js';
import { publishHostRecord, secureDirectory } from '../src/record-file.js';
import {
  HOST_LEASE_CLOSING,
  HOST_LEASE_CONNECTION_CLOSED,
  HostLeaseRefusalError,
} from '../src/refusal.js';
import { type HostRuntime, startHost } from '../src/runtime.js';
import { RootContentionError, startupFailure } from '../src/startup-failure.js';

const roots: string[] = [];
const hosts: HostRuntime[] = [];
const clients: HostAttachment[] = [];
const locks: RootLock[] = [];
const servers: Server[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-launch-exit-'));
  roots.push(root);
  await secureDirectory(root);
  return root;
}

afterEach(async () => {
  const fixtureRoots = roots.splice(0);
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
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

/** An in-process host its launch owns until it settles it; afterEach closes a released one. */
const realHost =
  (started: { count: number }) =>
  async (options: Parameters<typeof startHost>[0]): Promise<StartedHost> => {
    const host = await startHost(options);
    hosts.push(host);
    started.count += 1;
    return { release: async () => undefined, retire: () => host.close() };
  };
const noStart = (onStart: () => void) => async (): Promise<never> => {
  onStart();
  throw new Error('This launch must not start a host');
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
        throw new HostLeaseRefusalError(HOST_LEASE_CLOSING, 'Host is closing');
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

/**
 * An owner's socket that answers the handshake's first request with `reply`,
 * or, when `reply` is undefined, closes the connection without answering.
 */
async function answeringOwner(endpoint: string, reply: object | undefined): Promise<void> {
  const server = createServer((socket) => {
    socket.once('data', () => {
      if (reply === undefined) {
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
}

// BST-2158: the launcher reads a leaving owner from the refusal's code on the
// wire, never from its message.
test('a real attach refused by the coded closing frame is waited out, then a new host starts', async () => {
  const root = await freshRoot();
  const exiting = await liveOwner(root);
  await answeringOwner(exiting.record.endpoint, {
    code: HOST_LEASE_CLOSING,
    message: 'Host is closing',
    method: 'error',
  });
  setTimeout(() => void exit(root, exiting.lock), 50);
  const started = { count: 0 };
  const attachment = await launchHost(root, { lifetime: 'cli', spawn: realHost(started) });
  clients.push(attachment);

  expect(started.count).toBe(1);
  expect(attachment.record.token).not.toBe(exiting.record.token);
});

test('the closing text without its code is terminal: no wait and no other owner', async () => {
  const root = await freshRoot();
  const owner = await liveOwner(root);
  await answeringOwner(owner.record.endpoint, { message: 'Host is closing', method: 'error' });
  setTimeout(() => void exit(root, owner.lock), 50);
  let started = false;
  const refused = await launchHost(root, {
    lifetime: 'cli',
    spawn: async () => {
      started = true;
      throw new Error('A terminal refusal must not start another owner');
    },
  }).catch((cause: unknown) => cause);

  expect(refused).toBeInstanceOf(LiveHostUnavailableError);
  expect(started).toBe(false);
});

test('an owner that drops the connection before answering is waited out as leaving', async () => {
  const root = await freshRoot();
  const exiting = await liveOwner(root);
  await answeringOwner(exiting.record.endpoint, undefined);
  setTimeout(() => void exit(root, exiting.lock), 50);
  const started = { count: 0 };
  const attachment = await launchHost(root, { lifetime: 'cli', spawn: realHost(started) });
  clients.push(attachment);

  expect(started.count).toBe(1);
});

test('the client reports a coded refusal and a lost connection as typed refusals', async () => {
  const root = await freshRoot();
  const closing = await liveOwner(root);
  await answeringOwner(closing.record.endpoint, {
    code: HOST_LEASE_CLOSING,
    message: 'Host is closing',
    method: 'error',
  });
  await expect(attachHost(closing.record)).rejects.toMatchObject({
    code: HOST_LEASE_CLOSING,
    name: 'HostLeaseRefusalError',
  });
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await answeringOwner(closing.record.endpoint, undefined);
  await expect(attachHost(closing.record)).rejects.toMatchObject({
    code: HOST_LEASE_CONNECTION_CLOSED,
    name: 'HostLeaseRefusalError',
  });
});

test('a live owner that keeps the root is refused at the deadline, with its attach failure as cause', async () => {
  const root = await freshRoot();
  const stuck = await liveOwner(root);
  // Transport loss is the evidence of a leaving owner, so this one is waited for.
  const refusal = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  let started = false;
  const at = Date.now();
  const refused = await launchHost(root, {
    attach: () => Promise.reject(refusal),
    lifetime: 'cli',
    spawn: noStart(() => {
      started = true;
    }),
    startupTimeoutMs: 300,
  }).catch((cause: unknown) => cause);

  expect(refused).toBeInstanceOf(LiveHostUnavailableError);
  expect(refused).toMatchObject({ cause: refusal, pid: stuck.record.pid });
  expect(Date.now() - at).toBeLessThan(5000);
  expect(started).toBe(false);
});

test('an authentication failure stays terminal: no wait, no other owner, even when the owner then exits', async () => {
  const root = await freshRoot();
  const owner = await liveOwner(root);
  let started = false;
  const refused = await launchHost(root, {
    attach: () => {
      setTimeout(() => void exit(root, owner.lock), 20);
      return Promise.reject(new Error('Host token authentication failed'));
    },
    lifetime: 'cli',
    spawn: noStart(() => {
      started = true;
    }),
  }).catch((cause: unknown) => cause);

  expect(refused).toBeInstanceOf(LiveHostUnavailableError);
  expect(refused).toMatchObject({ cause: { message: 'Host token authentication failed' } });
  expect(started).toBe(false);
});

test('an attach never outlasts the launch deadline', async () => {
  const root = await freshRoot();
  await liveOwner(root);
  const offered: number[] = [];
  await launchHost(root, {
    attach: (_record, timeoutMs) => {
      offered.push(timeoutMs);
      return Promise.reject(new Error('Host token authentication failed'));
    },
    attachTimeoutMs: 1500,
    lifetime: 'cli',
    spawn: noStart(() => undefined),
    startupTimeoutMs: 300,
  }).catch(() => undefined);

  expect(offered).toHaveLength(1);
  expect(offered[0]).toBeLessThanOrEqual(300);
});

test('a host this launch started that closes during its attach sends the launch back to acquisition', async () => {
  const root = await freshRoot();
  const started = { count: 0 };
  let attaches = 0;
  const attachment = await launchHost(root, {
    attach: async (target, timeoutMs) => {
      attaches += 1;
      if (attaches === 1) {
        // The idle CLI host exits before its first client gets in.
        await hosts.splice(0, 1)[0]?.close();
        throw new HostLeaseRefusalError(HOST_LEASE_CLOSING, 'Host is closing');
      }
      return attachHost(target, timeoutMs);
    },
    lifetime: 'cli',
    spawn: realHost(started),
  });
  clients.push(attachment);

  expect(started.count).toBe(2);
  expect(attaches).toBe(2);
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
      return realHost(started)(options);
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
      return realHost(started)(options);
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
