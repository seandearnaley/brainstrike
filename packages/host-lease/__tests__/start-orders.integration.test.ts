import { type ChildProcess, fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeThrowingDecoder, runWithTimeout } from '@brainstrike/effect-kit';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { type HostRecord, HostRecordSchema } from '../src/record.js';
import { readHostRecord } from '../src/record-file.js';

const decodeAttached = makeThrowingDecoder(
  Schema.Struct({ event: Schema.Literal('attached'), record: HostRecordSchema }),
  { onExcessProperty: 'error' }
);
const fixture = fileURLToPath(new URL('./fixtures/client-process.ts', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
const hosts = new Map<number, HostRecord>();
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-order-'));
  roots.push(root);
  return root;
}
async function client(
  root: string,
  lifetime: 'app' | 'cli'
): Promise<{ child: ChildProcess; record: HostRecord }> {
  const child = fork(fixture, [root, lifetime], {
    execArgv: ['--import', 'tsx'],
    execPath: process.execPath,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.push(child);
  const record = await runWithTimeout(
    () =>
      new Promise<HostRecord>((resolve, reject) => {
        const failed = (cause: unknown): void => {
          cleanup();
          reject(cause);
        };
        const exited = (): void => failed(new Error('Client fixture exited before attach'));
        const cleanup = (): void => {
          child.off('message', message);
          child.off('error', failed);
          child.off('exit', exited);
        };
        const message = (input: unknown): void => {
          try {
            const ready = decodeAttached(input);
            cleanup();
            resolve(ready.record);
          } catch (cause) {
            failed(cause);
          }
        };
        child.once('message', message);
        child.once('error', failed);
        child.once('exit', exited);
      }),
    { onTimeout: () => new Error('Client fixture attach timed out'), timeoutMs: 10_000 }
  );
  hosts.set(record.pid, record);
  return { child, record };
}
async function closeClient(child: ChildProcess, kill = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    if (kill) {
      child.kill('SIGKILL');
    } else {
      child.send('close');
    }
  });
}
async function waitReleased(root: string): Promise<void> {
  for (let i = 0; i < 160; i += 1) {
    if (RootLock.inspect(root)?.owner.released && (await readHostRecord(root)) === null) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Host did not release its root and discovery record');
}
async function waitForGone(record: HostRecord): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (processStartTime(record.pid) !== record.start) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Owned test host ${record.pid} did not exit`);
}
afterEach(async () => {
  // Snapshot before cleanup so a failed test cannot contaminate the next one.
  const fixtureRoots = roots.splice(0);
  const fixtureHosts = [...hosts.values()];
  hosts.clear();
  await Promise.all(children.splice(0).map((child) => closeClient(child)));
  for (const record of fixtureHosts) {
    if (processStartTime(record.pid) === record.start) {
      // Only a proved test-owned host may be terminated during fixture cleanup.
      try {
        process.kill(record.pid, 'SIGTERM');
      } catch (error) {
        // The owned host can exit between the identity query and this signal.
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw error;
        }
      }
      await waitForGone(record);
    }
  }
  for (const root of fixtureRoots) {
    // Windows force termination cannot run finalizers. Keep failed roots as
    // evidence; graceful-release assertions belong in the test, before cleanup.
    if (RootLock.inspect(root)?.owner.released && (await readHostRecord(root)) === null) {
      await rm(root, { force: true, recursive: true });
    } else {
      process.stderr.write(`Retained unclean test-owned root: ${root}\n`);
    }
  }
});

test('a CLI creator exits while another client retains the host, then the final client releases and exits it', async () => {
  const root = await freshRoot();
  const creator = await client(root, 'cli');
  const remaining = await client(root, 'cli');
  expect(remaining.record).toEqual(creator.record);
  await closeClient(creator.child);
  expect(processStartTime(creator.record.pid)).toBe(creator.record.start);
  expect(await readHostRecord(root)).toEqual(creator.record);
  const lease = RootLock.inspect(root);
  expect(lease?.owner.pid).toBe(creator.record.pid);
  expect(lease?.owner.start).toBe(creator.record.start);
  expect(lease?.owner.released).not.toBe(true);
  await closeClient(remaining.child);
  await waitReleased(root);
  await waitForGone(creator.record);
});

test('real CLI-first and app-first clients discover the same process in both start orders', async () => {
  for (const order of [
    ['cli', 'app'],
    ['app', 'cli'],
  ] as const) {
    const root = await freshRoot();
    const first = await client(root, order[0]);
    const second = await client(root, order[1]);
    expect(second.record).toEqual(first.record);
    await closeClient(second.child);
    expect(processStartTime(first.record.pid)).toBe(first.record.start);
    await closeClient(first.child);
    await waitReleased(root);
  }
});

test('eight real clients racing from different processes acquire one host and one token', async () => {
  const root = await freshRoot();
  const attached = await Promise.all(
    Array.from({ length: 8 }, (_, index) => client(root, index % 2 ? 'cli' : 'app'))
  );
  expect(new Set(attached.map((value) => value.record.pid)).size).toBe(1);
  expect(new Set(attached.map((value) => value.record.token)).size).toBe(1);
  await Promise.all(attached.map((value) => closeClient(value.child)));
  await waitReleased(root);
});

test('an app-forked host releases and exits when the app is killed even while a CLI client remains', async () => {
  const root = await freshRoot();
  const app = await client(root, 'app');
  const cli = await client(root, 'cli');
  expect(cli.record.pid).toBe(app.record.pid);
  await closeClient(app.child, true);
  await waitReleased(root);
  await waitForGone(app.record);
  const replacement = await client(root, 'cli');
  expect(replacement.record.pid).not.toBe(app.record.pid);
  await closeClient(cli.child);
  await closeClient(replacement.child);
  await waitReleased(root);
  await waitForGone(replacement.record);
});
