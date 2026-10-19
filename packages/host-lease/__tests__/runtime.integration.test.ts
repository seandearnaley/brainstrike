import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachHost, type HostAttachment } from '../src/client.js';
import { decodeHostRecord, PROTOCOL_VERSION } from '../src/record.js';
import { type HostRuntime, startHost } from '../src/runtime.js';

const roots: string[] = [];
const hosts: HostRuntime[] = [];
const clients: HostAttachment[] = [];
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-lease-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('publishes the private complete host record, attaches with initialize, and releases only its own record', async () => {
  const root = await freshRoot();
  const host = await startHost({ lifetime: 'persistent', root });
  hosts.push(host);
  const published = decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')));
  expect(published).toEqual(host.record);
  expect(published.pid).toBe(process.pid);
  expect(published.start).toBe(processStartTime(process.pid));
  expect(Buffer.from(published.token, 'hex')).toHaveLength(32);
  if (process.platform !== 'win32') {
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'host.json'))).mode & 0o777).toBe(0o600);
  }
  expect((await readdir(root)).sort()).toEqual(['host.json', 'lock']);
  const client = await attachHost(published);
  clients.push(client);
  expect(client.record).toEqual(published);
  expect(host.clientCount).toBe(1);
  await expect(attachHost({ ...published, token: 'b'.repeat(64) })).rejects.toThrow(
    /token|authentication/
  );
  expect(host.clientCount).toBe(1);
  await client.close();
  await host.close();
  expect(RootLock.inspect(root)?.owner.released).toBe(true);
  expect(await readdir(root)).toEqual(['lock']);
});

test('a CLI host retains an active run after its last client leaves and exits after the run releases', async () => {
  const root = await freshRoot();
  const host = await startHost({ lifetime: 'cli', root });
  hosts.push(host);
  const release = host.retainRun();
  const client = await attachHost(host.record);
  clients.push(client);
  let closed = false;
  const observation = Promise.allSettled([
    host.closed.then(() => {
      closed = true;
    }),
  ]);
  await client.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(host.clientCount).toBe(0);
  expect(closed).toBe(false);
  release();
  await host.closed;
  expect(await observation).toEqual([{ status: 'fulfilled', value: undefined }]);
  expect(closed).toBe(true);
  expect(() => host.retainRun()).toThrow(/closing/);
});

test('a joined exit observation exposes the original cleanup rejection', async () => {
  const root = await freshRoot();
  const failure = new Error('Injected root cleanup failure');
  const host = await startHost(
    { lifetime: 'persistent', root },
    {
      acceptSocket: () => {
        throw new Error('This fixture admits no client');
      },
      acquireRoot: async () => {
        const lock = await RootLock.acquire(root);
        return {
          close: async () => {
            lock.release();
            throw failure;
          },
          lock,
        };
      },
      protocolVersion: PROTOCOL_VERSION,
    }
  );
  // Attach rejection handling immediately, then inspect its outcome at the join.
  const observation = Promise.allSettled([
    host.closed.then(() => {
      throw new Error('A failed close must never notify a successful observer');
    }),
  ]);
  await expect(host.close()).rejects.toBe(failure);
  expect(await observation).toEqual([{ reason: failure, status: 'rejected' }]);
  expect(RootLock.inspect(root)?.owner.released).toBe(true);
});

// BST-2170: the startup grace fires once. A host that no client ever attached, holding a run when
// it fires (a run HostCore.open recovered), must still exit when that run releases.
test('a never-attached CLI host that holds a run past its startup grace exits when the run releases', async () => {
  const root = await freshRoot();
  const host = await startHost({ lifetime: 'cli', root, startupGraceMs: 20 });
  hosts.push(host);
  const release = host.retainRun();
  let closed = false;
  const observation = Promise.allSettled([
    host.closed.then(() => {
      closed = true;
    }),
  ]);
  await delay(300);
  expect(closed).toBe(false);
  release();
  await host.closed;
  expect(await observation).toEqual([{ status: 'fulfilled', value: undefined }]);
  expect(RootLock.inspect(root)?.owner.released).toBe(true);
});

test('an app host a client attached after its startup grace follows its app, not the grace', async () => {
  const root = await freshRoot();
  // This process is the host; its real OS parent plays the app.
  const start = processStartTime(process.ppid);
  if (start === null) {
    throw new Error('The test process has no live parent');
  }
  const host = await startHost({
    lifetime: 'app',
    parent: { pid: process.ppid, start },
    root,
    startupGraceMs: 20,
  });
  hosts.push(host);
  const release = host.retainRun();
  let closed = false;
  const observation = Promise.allSettled([
    host.closed.then(() => {
      closed = true;
    }),
  ]);
  await delay(300);
  const client = await attachHost(host.record);
  await client.close();
  release();
  await delay(200);
  expect(host.clientCount).toBe(0);
  expect(closed).toBe(false);
  await host.close();
  expect(await observation).toEqual([{ status: 'fulfilled', value: undefined }]);
});

test('an attached client observes host termination without another protocol request', async () => {
  const root = await freshRoot();
  const host = await startHost({ lifetime: 'persistent', root });
  hosts.push(host);
  const client = await attachHost(host.record);
  clients.push(client);
  expect(client.closed).toBeInstanceOf(Promise);
  await host.close();
  await client.closed;
});

test('failure after record rename rolls back the published record and releases its root lease', async () => {
  const root = await freshRoot();
  const canonicalRoot = await realpath(root);
  const fs = createRequire(import.meta.url)(
    'node:fs/promises'
  ) as typeof import('node:fs/promises');
  const original = fs.rename;
  let failed = false;
  const patched: typeof original = async (path, target) => {
    await original(path, target);
    if (String(target) === join(canonicalRoot, 'host.json') && !failed) {
      failed = true;
      throw new Error('metadata rename acknowledgement failed');
    }
  };
  (fs as { rename: unknown }).rename = patched;
  syncBuiltinESMExports();
  try {
    const opening = startHost({ lifetime: 'persistent', root }).then((host) => {
      hosts.push(host);
      return host;
    });
    await expect(opening).rejects.toThrow(/metadata rename acknowledgement failed/);
    expect(await readdir(root)).toEqual(['lock']);
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
  } finally {
    (fs as { rename: unknown }).rename = original;
    syncBuiltinESMExports();
  }
});
