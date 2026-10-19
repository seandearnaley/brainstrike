import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HostAttachment } from '../src/client.js';
import { launchHost, type StartedHost } from '../src/launcher.js';
import { type HostRuntime, startHost } from '../src/runtime.js';

// BST-2237: on Windows, host start writes the data root's privacy, and every
// lease check reads it, in this process. A cold PowerShell start once took more
// than its 5 s budget there. POSIX is out of scope: its lease check still reads
// process start times by running `ps` (state-store).
const windowsTest = test.skipIf(process.platform !== 'win32');

// Node publishes every ChildProcess spawn (spawn, execFile, exec, fork) on this
// channel before the process starts. spawnSync publishes nothing; the only
// synchronous spawn on these paths, state-store's `ps`, is POSIX-only.
const SPAWN_START = 'tracing:child_process.spawn:start';

const roots: string[] = [];
const hosts: HostRuntime[] = [];
const clients: HostAttachment[] = [];
afterEach(async () => {
  const fixtureRoots = roots.splice(0);
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(fixtureRoots.map((root) => rm(root, { force: true, recursive: true })));
});
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-no-process-'));
  roots.push(root);
  return root;
}
/** An in-process host its launch owns until it settles it; afterEach closes a released one. */
function owned(host: HostRuntime): StartedHost {
  hosts.push(host);
  return {
    identity: { pid: host.record.pid, start: host.record.start },
    release: async () => undefined,
    retire: () => host.close(),
  };
}
/** The executable of every process `run` started, in order. */
async function processesStartedBy(
  run: () => Promise<HostAttachment>
): Promise<{ readonly client: HostAttachment; readonly started: readonly string[] }> {
  const started: string[] = [];
  const observe = (message: unknown): void => {
    const options =
      typeof message === 'object' && message !== null ? Reflect.get(message, 'options') : null;
    const file =
      typeof options === 'object' && options !== null ? Reflect.get(options, 'file') : null;
    started.push(String(file));
  };
  subscribe(SPAWN_START, observe);
  try {
    const client = await run();
    clients.push(client);
    return { client, started };
  } finally {
    unsubscribe(SPAWN_START, observe);
  }
}

windowsTest('a launch that attaches to a live owner starts no process', async () => {
  const root = await freshRoot();
  const host = await startHost({ lifetime: 'persistent', root });
  hosts.push(host);
  const { client, started } = await processesStartedBy(() =>
    launchHost(root, {
      lifetime: 'cli',
      spawn: async () => {
        throw new Error('This launch must not start a host');
      },
    })
  );
  expect(started).toEqual([]);
  expect(client.record).toEqual(host.record);
});

windowsTest('a launch that starts and attaches to its own host starts no process', async () => {
  const root = await freshRoot();
  let started = 0;
  const launched = await processesStartedBy(() =>
    launchHost(root, {
      lifetime: 'cli',
      spawn: async (options) => {
        started += 1;
        return owned(await startHost(options));
      },
    })
  );
  expect(launched.started).toEqual([]);
  expect(started).toBe(1);
});
