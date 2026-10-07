import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime, RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
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

function command(
  dataRoot: string,
  name: 'status' | 'stop'
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
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
      (cause, stdout, stderr) => {
        if (!cause) {
          resolve({ code: 0, stderr, stdout });
        } else if (typeof cause.code === 'number') {
          resolve({ code: cause.code, stderr, stdout });
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
    const result = await command(dataRoot, name);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
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
  const result = await command(dataRoot, 'stop');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ outcome: 'stopped', rootReleased: true });
  expect(result.stderr).toBe('');
  // A disconnected socket alone is not joined host shutdown.
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await expect(access(join(dataRoot, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(dataRoot, 'fixture-platform-closed'), 'utf8')).toBe(
    `${process.pid}\n`
  );
  await owner.closed;
  const contender = await StateStore.open(dataRoot);
  await contender.close();
});

test('live host status reports the authenticated owner without stopping it', async () => {
  const dataRoot = await root();
  const owner = await host(dataRoot);
  const result = await command(dataRoot, 'status');
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const { hostVersion, pid, protocolVersion, start } = owner.record;
  expect(JSON.parse(result.stdout)).toEqual({ hostVersion, pid, protocolVersion, start });
  expect(RootLock.inspect(dataRoot)?.owner).toMatchObject({ pid, start });
  await expect(RootLock.acquire(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
  await expect(access(join(dataRoot, 'fixture-platform-closed'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('host stop remains pending while its platform join still owns Root', async () => {
  const dataRoot = await root();
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<void>();
  const options = { lifetime: 'persistent' as const, root: dataRoot };
  const owner = await startAgentHost(options, async (context) => {
    const selected = await loadHostPlatform(platform, options, context);
    const close = selected.close?.bind(selected);
    selected.close = async () => {
      entered.resolve();
      await joined.promise;
      await close?.();
    };
    return selected;
  });
  hosts.push(owner);
  let settled = false;
  const stopping = command(dataRoot, 'stop').finally(() => {
    settled = true;
  });
  try {
    await entered.promise;
    await expect(RootLock.acquire(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
    expect(settled).toBe(false);
  } finally {
    joined.resolve();
  }
  const result = await stopping;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ outcome: 'stopped', rootReleased: true });
  await owner.closed;
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
});

test('host stop reports failed platform cleanup without claiming Root release', async () => {
  const dataRoot = await root();
  const options = { lifetime: 'persistent' as const, root: dataRoot };
  const owner = await startAgentHost(options, async (context) => {
    const selected = await loadHostPlatform(platform, options, context);
    selected.close = async () => {
      throw new Error('Owned CLI fixture cleanup failed');
    };
    return selected;
  });
  hosts.push(owner);
  const store = owner.core.store;
  if (!(store instanceof StateStore)) {
    throw new Error('CLI shutdown fixture did not acquire its real SQLite store');
  }
  try {
    const result = await command(dataRoot, 'stop');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/cleanup failed/i);
    await expect(owner.closed).rejects.toThrow();
    await expect(RootLock.acquire(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    // This fixture has no external resources. Preserve the failed production
    // close, then release only the test-owned SQLite store for fixture teardown.
    await store.close();
    hosts.splice(hosts.indexOf(owner), 1);
  }
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
  const result = await command(dataRoot, 'stop');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ outcome: 'stopped', rootReleased: true });
  expect(result.stderr).toBe('');
  expect(processStartTime(childPid)).toBeNull();
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await owner.closed;
});
