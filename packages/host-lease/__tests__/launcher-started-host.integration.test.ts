/**
 * BST-2167: `launchHost` owns the host its starter started until it settles
 * it, exactly once: `release` when it attached, `retire` when it gives up or
 * that host left on its own. A launch never rejects with a host it started
 * still running, and never retires a host it attached to.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachHost, type HostAttachment } from '../src/client.js';
import { LiveHostUnavailableError, launchHost, type StartedHost } from '../src/launcher.js';
import { secureDirectory } from '../src/record-file.js';
import { HOST_LEASE_CLOSING, HostLeaseRefusalError } from '../src/refusal.js';
import { type HostRuntime, startHost } from '../src/runtime.js';

const roots: string[] = [];
const hosts: HostRuntime[] = [];
const clients: HostAttachment[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-launch-started-'));
  roots.push(root);
  await secureDirectory(root);
  return root;
}

afterEach(async () => {
  const fixtureRoots = roots.splice(0);
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(fixtureRoots.map((root) => rm(root, { force: true, recursive: true })));
});

interface Settled {
  released: number;
  retired: number;
}
/** An in-process host whose launch's settlement is counted; retiring it closes it. */
function counted(host: HostRuntime, settled: Settled, retire?: () => Promise<void>): StartedHost {
  hosts.push(host);
  return {
    record: host.record,
    release: async () => {
      settled.released += 1;
    },
    retire: async () => {
      settled.retired += 1;
      await host.close();
      await retire?.();
    },
  };
}
function rootFree(root: string): boolean {
  const owner = RootLock.inspect(root)?.owner;
  return owner === undefined || owner.released === true;
}

test('a launch that attached releases the host it started, and never retires it', async () => {
  const root = await freshRoot();
  const settled = { released: 0, retired: 0 };
  const attachment = await launchHost(root, {
    lifetime: 'cli',
    spawn: async (options) => counted(await startHost(options), settled),
  });
  clients.push(attachment);

  expect(settled).toEqual({ released: 1, retired: 0 });
  expect(hosts[0]?.clientCount).toBe(1);
});

test('a launch whose attach fails retires the host it started before it rejects', async () => {
  const root = await freshRoot();
  const settled = { released: 0, retired: 0 };
  const refusal = new Error('Host pid 1 initialize/attach timed out');
  const refused = await launchHost(root, {
    attach: () => Promise.reject(refusal),
    lifetime: 'persistent',
    spawn: async (options) => counted(await startHost(options), settled),
  }).catch((cause: unknown) => cause);

  expect(refused).toBeInstanceOf(LiveHostUnavailableError);
  expect(refused).toMatchObject({ cause: refusal });
  expect(settled).toEqual({ released: 0, retired: 1 });
  expect(rootFree(root)).toBe(true);
});

test('a host its starter reports after its caller cancelled is retired, not abandoned', async () => {
  const root = await freshRoot();
  const settled = { released: 0, retired: 0 };
  const caller = new AbortController();
  setTimeout(() => caller.abort(new Error('Host start cancelled')), 25);
  const refused = await launchHost(root, {
    lifetime: 'persistent',
    signal: caller.signal,
    // A starter that sees its signal abort but reports its host started anyway.
    spawn: async (options, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      return counted(await startHost(options), settled);
    },
  }).catch((cause: unknown) => cause);

  expect(refused).toMatchObject({ message: 'Host start cancelled' });
  expect(settled).toEqual({ released: 0, retired: 1 });
  expect(rootFree(root)).toBe(true);
});

test('a host this launch started that left on its own is retired before the launch starts another', async () => {
  const root = await freshRoot();
  const first = { released: 0, retired: 0 };
  const second = { released: 0, retired: 0 };
  let spawns = 0;
  let attaches = 0;
  const attachment = await launchHost(root, {
    attach: async (target, timeoutMs) => {
      attaches += 1;
      if (attaches === 1) {
        // The idle CLI host exits before its first client gets in.
        await hosts[0]?.close();
        throw new HostLeaseRefusalError(HOST_LEASE_CLOSING, 'Host is closing');
      }
      return attachHost(target, timeoutMs);
    },
    lifetime: 'cli',
    spawn: async (options) => {
      spawns += 1;
      return counted(await startHost(options), spawns === 1 ? first : second);
    },
  });
  clients.push(attachment);

  expect({ first, second }).toEqual({
    first: { released: 0, retired: 1 },
    second: { released: 1, retired: 0 },
  });
});

test('a started host that fails to retire is reported with the launch failure, not instead of it', async () => {
  const root = await freshRoot();
  const settled = { released: 0, retired: 0 };
  const refusal = new Error('Host pid 1 initialize/attach timed out');
  const retirement = new Error('Host pid 1 did not close cleanly after cancel-startup (1)');
  const refused = await launchHost(root, {
    attach: () => Promise.reject(refusal),
    lifetime: 'cli',
    spawn: async (options) =>
      counted(await startHost(options), settled, () => Promise.reject(retirement)),
  }).catch((cause: unknown) => cause);

  expect(refused).toBeInstanceOf(AggregateError);
  expect((refused as AggregateError).errors).toEqual([
    expect.any(LiveHostUnavailableError),
    retirement,
  ]);
  expect((refused as AggregateError).cause).toBeInstanceOf(LiveHostUnavailableError);
  expect(settled).toEqual({ released: 0, retired: 1 });
});
