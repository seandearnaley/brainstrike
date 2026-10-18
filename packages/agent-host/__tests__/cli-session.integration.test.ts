import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeHostRecord, type HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { readHostRow } from '../src/event-storage.js';
import { HOST_RESULT_SCHEMAS, HostLogRowSchema } from '../src/protocol.js';
import {
  closeFixtureHost,
  createFixtureCloseControl,
  type FixtureCloseControl,
  fixtureControlEnvironment,
  removeFixtureRoot,
} from './fixtures/cooperative-host-fixture.js';
import {
  FixtureOutput,
  observeFixtureChild,
  recordFixtureEvent,
  startFixtureConsole,
} from './fixtures/owned-fixture-process.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const platformPath = fileURLToPath(
  new URL(
    process.platform === 'win32'
      ? './fixtures/process-platform-cooperative.mjs'
      : './fixtures/process-platform.mjs',
    import.meta.url
  )
);
const exec = promisify(execFile);
// A cold `run` reaches its approval prompt only after it started the detached host: readiness, not a latency the
// product promises (the host's own startup bound is 10 s). On hosted Linux it took 1.5-1.9 s, past the 1 s it once
// had (BST-2151). 15 s, scaled by TEST_TIMEOUT_MULTIPLIER (30 s in CI).
const PROMPT_READY_MS = getAdjustedTimeout('integration');
const roots: string[] = [];
const owners: HostRecord[] = [];
const clients: HostClient[] = [];
const children: ChildProcess[] = [];
const consoles: ReturnType<typeof startFixtureConsole>[] = [];
const controls = new Map<string, FixtureCloseControl>();
const ownerControls = new Map<string, FixtureCloseControl>();
const observations = new Map<ChildProcess, ReturnType<typeof observeFixtureChild>>();
interface PinnedWindowsOwner {
  interruptRequested: boolean;
  readonly joined: Promise<void>;
}
const windowsOwnerJoins = new Map<string, PinnedWindowsOwner>();
const WindowsOwnerJoinMessage = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('owner-handle-verified'),
    pid: z.number().int().positive(),
    start: z.string().regex(/^\d+$/),
  }),
  z.strictObject({
    event: z.literal('owner-physically-joined'),
    exitCode: z.number().int(),
    pid: z.number().int().positive(),
    start: z.string().regex(/^\d+$/),
  }),
]);
function environment(dataRoot: string): NodeJS.ProcessEnv {
  const control = controls.get(dataRoot);
  return { ...process.env, ...(control ? fixtureControlEnvironment(control) : {}) };
}
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
  if (process.platform === 'win32') {
    controls.set(value, createFixtureCloseControl(value));
  }
  return value;
}
async function owner(dataRoot: string): Promise<HostRecord> {
  const value = decodeHostRecord(JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8')));
  if (!owners.some((item) => item.pid === value.pid && item.start === value.start)) {
    owners.push(value);
  }
  const control = controls.get(dataRoot);
  if (control) {
    ownerControls.set(`${value.pid}:${value.start}`, control);
  }
  recordFixtureEvent('observed-host-owner', {
    identity: { executable: process.execPath, pid: value.pid, start: value.start },
    root: dataRoot,
  });
  return value;
}
function startCli(
  dataRoot: string,
  args: string[],
  tool?: string
): {
  readonly done: Promise<number | null>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly write: (text: string) => void;
  readonly endInput: () => void;
  readonly interrupt: () => void;
  readonly waitForPrompt: () => Promise<void>;
} {
  const argsToSpawn = [cliPath, '--data-root', dataRoot, '--platform', platformPath, ...args];
  const env = { ...environment(dataRoot), BRAINSTRIKE_M3_TEST_TOOL: tool };
  if (process.platform === 'win32') {
    const terminal = startFixtureConsole(argsToSpawn, { env });
    consoles.push(terminal);
    // Creation FILETIME provides actual target startup time, excluding broker compilation.
    const spawned = terminal.identity.then(({ start }) =>
      Number((BigInt(start) - 116444736000000000n) / 10000n)
    );
    const done = terminal.done.then(async ({ code }) => {
      await terminal.dispose();
      return code;
    });
    void done.catch(() => undefined);
    return {
      done,
      endInput: terminal.endInput,
      interrupt: terminal.interrupt,
      stderr: () => terminal.output.stderr(),
      stdout: () => terminal.output.stdout(),
      waitForPrompt: async () => {
        const started = await spawned;
        // Observe output events and reject early with exit/stderr instead of a poll.
        await terminal.output.waitFor(
          'stderr',
          'Approve, deny, or stop?',
          AbortSignal.timeout(PROMPT_READY_MS)
        );
        recordFixtureEvent('cli-prompt-readiness', {
          elapsedMs: Date.now() - started,
          root: dataRoot,
        });
      },
      write: terminal.write,
    };
  }
  const child = spawn(process.execPath, argsToSpawn, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const observed = observe(child);
  return {
    done: observed.done.then(({ code }) => code),
    endInput: () => {
      child.stdin?.end();
    },
    interrupt: () => {
      child.kill('SIGINT');
    },
    stderr: () => observed.output.stderr(),
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
    { env: environment(dataRoot), windowsHide: true }
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
async function waitForWindowsOwnerVerification(
  output: FixtureOutput,
  ownerRecord: Pick<HostRecord, 'pid' | 'start'>
): Promise<void> {
  // A pipe chunk can end anywhere in the JSON; only the newline frames a record.
  // The existing enclosing test deadline and output failure still bound this wait.
  await output.waitFor('stdout', '\n');
  const stdout = output.stdout();
  const record = stdout.slice(0, stdout.indexOf('\n'));
  expect(WindowsOwnerJoinMessage.parse(JSON.parse(record))).toEqual({
    event: 'owner-handle-verified',
    pid: ownerRecord.pid,
    start: ownerRecord.start,
  });
}
async function pinWindowsOwner(ownerRecord: HostRecord): Promise<PinnedWindowsOwner> {
  const powershell = process.env['M3_WINDOWS_POWERSHELL'] ?? 'pwsh.exe';
  const child = spawn(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-File',
      fileURLToPath(new URL('./fixtures/windows-owner-join.ps1', import.meta.url)),
      '-OwnedPid',
      String(ownerRecord.pid),
      '-ExpectedStart',
      ownerRecord.start,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  children.push(child);
  const observed = observeFixtureChild(child, (pid) => {
    const start = processStartTime(pid);
    if (!start) {
      throw new Error('Cannot identify the owned Windows handle observer');
    }
    return { executable: powershell, pid, start };
  });
  observations.set(child, observed);
  const pinned: PinnedWindowsOwner = {
    interruptRequested: false,
    joined: observed.done.then((result) => {
      expect(result).toEqual({ code: 0, signal: null });
      const messages = observed.output
        .stdout()
        .trim()
        .split('\n')
        .map((line) => WindowsOwnerJoinMessage.parse(JSON.parse(line)));
      expect(messages).toEqual([
        { event: 'owner-handle-verified', pid: ownerRecord.pid, start: ownerRecord.start },
        {
          event: 'owner-physically-joined',
          exitCode: 0,
          pid: ownerRecord.pid,
          start: ownerRecord.start,
        },
      ]);
      recordFixtureEvent('sigint-owner-physically-joined', {
        identity: { executable: process.execPath, pid: ownerRecord.pid, start: ownerRecord.start },
      });
    }),
  };
  windowsOwnerJoins.set(`${ownerRecord.pid}:${ownerRecord.start}`, pinned);
  void pinned.joined.catch(() => undefined);
  // Pin and verify the real owner before SIGINT can make an unpinned StartTime
  // query race its exit. The existing enclosing test owns the deadline.
  await waitForWindowsOwnerVerification(observed.output, ownerRecord);
  recordFixtureEvent('sigint-owner-handle-pinned', {
    identity: { executable: process.execPath, pid: ownerRecord.pid, start: ownerRecord.start },
  });
  return pinned;
}
async function stop(ownerRecord: HostRecord): Promise<void> {
  const pinned =
    process.platform === 'win32'
      ? windowsOwnerJoins.get(`${ownerRecord.pid}:${ownerRecord.start}`)
      : undefined;
  if (pinned) {
    if (!pinned.interruptRequested) {
      // A failed assertion before the planned interrupt still cooperatively closes
      // its known fixture owner and joins the observer's already-verified handle.
      const control = ownerControls.get(`${ownerRecord.pid}:${ownerRecord.start}`);
      if (!control) {
        throw new Error('Missing owned Windows CLI host fixture control');
      }
      await closeFixtureHost(ownerRecord, control);
    }
    await pinned.joined;
    return;
  }
  if (processStartTime(ownerRecord.pid) === ownerRecord.start) {
    if (process.platform === 'win32') {
      const control = ownerControls.get(`${ownerRecord.pid}:${ownerRecord.start}`);
      if (!control) {
        throw new Error('Missing owned Windows CLI host fixture control');
      }
      await closeFixtureHost(ownerRecord, control);
    } else {
      process.kill(ownerRecord.pid, 'SIGTERM');
    }
  }
  await expect.poll(() => processStartTime(ownerRecord.pid)).not.toBe(ownerRecord.start);
}
afterEach(async (context) => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  // A CLI can fail before its test reaches owner(). Discover only roots this
  // fixture allocated, so its detached host is still cooperatively joined.
  for (const value of roots) {
    try {
      await owner(value);
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
        throw cause;
      }
    }
  }
  for (const item of owners.splice(0)) {
    await stop(item);
  }
  for (const terminal of consoles.splice(0)) {
    await terminal.dispose();
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      recordFixtureEvent('explicit-failed-cli-fixture-teardown', { pid: child.pid });
      child.kill('SIGKILL');
    }
    await observations.get(child)?.done;
  }
  for (const value of roots.splice(0)) {
    if (context.task.result?.state === 'fail') {
      recordFixtureEvent('preserved-failed-cli-root', { root: value });
      continue;
    }
    await removeFixtureRoot(value);
  }
  controls.clear();
  ownerControls.clear();
  observations.clear();
  windowsOwnerJoins.clear();
});
test.each(['before closing brace', 'before newline'] as const)(
  'Windows owner verification waits for a newline-terminated record (%s)',
  async (split) => {
    // Captured from the existing real handle observer; split transport delivery,
    // preserving the payload and its exact PID/FILETIME verification assertion.
    const ownerRecord = { pid: 39_756, start: '134358926786937682' };
    const record = '{"start":"134358926786937682","pid":39756,"event":"owner-handle-verified"}';
    const output = new FixtureOutput();
    let state: 'pending' | 'verified' | 'failed' = 'pending';
    const verification = waitForWindowsOwnerVerification(output, ownerRecord).then(
      () => {
        state = 'verified';
      },
      (cause: unknown) => {
        state = 'failed';
        throw cause;
      }
    );
    void verification.catch(() => undefined);
    try {
      const splitAt = split === 'before closing brace' ? record.length - 1 : record.length;
      output.accept('stdout', record.slice(0, splitAt));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(state).toBe('pending');
      output.accept('stdout', record.slice(splitAt));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(state).toBe('pending');
      output.accept('stdout', '\r\n');
      await verification;
      expect(state).toBe('verified');
    } finally {
      output.fail(new Error('Split-record fixture observation finished'));
      await verification.catch(() => undefined);
    }
  }
);
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
    expect(await cli(dataRoot, ['threads', 'list'])).toMatchObject({
      threads: [{ latestRun: { needsInput: false }, threadId }],
    });
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
  await run.waitForPrompt();
  const record = await owner(dataRoot);
  const pinnedOwner = process.platform === 'win32' ? await pinWindowsOwner(record) : undefined;
  run.write('approve\n');
  let childPid = 0;
  await expect
    .poll(async () => {
      childPid = Number(await readFile(join(dataRoot, 'fixture-child-pid'), 'utf8'));
      return childPid;
    })
    .toBeGreaterThan(0);
  expect(process.kill(childPid, 0)).toBe(true);
  recordFixtureEvent('owned-native-effect-child', {
    identity: { executable: process.execPath, pid: childPid, start: processStartTime(childPid) },
  });
  if (pinnedOwner) {
    pinnedOwner.interruptRequested = true;
  }
  run.interrupt();
  expect(await run.done).toBe(0);
  expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
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
  await stop(record);
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  if (pinnedOwner) {
    recordFixtureEvent('sigint-root-release-observed-after-owner-join', {
      identity: { executable: process.execPath, pid: record.pid, start: record.start },
      root: dataRoot,
    });
  }
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
});
