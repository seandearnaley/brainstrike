import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import type { HostAttachment } from '../src/client.js';
import { LiveHostUnavailableError, launchHost } from '../src/launcher.js';
import { decodeHostRecord } from '../src/record.js';
import { readHostRecord, secureDirectory } from '../src/record-file.js';
import { type HostRuntime, startHost } from '../src/runtime.js';

const roots: string[] = [];
const hosts: HostRuntime[] = [];
const clients: HostAttachment[] = [];
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-launch-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  // A cleanup failure must not let the next test delete its retained evidence.
  const fixtureRoots = roots.splice(0);
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(fixtureRoots.map((root) => rm(root, { force: true, recursive: true })));
});

test('CLI-first, app-first, and concurrent launchers attach to exactly one host', async () => {
  for (const order of [
    ['cli', 'app'],
    ['app', 'cli'],
  ] as const) {
    const root = await freshRoot();
    let started = 0;
    const spawn = async (options: Parameters<typeof startHost>[0]): Promise<void> => {
      const host = await startHost(options);
      hosts.push(host);
      started += 1;
    };
    const first = await launchHost(root, { lifetime: order[0], spawn });
    clients.push(first);
    const second = await launchHost(root, { lifetime: order[1], spawn });
    clients.push(second);
    expect(first.record).toEqual(second.record);
    expect(started).toBe(1);
  }
  const root = await freshRoot();
  let started = 0;
  const spawn = async (options: Parameters<typeof startHost>[0]): Promise<void> => {
    const host = await startHost(options);
    hosts.push(host);
    started += 1;
  };
  const attached = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      launchHost(root, { lifetime: i % 2 === 0 ? 'app' : 'cli', spawn })
    )
  );
  clients.push(...attached);
  expect(started).toBe(1);
  expect(new Set(attached.map((client) => client.record.token)).size).toBe(1);
});

test('a live but unreachable owner is named and neither replaced nor killed', async () => {
  const root = await freshRoot();
  const host = await startHost({ lifetime: 'persistent', root });
  hosts.push(host);
  const recordPath = join(root, 'host.json');
  const original = await readFile(recordPath);
  const lease = RootLock.inspect(root);
  const unreachable = decodeHostRecord({
    ...host.record,
    endpoint:
      process.platform === 'win32'
        ? String.raw`\\.\pipe\brainstrike-${randomBytes(12).toString('hex')}`
        : join(root, 'unreachable'),
  });
  try {
    await writeFile(recordPath, JSON.stringify(unreachable), { mode: 0o600 });
    expect(await readHostRecord(root)).toEqual(unreachable);
    let started = false;
    const refused = launchHost(root, {
      lifetime: 'cli',
      spawn: async () => {
        started = true;
      },
      // BST-2142: a refused attach first waits, within this deadline, for the
      // owner to leave; this one keeps its root, so it is refused at the end.
      startupTimeoutMs: 1000,
    }).then((attachment: HostAttachment): HostAttachment => {
      clients.push(attachment);
      return attachment;
    });
    await expect(refused).rejects.toBeInstanceOf(LiveHostUnavailableError);
    await expect(refused).rejects.toMatchObject({
      cause: { code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/) },
      pid: host.record.pid,
    });
    await expect(refused).rejects.toThrow(
      new RegExp(`live.*${host.record.pid}|${host.record.pid}.*unreachable`, 'i')
    );
    expect(started).toBe(false);
    expect(process.kill(host.record.pid, 0)).toBe(true);
    expect(processStartTime(host.record.pid)).toBe(host.record.start);
    expect(RootLock.inspect(root)).toEqual(lease);
    expect(await readFile(recordPath, 'utf8')).toBe(JSON.stringify(unreachable));
  } finally {
    await writeFile(recordPath, original, { mode: 0o600 });
  }
});

test('the shared startup deadline bounds an injected starter and supplies its abort signal', async () => {
  const root = await freshRoot();
  const gate = Promise.withResolvers<void>();
  let settled = false;
  let signal: AbortSignal | undefined;
  const observed = launchHost(root, {
    lifetime: 'cli',
    spawn: (_options, suppliedSignal?: AbortSignal) => {
      signal = suppliedSignal;
      return gate.promise;
    },
    startupTimeoutMs: 25,
  }).then(
    () => {
      settled = true;
      return;
    },
    (cause: unknown) => {
      settled = true;
      return cause;
    }
  );
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(await observed).toBeInstanceOf(Error);
  } finally {
    gate.resolve();
    await observed;
  }
});

test('waits for an exiting owner to release the root, then starts a host instead of failing', async () => {
  const root = await freshRoot();
  await secureDirectory(root);
  // An exiting host has removed its record and still holds the root while its store closes.
  const exiting = await RootLock.acquire(root);
  let started = 0;
  const launching = launchHost(root, {
    lifetime: 'cli',
    spawn: async (options) => {
      hosts.push(await startHost(options));
      started += 1;
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  expect(started).toBe(0);
  exiting.release();
  const attachment = await launching;
  clients.push(attachment);
  expect(started).toBe(1);
  expect(attachment.record.pid).toBe(process.pid);
});

test('a root that stays held past the startup deadline is still refused, bounded', async () => {
  const root = await freshRoot();
  await secureDirectory(root);
  const held = await RootLock.acquire(root);
  try {
    let started = false;
    await expect(
      launchHost(root, {
        lifetime: 'cli',
        spawn: async () => {
          started = true;
        },
        startupTimeoutMs: 100,
      })
    ).rejects.toBeInstanceOf(LiveHostUnavailableError);
    expect(started).toBe(false);
  } finally {
    held.release();
  }
});
