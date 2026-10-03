import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HostAttachment } from '../src/client.js';
import { launchHost } from '../src/launcher.js';
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
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
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
  const unreachable = { ...host.record, endpoint: join(root, 'unreachable') };
  await writeFile(join(root, 'host.json'), JSON.stringify(unreachable), { mode: 0o600 });
  let started = false;
  await expect(
    launchHost(root, {
      lifetime: 'cli',
      spawn: async () => {
        started = true;
      },
    })
  ).rejects.toThrow(new RegExp(`live.*${host.record.pid}|${host.record.pid}.*unreachable`, 'i'));
  expect(started).toBe(false);
  expect(process.kill(host.record.pid, 0)).toBe(true);
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
