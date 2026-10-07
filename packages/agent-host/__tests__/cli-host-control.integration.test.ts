import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { loadHostPlatform } from '../src/process-entry.js';
import type { HostEvent } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { removeFixtureRoot } from './fixtures/cooperative-host-fixture.js';

const cli = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const platform = fileURLToPath(new URL('./fixtures/process-platform.mjs', import.meta.url));
const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
const childPids: number[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const host of hosts.splice(0)) {
    await host.close();
  }
  for (const pid of childPids.splice(0)) {
    expect(processStartTime(pid)).toBeNull();
  }
  for (const root of roots.splice(0)) {
    await removeFixtureRoot(root);
  }
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'bs-m3-cli-control-'));
  roots.push(value);
  return value;
}

function command(dataRoot: string, name: 'status' | 'stop'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, '--data-root', dataRoot, '--platform', platform, 'host', name],
      {
        env: {
          BRAINSTRIKE_M3_TEST_TOOL: 'fail',
          LC_ALL: 'C',
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          TZ: 'UTC',
        },
        timeout: 10_000,
        windowsHide: true,
      },
      (cause) => {
        if (!cause) {
          resolve(0);
        } else if (typeof cause.code === 'number') {
          resolve(cause.code);
        } else {
          reject(cause);
        }
      }
    );
  });
}

async function host(dataRoot: string, child = false): Promise<AgentHost> {
  if (child) {
    vi.stubEnv('BRAINSTRIKE_M3_TEST_TOOL', 'child');
  }
  const options = { lifetime: 'persistent' as const, root: dataRoot };
  try {
    const value = await startAgentHost(options, (context) =>
      loadHostPlatform(platform, options, context)
    );
    hosts.push(value);
    return value;
  } finally {
    vi.unstubAllEnvs();
  }
}

test.each(['status', 'stop'] as const)(
  'cold host %s never starts the supplied platform or acquires the root',
  async (name) => {
    const dataRoot = await root();
    const code = await command(dataRoot, name);
    expect(code).toBe(1);
    expect(RootLock.inspect(dataRoot)).toBeNull();
    await expect(access(join(dataRoot, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(dataRoot, 'fixture-platform-pids'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
);

test('host stop returns only after canonical platform and root cleanup', async () => {
  const dataRoot = await root();
  const owner = await host(dataRoot);
  expect(await command(dataRoot, 'stop')).toBe(0);
  // A disconnected socket alone is not joined host shutdown.
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await expect(access(join(dataRoot, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(dataRoot, 'fixture-platform-closed'), 'utf8')).toBe(
    `${process.pid}\n`
  );
  await owner.closed;
});

test('host stop joins the existing scripted native tool before reporting success', async () => {
  const dataRoot = await root();
  const owner = await host(dataRoot, true);
  const client = await attachAgentHost(owner.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Run the existing owned native child fixture.',
    threadId,
  });
  let requested: Extract<HostEvent, { type: 'interaction.requested' }> | undefined;
  await expect
    .poll(async () => {
      requested = (await client.request('thread/read', { fromSeq: 0, threadId })).rows
        .map((row) => row.event)
        .find(
          (event): event is Extract<HostEvent, { type: 'interaction.requested' }> =>
            event.type === 'interaction.requested' && event.runId === runId
        );
      return requested !== undefined;
    })
    .toBe(true);
  if (!requested) {
    throw new Error('Scripted native tool did not request its committed approval');
  }
  await client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: requested.interactionId,
    runId,
    threadId,
  });
  let childPid: number | undefined;
  await expect
    .poll(async () => {
      try {
        childPid = Number(await readFile(join(dataRoot, 'fixture-child-pid'), 'utf8'));
        return Number.isInteger(childPid) && childPid > 0;
      } catch (cause) {
        if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
          return false;
        }
        throw cause;
      }
    })
    .toBe(true);
  if (childPid === undefined) {
    throw new Error('Owned native child identity was not recorded');
  }
  childPids.push(childPid);
  expect(processStartTime(childPid)).not.toBeNull();
  expect(await command(dataRoot, 'stop')).toBe(0);
  expect(processStartTime(childPid)).toBeNull();
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await owner.closed;
});
