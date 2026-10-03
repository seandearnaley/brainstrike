import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import type { HostAttachment } from '../src/client.js';
import { launchHost } from '../src/launcher.js';
import { createNodeHostSpawner } from '../src/node-spawner.js';
import { decodeHostRecord } from '../src/record.js';

const roots: string[] = [];
const clients: HostAttachment[] = [];
const pids = new Map<number, string>();
const spawn = createNodeHostSpawner({
  entrypoint: fileURLToPath(new URL('../src/process-entry.ts', import.meta.url)),
  execArgv: ['--import', 'tsx'],
});
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-process-'));
  roots.push(root);
  return root;
}
async function waitForGone(pid: number, start: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (processStartTime(pid) !== start) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Owned test host ${pid} did not exit`);
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const [pid, start] of pids) {
    if (processStartTime(pid) !== start) {
      continue;
    }
    process.kill(pid, 'SIGTERM');
    await waitForGone(pid, start);
  }
  pids.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('real Node host exits after its last CLI client leaves, but explicit host-start stays alive', async () => {
  for (const lifetime of ['cli', 'persistent'] as const) {
    const root = await freshRoot();
    const client = await launchHost(root, { lifetime, spawn });
    clients.push(client);
    pids.set(client.record.pid, client.record.start);
    const record = decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')));
    expect(record.pid).not.toBe(process.pid);
    expect(record).toEqual(client.record);
    await client.close();
    if (lifetime === 'cli') {
      await waitForGone(record.pid, record.start);
      pids.delete(record.pid);
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(processStartTime(record.pid)).toBe(record.start);
    }
  }
});

test('a SIGKILLed owner leaves a stale record and the next launcher takes over atomically', async () => {
  const root = await freshRoot();
  const old = await launchHost(root, { lifetime: 'persistent', spawn });
  clients.push(old);
  pids.set(old.record.pid, old.record.start);
  process.kill(old.record.pid, 'SIGKILL');
  await waitForGone(old.record.pid, old.record.start);
  pids.delete(old.record.pid);
  expect(decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')))).toEqual(
    old.record
  );
  const next = await launchHost(root, { lifetime: 'cli', spawn });
  clients.push(next);
  pids.set(next.record.pid, next.record.start);
  expect(next.record.pid).not.toBe(old.record.pid);
  expect(next.record.token).not.toBe(old.record.token);
  await next.close();
  await waitForGone(next.record.pid, next.record.start);
  pids.delete(next.record.pid);
});
