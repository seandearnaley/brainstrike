import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachHost, type HostAttachment } from '../src/client.js';
import { decodeHostRecord } from '../src/record.js';
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
  host.closed.then(() => {
    closed = true;
  });
  await client.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(host.clientCount).toBe(0);
  expect(closed).toBe(false);
  release();
  await host.closed;
  expect(closed).toBe(true);
  expect(() => host.retainRun()).toThrow(/closing/);
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
