import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeHostRecord, type HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { readHostRow } from '../src/event-storage.js';
import { HOST_RESULT_SCHEMAS, HostLogRowSchema } from '../src/protocol.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const platformPath = fileURLToPath(new URL('./fixtures/process-platform.mjs', import.meta.url));
const exec = promisify(execFile);
const roots: string[] = [];
const owners: HostRecord[] = [];
const clients: HostClient[] = [];
const children: ChildProcess[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'bs-m3-ordinary-cli-'));
  roots.push(value);
  return value;
}

async function owner(dataRoot: string): Promise<HostRecord> {
  const value = decodeHostRecord(JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8')));
  if (!owners.some((item) => item.pid === value.pid && item.start === value.start)) {
    owners.push(value);
  }
  return value;
}

function startCli(
  dataRoot: string,
  args: string[],
  tool?: string
): {
  readonly child: ChildProcess;
  readonly done: Promise<number | null>;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const child = spawn(
    process.execPath,
    [cliPath, '--data-root', dataRoot, '--platform', platformPath, ...args],
    {
      env: { ...process.env, BRAINSTRIKE_M3_TEST_TOOL: tool },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (value: Buffer) => {
    stdout += value.toString();
  });
  child.stderr?.on('data', (value: Buffer) => {
    stderr += value.toString();
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { child, done, stderr: () => stderr, stdout: () => stdout };
}

async function cli(dataRoot: string, args: string[]): Promise<unknown> {
  const { stdout } = await exec(process.execPath, [
    cliPath,
    '--data-root',
    dataRoot,
    '--platform',
    platformPath,
    ...args,
  ]);
  return JSON.parse(stdout);
}

async function stop(ownerRecord: HostRecord): Promise<void> {
  if (processStartTime(ownerRecord.pid) === ownerRecord.start) {
    process.kill(ownerRecord.pid, 'SIGTERM');
  }
  await expect.poll(() => processStartTime(ownerRecord.pid)).not.toBe(ownerRecord.start);
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((done) => {
        child.once('close', () => done());
        child.kill('SIGTERM');
      });
    }
  }
  for (const item of owners.splice(0)) {
    await stop(item);
  }
  for (const value of roots.splice(0)) {
    await rm(value, { force: true, recursive: true });
  }
});

test.each(['approve', 'deny'] as const)(
  'ordinary run and attach share the committed CLI decision (%s)',
  async (decision) => {
    const dataRoot = await root();
    const run = startCli(dataRoot, [
      'run',
      'Write the owned file.',
      '--model',
      'scripted',
      '--json',
      '--non-interactive',
    ]);
    expect(await run.done).toBe(2);
    const receipt: unknown = JSON.parse(run.stdout().split('\n')[0]!);
    const { threadId } = HOST_RESULT_SCHEMAS['thread/start'].parse(
      receipt && typeof receipt === 'object' && 'threadId' in receipt
        ? { threadId: receipt.threadId }
        : null
    );
    const { runId } = HOST_RESULT_SCHEMAS['run/start'].parse(
      receipt && typeof receipt === 'object' && 'runId' in receipt ? { runId: receipt.runId } : null
    );
    const record = await owner(dataRoot);
    expect(processStartTime(record.pid)).toBe(record.start);
    await expect(readFile(join(dataRoot, 'fixture-effect-count'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await cli(dataRoot, ['threads', 'list'])).toEqual({ threads: [{ threadId }] });
    const displayed = HOST_RESULT_SCHEMAS['thread/read'].parse(
      await cli(dataRoot, ['threads', 'show', '--thread', threadId])
    );
    expect(displayed.rows.some(({ event }) => event.type === 'interaction.requested')).toBe(true);
    const attached = startCli(dataRoot, [
      'attach',
      '--thread',
      threadId,
      '--run',
      runId,
      '--interactive',
      '--json',
    ]);
    await expect.poll(() => attached.stderr()).toContain('Approve, deny, or stop?');
    attached.child.stdin?.write(`${decision}\n`);
    expect(await attached.done).toBe(0);
    const liveRows = attached
      .stdout()
      .trim()
      .split('\n')
      .map((line) => HostLogRowSchema.parse(JSON.parse(line)));
    expect(liveRows.at(-1)?.event).toMatchObject({
      outcome: 'completed',
      runId,
      type: 'run.finished',
    });
    if (decision === 'approve') {
      expect(await readFile(join(dataRoot, 'fixture-effect-count'), 'utf8')).toBe('1\n');
      expect(await readFile(join(dataRoot, 'permitted.txt'), 'utf8')).toBe(
        'written by permitted host tool'
      );
    } else {
      await expect(readFile(join(dataRoot, 'fixture-effect-count'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
    await stop(record);
    const store = await StateStore.open(dataRoot);
    try {
      expect(
        await Promise.all((await store.read(threadId)).map((row) => readHostRow(store, row)))
      ).toEqual(liveRows);
    } finally {
      await store.close();
    }
    expect(await cli(dataRoot, ['threads', 'list'])).toEqual({ threads: [{ threadId }] });
    await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  }
);

test('ordinary run SIGINT joins its real native child before the CLI exits', async () => {
  const dataRoot = await root();
  const run = startCli(
    dataRoot,
    ['run', 'Run the owned child.', '--model', 'scripted', '--interactive', '--json'],
    'child'
  );
  await expect.poll(() => run.stderr()).toContain('Approve, deny, or stop?');
  const record = await owner(dataRoot);
  run.child.stdin?.write('approve\n');
  let childPid = 0;
  await expect
    .poll(async () => {
      childPid = Number(await readFile(join(dataRoot, 'fixture-child-pid'), 'utf8'));
      return childPid;
    })
    .toBeGreaterThan(0);
  expect(process.kill(childPid, 0)).toBe(true);
  run.child.kill('SIGINT');
  expect(await run.done).toBe(0);
  expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  const rows = run
    .stdout()
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => HostLogRowSchema.parse(JSON.parse(line)));
  expect(rows.at(-1)?.event).toMatchObject({ outcome: 'stopped', type: 'run.finished' });
  await stop(record);
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
});

test('terminal EOF leaves its unanswered approval owned by the host for reconnection', async () => {
  const dataRoot = await root();
  const run = startCli(dataRoot, [
    'run',
    'Write the owned file.',
    '--model',
    'scripted',
    '--interactive',
    '--json',
  ]);
  await expect.poll(() => run.stderr()).toContain('Approve, deny, or stop?');
  const record = await owner(dataRoot);
  run.child.stdin?.end();
  expect(await run.done).toBe(2);
  expect(processStartTime(record.pid)).toBe(record.start);
  const client = await attachAgentHost(record);
  clients.push(client);
  const { threads } = await client.request('thread/list', {});
  const threadId = threads[0]!.threadId;
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.filter(({ event }) => event.type === 'interaction.requested')).toHaveLength(1);
  expect(rows.some(({ event }) => event.type === 'effect.started')).toBe(false);
  expect(rows.some(({ event }) => event.type === 'run.finished')).toBe(false);
});
