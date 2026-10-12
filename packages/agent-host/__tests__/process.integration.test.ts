import { type ChildProcess, execFile, fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeHostRecord, decodeStartupMessage, type HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, authenticateHostClient, type HostClient } from '../src/client.js';
import { type HostEvent, HostLogRowSchema } from '../src/protocol.js';
import { stdioConnection } from '../src/transports.js';
import {
  closeFixtureHost,
  createFixtureCloseControl,
  type FixtureCloseControl,
  fixtureControlEnvironment,
  removeFixtureRoot,
} from './fixtures/cooperative-host-fixture.js';
import { observeFixtureChild, recordFixtureEvent } from './fixtures/owned-fixture-process.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const entryPath = fileURLToPath(new URL('../dist/process-entry.js', import.meta.url));
const platformPath = fileURLToPath(
  new URL(
    process.platform === 'win32'
      ? './fixtures/process-platform-cooperative.mjs'
      : './fixtures/process-platform.mjs',
    import.meta.url
  )
);
const exec = promisify(execFile);
const roots: string[] = [];
const records: HostRecord[] = [];
const clients: HostClient[] = [];
const children: ChildProcess[] = [];
const cliPids = new Map<string, number[]>();
const controls = new Map<string, FixtureCloseControl>();
const ownerControls = new Map<string, FixtureCloseControl>();
const observations = new Map<ChildProcess, ReturnType<typeof observeFixtureChild>>();

function environment(root: string): NodeJS.ProcessEnv {
  const control = controls.get(root);
  return { ...process.env, ...(control ? fixtureControlEnvironment(control) : {}) };
}

function spawnHost(
  entry: string,
  args: string[],
  root: string,
  stdio: 'pipe' | 'ignore'
): ChildProcess {
  if (process.platform === 'win32') {
    return spawn(process.execPath, [entry, ...args], {
      env: environment(root),
      stdio: [stdio, stdio, stdio, 'ipc'],
      windowsHide: true,
    });
  }
  return fork(entry, args, {
    env: environment(root),
    execArgv: [],
    stdio: [stdio, stdio, stdio, 'ipc'],
  });
}

function observe(child: ChildProcess, stdout = true): ReturnType<typeof observeFixtureChild> {
  const value = observeFixtureChild(
    child,
    (pid) => {
      const start = processStartTime(pid);
      if (!start) {
        throw new Error('Cannot identify owned process fixture');
      }
      return { executable: process.execPath, pid, start };
    },
    { stdout }
  );
  observations.set(child, value);
  return value;
}

async function receipt(name: string, value: unknown): Promise<void> {
  const directory = process.env['BRAINSTRIKE_M3_PROCESS_ARTIFACT_DIR'];
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2));
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-process-'));
  roots.push(root);
  if (process.platform === 'win32') {
    controls.set(root, createFixtureCloseControl(root));
  }
  return root;
}
async function record(root: string): Promise<HostRecord> {
  const value = decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')));
  if (!records.some((item) => item.pid === value.pid && item.start === value.start)) {
    records.push(value);
  }
  const control = controls.get(root);
  if (control) {
    ownerControls.set(`${value.pid}:${value.start}`, control);
  }
  recordFixtureEvent('observed-host-owner', {
    identity: { executable: process.execPath, pid: value.pid, start: value.start },
    root,
  });
  return value;
}
async function cli(root: string, args: string[], tool?: string): Promise<unknown> {
  const invocation = exec(
    process.execPath,
    [cliPath, '--root', root, '--platform', platformPath, ...args],
    {
      env: { ...environment(root), BRAINSTRIKE_M3_TEST_TOOL: tool },
      windowsHide: true,
    }
  );
  const observed = observe(invocation.child);
  invocation.child.stdin?.end();
  if (invocation.child.pid) {
    cliPids.set(root, [...(cliPids.get(root) ?? []), invocation.child.pid]);
  }
  try {
    const { stdout } = await invocation;
    return JSON.parse(stdout);
  } finally {
    await observed.done;
  }
}
async function gone(owner: HostRecord): Promise<void> {
  await expect.poll(() => processStartTime(owner.pid)).not.toBe(owner.start);
}
async function released(root: string): Promise<void> {
  await expect.poll(() => RootLock.inspect(root)?.owner.released).toBe(true);
  await expect(readFile(join(root, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}
async function stopHost(owner: HostRecord): Promise<void> {
  if (processStartTime(owner.pid) === owner.start) {
    if (process.platform === 'win32') {
      const control = ownerControls.get(`${owner.pid}:${owner.start}`);
      if (!control) {
        throw new Error('Missing owned Windows host fixture control');
      }
      await closeFixtureHost(owner, control);
    } else {
      process.kill(owner.pid, 'SIGTERM');
    }
  }
  await gone(owner);
}
async function event<T extends HostEvent['type']>(
  client: HostClient,
  threadId: string,
  type: T
): Promise<Extract<HostEvent, { type: T }>> {
  let found: Extract<HostEvent, { type: T }> | undefined;
  await expect
    .poll(async () => {
      found = (await client.request('thread/read', { fromSeq: 0, threadId })).rows
        .map((row) => row.event)
        .find((item): item is Extract<HostEvent, { type: T }> => item.type === type);
      return found !== undefined;
    })
    .toBe(true);
  if (!found) {
    throw new Error('Expected committed process event');
  }
  return found;
}

afterEach(async (context) => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  // Join persistent owners cooperatively before disposing their observation pipes.
  for (const owner of records.splice(0)) {
    await stopHost(owner);
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      recordFixtureEvent('explicit-failed-process-fixture-teardown', { pid: child.pid });
      child.kill('SIGKILL');
    }
    await observations.get(child)?.done;
  }
  for (const root of roots.splice(0)) {
    if (context.task.result?.state === 'fail') {
      recordFixtureEvent('preserved-failed-process-root', { root });
      continue;
    }
    await removeFixtureRoot(root);
  }
  controls.clear();
  ownerControls.clear();
  observations.clear();
});

test('ordinary CLI starts a separate persistent host, reuses it after client loss and Stop joins a real child', async () => {
  const root = await freshRoot();
  await cli(root, ['host', 'start'], 'child');
  const owner = await record(root);
  expect(owner.pid).not.toBe(process.pid);
  const runtime: unknown = JSON.parse(
    await readFile(join(root, 'fixture-platform-runtime'), 'utf8')
  );
  expect(runtime).toMatchObject({ electron: null, execPath: process.execPath, pid: owner.pid });
  expect(await cli(root, ['host', 'status'])).toMatchObject({ pid: owner.pid, start: owner.start });
  expect((await readFile(join(root, 'fixture-platform-pids'), 'utf8')).trim().split('\n')).toEqual([
    String(owner.pid),
  ]);
  const thread = await cli(root, ['thread', 'start']);
  const { threadId } = (await import('../src/protocol.js')).HOST_RESULT_SCHEMAS[
    'thread/start'
  ].parse(thread);
  const client = await attachAgentHost(owner);
  clients.push(client);
  const run = await cli(root, [
    'run',
    'start',
    '--thread',
    threadId,
    '--model',
    'scripted',
    '--prompt',
    'Run the native child.',
  ]);
  const { runId } = (await import('../src/protocol.js')).HOST_RESULT_SCHEMAS['run/start'].parse(
    run
  );
  const approval = await event(client, threadId, 'interaction.requested');
  const follower = spawn(
    process.execPath,
    [cliPath, '--root', root, 'log', 'follow', '--thread', threadId],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(follower);
  observe(follower);
  await new Promise<void>((done, reject) => {
    follower.stdout?.once('data', () => done());
    follower.once('error', reject);
  });
  await new Promise<void>((done) => {
    follower.once('close', () => done());
    follower.kill('SIGKILL');
  });
  expect(processStartTime(owner.pid)).toBe(owner.start);
  await cli(root, [
    'interaction',
    'respond',
    '--thread',
    threadId,
    '--run',
    runId,
    '--interaction',
    approval.interactionId,
    '--decision',
    'approve',
  ]);
  await expect
    .poll(async () => Number(await readFile(join(root, 'fixture-child-pid'), 'utf8')))
    .toBeGreaterThan(0);
  const nativePid = Number(await readFile(join(root, 'fixture-child-pid'), 'utf8'));
  recordFixtureEvent('owned-native-effect-child', {
    identity: { executable: process.execPath, pid: nativePid, start: processStartTime(nativePid) },
  });
  expect(process.kill(nativePid, 0)).toBe(true);
  await cli(root, ['run', 'stop', '--thread', threadId, '--run', runId]);
  expect(() => process.kill(nativePid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  expect((await event(client, threadId, 'run.finished')).outcome).toBe('stopped');
  await client.close();
  await stopHost(owner);
  await released(root);
  expect((await readFile(join(root, 'fixture-platform-closed'), 'utf8')).trim()).toBe(
    String(owner.pid)
  );
  const store = await StateStore.open(root);
  try {
    const rows = await store.read(threadId);
    expect(rows.at(-1)?.event).toMatchObject({ outcome: 'stopped', type: 'run.finished' });
    expect(cliPids.get(root)).not.toContain(owner.pid);
    await receipt('cli-native-stop', {
      cliPids: cliPids.get(root),
      hostPid: owner.pid,
      nativePid,
      processesJoined: true,
      rootReleased: true,
      rowCount: rows.length,
      runId,
      runtime,
      testPid: process.pid,
      threadId,
    });
    await receipt('cli-native-stop-log', rows);
  } finally {
    await store.close();
  }
});

test('CLI-owned run survives its client, restarts a fresh host at the committed approval and executes once', async () => {
  const root = await freshRoot();
  const { HOST_RESULT_SCHEMAS } = await import('../src/protocol.js');
  const { threadId } = HOST_RESULT_SCHEMAS['thread/start'].parse(
    await cli(root, ['thread', 'start'])
  );
  await released(root);
  const { runId } = HOST_RESULT_SCHEMAS['run/start'].parse(
    await cli(root, [
      'run',
      'start',
      '--thread',
      threadId,
      '--model',
      'scripted',
      '--prompt',
      'Write the owned file.',
    ])
  );
  const first = await record(root);
  const client = await attachAgentHost(first);
  clients.push(client);
  const approval = await event(client, threadId, 'interaction.requested');
  await client.close();
  expect(processStartTime(first.pid)).toBe(first.start);
  await stopHost(first);
  await released(root);
  await cli(root, [
    'interaction',
    'respond',
    '--thread',
    threadId,
    '--run',
    runId,
    '--interaction',
    approval.interactionId,
    '--decision',
    'approve',
  ]);
  await released(root);
  expect(await readFile(join(root, 'permitted.txt'), 'utf8')).toBe(
    'written by permitted host tool'
  );
  expect(await readFile(join(root, 'fixture-effect-count'), 'utf8')).toBe('1\n');
  const store = await StateStore.open(root);
  try {
    const rows = await store.read(threadId);
    expect(rows.filter((row) => row.event.type === 'effect.started')).toHaveLength(1);
    expect(rows.at(-1)?.event).toMatchObject({ outcome: 'completed', runId, type: 'run.finished' });
    const starts = (await readFile(join(root, 'fixture-platform-pids'), 'utf8'))
      .trim()
      .split('\n')
      .map(Number);
    expect(new Set(starts).size).toBe(3);
    expect(
      starts.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      })
    ).toBe(true);
    await receipt('cli-approval-restart', {
      cliPids: cliPids.get(root),
      effectCount: 1,
      hostPids: starts,
      rootReleased: true,
      rowCount: rows.length,
      runId,
      threadId,
    });
  } finally {
    await store.close();
  }
});

test('a plain Node process serves the same authenticated schema through a symlink entry over actual stdio and socket clients', async () => {
  const root = await freshRoot();
  const alias = join(root, 'host-entry-alias.mjs');
  await symlink(entryPath, alias);
  const child = spawnHost(
    alias,
    [JSON.stringify({ lifetime: 'persistent', root }), platformPath, 'stdio'],
    root,
    'pipe'
  );
  children.push(child);
  observe(child, false);
  await new Promise<void>((done, reject) => {
    child.once('message', (message: unknown) => {
      const startup = decodeStartupMessage(message);
      if (startup.event === 'ready') {
        done();
      } else {
        reject(new Error(startup.message));
      }
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Owned stdio host exited before ready')));
  });
  child.disconnect();
  const owner = await record(root);
  expect(owner.pid).toBe(child.pid);
  if (!(child.stdin && child.stdout)) {
    throw new Error('Owned stdio pipes unavailable');
  }
  const closed = new Promise<void>((done) => child.stdout?.once('end', () => done()));
  const stdio = await authenticateHostClient(
    stdioConnection(child.stdout, child.stdin),
    owner,
    async () => {
      child.stdin?.end();
    },
    closed
  );
  clients.push(stdio);
  const socket = await attachAgentHost(owner);
  clients.push(socket);
  const { threadId } = await stdio.request('thread/start', { commandId: randomUUID() });
  await stdio.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Write the owned file.',
    threadId,
  });
  const approval = await event(socket, threadId, 'interaction.requested');
  await socket.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'deny',
    interactionId: approval.interactionId,
    runId: approval.runId,
    threadId,
  });
  expect((await event(stdio, threadId, 'run.finished')).outcome).toBe('completed');
  const socketRows = (await socket.request('thread/read', { fromSeq: 0, threadId })).rows;
  expect(
    (await stdio.request('thread/read', { fromSeq: 0, threadId })).rows.map((row) =>
      HostLogRowSchema.parse(row)
    )
  ).toEqual(socketRows);
  expect(socketRows.some((row) => row.event.type === 'effect.started')).toBe(false);
  await stdio.close();
  await socket.close();
  await stopHost(owner);
  await released(root);
  await receipt('stdio-socket', {
    hostPid: owner.pid,
    processJoined: true,
    rootReleased: true,
    rowCount: socketRows.length,
    testPid: process.pid,
    threadId,
  });
});

test('configured startup failure is returned to CLI after the failed starter process is joined', async () => {
  const root = await freshRoot();
  await expect(cli(root, ['host', 'start'], 'fail')).rejects.toMatchObject({ code: 1 });
  const pid = Number((await readFile(join(root, 'fixture-platform-pids'), 'utf8')).trim());
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  expect(RootLock.inspect(root)?.owner.released).toBe(true);
  await receipt('startup-failure', {
    cliPids: cliPids.get(root),
    failedHostPid: pid,
    processJoined: true,
  });
});

test('a losing standalone root contender never constructs a second platform or disturbs the live owner', async () => {
  const root = await freshRoot();
  await cli(root, ['host', 'start']);
  const owner = await record(root);
  const contender = spawnHost(
    entryPath,
    [JSON.stringify({ lifetime: 'persistent', root }), platformPath],
    root,
    'ignore'
  );
  children.push(contender);
  observe(contender);
  const failed = await new Promise<ReturnType<typeof decodeStartupMessage>>((done, reject) => {
    contender.once('message', (message: unknown) => done(decodeStartupMessage(message)));
    contender.once('error', reject);
    contender.once('exit', () => reject(new Error('Contender exited before its startup report')));
  });
  expect(failed).toMatchObject({ event: 'failed', kind: 'root-locked' });
  contender.disconnect();
  await expect.poll(() => contender.exitCode).not.toBeNull();
  expect((await readFile(join(root, 'fixture-platform-pids'), 'utf8')).trim().split('\n')).toEqual([
    String(owner.pid),
  ]);
  await expect(readFile(join(root, 'fixture-platform-closed'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await record(root)).toEqual(owner);
  expect(processStartTime(owner.pid)).toBe(owner.start);
  await stopHost(owner);
  await released(root);
});
