import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ForeignLockError,
  processStartTime,
  RootLock,
  SyncedRootError,
} from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import type { HostAttachment } from '../src/client.js';
import { launchHost } from '../src/launcher.js';
import { HOST_VERSION, PROTOCOL_VERSION } from '../src/record.js';
import { type HostRuntime, startHost } from '../src/runtime.js';
import { windowsPrivateAcl } from '../src/windows-acl.js';

const roots: string[] = [];
const hosts: HostRuntime[] = [];
const clients: HostAttachment[] = [];
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-refuse-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('a foreign-host lease refuses before attach, spawn or mutation', async () => {
  const root = await freshRoot();
  const lockDir = join(root, 'lock');
  await mkdir(lockDir);
  const owner = {
    host: `foreign-${hostname()}`,
    pid: process.pid,
    root: await realpath(root),
    start: processStartTime(process.pid),
    token: 'foreign-owner',
  };
  const path = join(lockDir, 'g000000000000');
  const original = JSON.stringify(owner);
  await writeFile(path, original);
  let spawned = false;
  await expect(
    launchHost(root, {
      lifetime: 'cli',
      spawn: async () => {
        spawned = true;
      },
    })
  ).rejects.toBeInstanceOf(ForeignLockError);
  expect(spawned).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(original);
});

test('a live lease without a published record names its owner and refuses without spawning', async () => {
  const root = await freshRoot();
  const lease = await RootLock.acquire(root);
  let spawned = false;
  try {
    await expect(
      launchHost(root, {
        lifetime: 'cli',
        spawn: async () => {
          spawned = true;
        },
        startupTimeoutMs: 50,
      })
    ).rejects.toThrow(new RegExp(`Live host pid ${process.pid}`));
    expect(spawned).toBe(false);
    expect(RootLock.inspect(root)?.owner.token).toBe(lease.owner.token);
  } finally {
    lease.release();
  }
});

test('a reused PID with a different start identity is stale even though that PID is alive', async () => {
  const root = await freshRoot();
  await mkdir(join(root, 'lock'));
  const start = process.platform === 'win32' ? '1' : 'Thu Jan  1 00:00:00 1970';
  await writeFile(
    join(root, 'lock', 'g000000000000'),
    JSON.stringify({
      host: hostname(),
      pid: process.pid,
      root: await realpath(root),
      start,
      token: 'reused-pid',
    })
  );
  await writeFile(
    join(root, 'host.json'),
    JSON.stringify({
      endpoint:
        process.platform === 'win32'
          ? '\\\\.\\pipe\\brainstrike-dead'
          : join(root, 'not-listening'),
      hostVersion: HOST_VERSION,
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      start,
      token: 'a'.repeat(64),
    }),
    { mode: 0o600 }
  );
  if (process.platform === 'win32') {
    await windowsPrivateAcl(root, 'directory', 'set');
    await windowsPrivateAcl(join(root, 'host.json'), 'file', 'set');
  }
  const client = await launchHost(root, {
    lifetime: 'cli',
    spawn: async (options) => {
      hosts.push(await startHost(options));
    },
  });
  clients.push(client);
  expect(client.record.start).toBe(processStartTime(process.pid));
  expect(client.record.token).not.toBe('a'.repeat(64));
  expect(RootLock.inspect(root)?.owner.token).not.toBe('reused-pid');
});

test('synced roots refuse before any starter is invoked or directory created', async () => {
  const root = join(homedir(), 'Dropbox', `brainstrike-lease-test-${process.pid}`);
  let spawned = false;
  await expect(
    launchHost(root, {
      lifetime: 'cli',
      spawn: async () => {
        spawned = true;
      },
    })
  ).rejects.toBeInstanceOf(SyncedRootError);
  await expect(startHost({ lifetime: 'persistent', root })).rejects.toBeInstanceOf(SyncedRootError);
  expect(spawned).toBe(false);
  await expect(readFile(join(root, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('an unrelated spawn failure is preserved instead of trying another starter or silently attaching', async () => {
  const root = await freshRoot();
  const cause = new Error('injected spawn failure');
  await expect(
    launchHost(root, {
      lifetime: 'cli',
      spawn: async () => {
        throw cause;
      },
    })
  ).rejects.toBe(cause);
  expect(RootLock.inspect(root)).toBeNull();
});

test.skipIf(process.platform === 'win32')(
  'an exposed discovery directory is refused without changing the live owner',
  async () => {
    const root = await freshRoot();
    const host = await startHost({ lifetime: 'persistent', root });
    hosts.push(host);
    await chmod(root, 0o755);
    let spawned = false;
    await expect(
      launchHost(root, {
        lifetime: 'cli',
        spawn: async () => {
          spawned = true;
        },
      })
    ).rejects.toThrow(new RegExp(`Live host pid ${host.record.pid}`));
    expect(spawned).toBe(false);
    expect(RootLock.inspect(root)?.owner.start).toBe(host.record.start);
  }
);
