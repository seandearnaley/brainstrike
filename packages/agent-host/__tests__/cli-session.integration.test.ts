import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeHostRecord, type HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { readHostRow } from '../src/event-storage.js';
import { HOST_RESULT_SCHEMAS, HostLogRowSchema } from '../src/protocol.js';
import { removeFixtureRoot } from './fixtures/cooperative-host-fixture.js';
import { observeFixtureChild } from './fixtures/owned-fixture-process.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const platformPath = fileURLToPath(new URL('./fixtures/process-platform.mjs', import.meta.url));
const exec = promisify(execFile);
// A cold `run` reaches its approval prompt only after it started the detached host: readiness, not a latency the
// product promises (the host's own startup bound is 10 s). On hosted Linux it took 1.5-1.9 s, past the 1 s it once
// had (BST-2151). 15 s, scaled by TEST_TIMEOUT_MULTIPLIER (30 s in CI).
const PROMPT_READY_MS = getAdjustedTimeout('integration');
const roots: string[] = [];
const clients: HostClient[] = [];
const children: ChildProcess[] = [];
const observations = new Map<ChildProcess, ReturnType<typeof observeFixtureChild>>();
function observe(child: ChildProcess): ReturnType<typeof observeFixtureChild> {
  const value = observeFixtureChild(child, (pid) => {
    const start = processStartTime(pid);
    if (!start) {
      throw new Error('Cannot identify owned CLI fixture');
    }
    return { executable: process.execPath, pid, start };
  });
  observations.set(child, value);
  return value;
}
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'bs-m3-ordinary-cli-'));
  roots.push(value);
  return value;
}
async function owner(dataRoot: string): Promise<HostRecord> {
  return decodeHostRecord(JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8')));
}
/** A person's terminal: stdin, stdout and stderr pipes, on every platform. */
function startCli(
  dataRoot: string,
  args: string[],
  tool?: string
): {
  readonly done: Promise<number | null>;
  readonly stdout: () => string;
  readonly endInput: () => void;
  readonly waitForPrompt: () => Promise<void>;
  readonly write: (text: string) => void;
} {
  const child = spawn(
    process.execPath,
    [cliPath, '--data-root', dataRoot, '--platform', platformPath, ...args],
    {
      env: { ...process.env, BRAINSTRIKE_M3_TEST_TOOL: tool },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  children.push(child);
  const observed = observe(child);
  return {
    done: observed.done.then(({ code }) => code),
    endInput: () => {
      child.stdin?.end();
    },
    stdout: () => observed.output.stdout(),
    waitForPrompt: () =>
      observed.output.waitFor(
        'stderr',
        'Approve, deny, or stop?',
        AbortSignal.timeout(PROMPT_READY_MS)
      ),
    write: (text) => {
      child.stdin?.write(text);
    },
  };
}
async function cli(dataRoot: string, args: string[]): Promise<unknown> {
  const invocation = exec(
    process.execPath,
    [cliPath, '--data-root', dataRoot, '--platform', platformPath, ...args],
    { windowsHide: true }
  );
  const observed = observe(invocation.child);
  invocation.child.stdin?.end();
  try {
    const { stdout } = await invocation;
    return JSON.parse(stdout);
  } finally {
    await observed.done;
  }
}
/** A CLI's host retires once nothing it owns is pending: it releases the root, then exits. */
async function retired(dataRoot: string, record: HostRecord): Promise<void> {
  await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await expect.poll(() => processStartTime(record.pid)).not.toBe(record.start);
}
/** `host stop` ends a host that still owns a pending run; it answers once the host released its root. */
async function stopHost(dataRoot: string): Promise<void> {
  const record = await owner(dataRoot);
  expect(await cli(dataRoot, ['host', 'stop'])).toEqual({ outcome: 'stopped', rootReleased: true });
  await retired(dataRoot, record);
}
afterEach(async (context) => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  // A host owns each root whose host.json remains, including one a failed test left behind.
  for (const value of roots) {
    const owned = await access(join(value, 'host.json')).then(
      () => true,
      () => false
    );
    if (owned) {
      await stopHost(value);
    }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await observations.get(child)?.done;
  }
  for (const value of roots.splice(0)) {
    if (context.task.result?.state !== 'fail') {
      await removeFixtureRoot(value);
    }
  }
  observations.clear();
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
    const { threadId } = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/start'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(
      receipt && typeof receipt === 'object' && 'threadId' in receipt
        ? { threadId: receipt.threadId }
        : null
    );
    const { runId } = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['run/start'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(
      receipt && typeof receipt === 'object' && 'runId' in receipt ? { runId: receipt.runId } : null
    );
    const record = await owner(dataRoot);
    expect(processStartTime(record.pid)).toBe(record.start);
    await expect(readFile(join(dataRoot, 'fixture-effect-count'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // The paused run waits on its approval in the catalog too.
    expect(await cli(dataRoot, ['threads', 'list'])).toMatchObject({
      threads: [{ latestRun: { needsInput: true, status: 'running' }, threadId }],
    });
    const displayed = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(await cli(dataRoot, ['threads', 'show', '--thread', threadId]));
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
    await attached.waitForPrompt();
    attached.write(`${decision}\n`);
    expect(await attached.done).toBe(0);
    const liveRows = attached
      .stdout()
      .trim()
      .split('\n')
      .map((line) =>
        Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(
          JSON.parse(line)
        )
      );
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
    await retired(dataRoot, record);
    const store = await StateStore.open(dataRoot);
    try {
      expect(
        await Promise.all((await store.read(threadId)).map((row) => readHostRow(store, row)))
      ).toEqual(liveRows);
    } finally {
      await store.close();
    }
    expect(await cli(dataRoot, ['threads', 'list'])).toMatchObject({
      threads: [{ latestRun: { needsInput: false }, threadId }],
    });
    await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  }
);
test('stopping an ordinary run joins its real native child before the CLI exits', async () => {
  const dataRoot = await root();
  const run = startCli(
    dataRoot,
    ['run', 'Run the owned child.', '--model', 'scripted', '--interactive', '--json'],
    'child'
  );
  await run.waitForPrompt();
  const record = await owner(dataRoot);
  run.write('approve\n');
  let childPid = 0;
  await expect
    .poll(async () => {
      childPid = Number(await readFile(join(dataRoot, 'fixture-child-pid'), 'utf8'));
      return childPid;
    })
    .toBeGreaterThan(0);
  expect(processStartTime(childPid)).not.toBeNull();
  run.write('stop\n');
  expect(await run.done).toBe(0);
  expect(processStartTime(childPid)).toBeNull();
  const rows = run
    .stdout()
    .trim()
    .split('\n')
    .slice(1)
    .map((line) =>
      Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(
        JSON.parse(line)
      )
    );
  expect(rows.at(-1)?.event).toMatchObject({ outcome: 'stopped', type: 'run.finished' });
  await retired(dataRoot, record);
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
  await run.waitForPrompt();
  const record = await owner(dataRoot);
  run.endInput();
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
  await stopHost(dataRoot);
});
