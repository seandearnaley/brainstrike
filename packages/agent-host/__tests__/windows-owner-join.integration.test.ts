import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processStartTime } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { observeFixtureChild } from './fixtures/owned-fixture-process.js';

const powershell = process.env['M3_WINDOWS_POWERSHELL'] ?? 'pwsh.exe';
const script = fileURLToPath(new URL('./fixtures/windows-owner-join.ps1', import.meta.url));
const targetSource = `
  process.stdin.once('data', () => { process.exitCode = 17; process.stdin.pause(); });
  process.stdin.resume();
  process.stdout.write('owned-join-target-ready\\n');
`;
const Row = z.strictObject({
  event: z.string(),
  exitCode: z.number().optional(),
  pid: z.number().int().positive(),
  reusedStart: z.string().optional(),
  start: z.string().regex(/^\d+$/),
});
const targets: ChildProcess[] = [];
const observers = new Map<ChildProcess, ReturnType<typeof observeFixtureChild>>();

function observe(child: ChildProcess, executable: string): ReturnType<typeof observeFixtureChild> {
  const value = observeFixtureChild(child, (pid) => {
    const start = processStartTime(pid);
    if (!start) {
      throw new Error('Cannot identify owned join fixture');
    }
    return { executable, pid, start };
  });
  observers.set(child, value);
  return value;
}

async function target(): Promise<{
  readonly child: ChildProcess;
  readonly pid: number;
  readonly start: string;
  readonly observed: ReturnType<typeof observeFixtureChild>;
}> {
  const child = spawn(process.execPath, ['--eval', targetSource], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  targets.push(child);
  const observed = observe(child, process.execPath);
  await observed.output.waitFor('stdout', 'owned-join-target-ready');
  const pid = child.pid;
  const start = pid && processStartTime(pid);
  if (!(pid && start)) {
    throw new Error('Owned join target ended before readiness');
  }
  return { child, observed, pid, start };
}

function joinOwner(pid: number, start: string): ReturnType<typeof observeFixtureChild> {
  const child = spawn(
    powershell,
    ['-NoLogo', '-NoProfile', '-File', script, '-OwnedPid', String(pid), '-ExpectedStart', start],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  return observe(child, powershell);
}

function rows(observed: ReturnType<typeof observeFixtureChild>): z.infer<typeof Row>[] {
  return observed.output
    .stdout()
    .trim()
    .split('\n')
    .map((line) => Row.parse(JSON.parse(line)));
}

afterEach(async () => {
  // Only end stdin of children this fixture spawned. No process signal or PID
  // termination is used, including for the live identity-mismatch case.
  for (const child of targets.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && !child.stdin?.writableEnded) {
      child.stdin?.end('close\n');
    }
    await observers.get(child)?.done;
  }
  await Promise.all([...observers.values()].map((value) => value.done));
  observers.clear();
});

test.runIf(process.platform === 'win32')(
  'owner join waits on its verified handle when the child exits after validation',
  async () => {
    const owned = await target();
    const joining = joinOwner(owned.pid, owned.start);
    await joining.output.waitFor('stdout', 'owner-handle-verified');
    expect(processStartTime(owned.pid)).toBe(owned.start);
    expect(rows(joining)).toEqual([
      { event: 'owner-handle-verified', pid: owned.pid, start: owned.start },
    ]);
    owned.child.stdin?.end('close\n');
    expect(await joining.done).toEqual({ code: 0, signal: null });
    expect(await owned.observed.done).toEqual({ code: 17, signal: null });
    expect(rows(joining).at(-1)).toEqual({
      event: 'owner-physically-joined',
      exitCode: 17,
      pid: owned.pid,
      start: owned.start,
    });
    expect(processStartTime(owned.pid)).not.toBe(owned.start);
  }
);

test.runIf(process.platform === 'win32')(
  'owner join honestly reports disappearance before the initial handle opens',
  async () => {
    const owned = await target();
    owned.child.stdin?.end('close\n');
    expect(await owned.observed.done).toEqual({ code: 17, signal: null });
    const joining = joinOwner(owned.pid, owned.start);
    expect(await joining.done).toEqual({ code: 0, signal: null });
    const result = rows(joining);
    expect(result).toHaveLength(1);
    expect(result[0]?.event).toMatch(/^owner-(already-gone|gone-during-open|identity-gone)$/);
    expect(result[0]).toMatchObject({ pid: owned.pid, start: owned.start });
    expect(processStartTime(owned.pid)).not.toBe(owned.start);
  }
);

test.runIf(process.platform === 'win32')(
  'owner join refuses to wait on a live process with a different recorded creation time',
  async () => {
    const owned = await target();
    const stale = (BigInt(owned.start) - 1n).toString();
    const joining = joinOwner(owned.pid, stale);
    expect(await joining.done).toEqual({ code: 0, signal: null });
    expect(rows(joining)).toEqual([
      { event: 'owner-identity-gone', pid: owned.pid, reusedStart: owned.start, start: stale },
    ]);
    expect(processStartTime(owned.pid)).toBe(owned.start);
  }
);
