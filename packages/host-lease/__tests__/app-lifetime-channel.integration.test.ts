// "A host forked by the app dies with the app" (ADR-0017): an app-lifetime host lives exactly as
// long as its launcher's channel. The channel closes when the app dies, and also when a live app
// lets its host go; either way the host closes and releases its Root.
import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { decodeStartupMessage } from '../src/startup-message.js';

const entry = fileURLToPath(new URL('../src/process-entry.ts', import.meta.url));
const roots: string[] = [];
const hosts: ChildProcess[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    if (host.exitCode === null && host.signalCode === null) {
      host.kill('SIGKILL');
      await once(host, 'exit');
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('an app host closes and releases its Root when its live app closes their channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-app-lifetime-'));
  roots.push(root);
  const start = processStartTime(process.pid);
  if (start === null) {
    throw new Error('The test process has no start time');
  }
  // This process is the app: it forks the host with the IPC channel a launcher keeps.
  const host = fork(
    entry,
    [JSON.stringify({ lifetime: 'app', parent: { pid: process.pid, start }, root })],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }
  );
  hosts.push(host);
  const [message] = await once(host, 'message');
  expect(decodeStartupMessage(message)).toEqual({ event: 'ready' });
  expect(RootLock.inspect(root)?.owner).toMatchObject({ pid: host.pid });

  host.disconnect();
  const [code] = await runWithTimeout(() => once(host, 'exit'), {
    onTimeout: () => new Error('The app host outlived its closed lifetime channel'),
    timeoutMs: 5000,
  });
  expect(code).toBe(0);
  expect(RootLock.inspect(root)?.owner.released).toBe(true);
});
