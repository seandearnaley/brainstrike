// ADR-0017: every native process a host starts belongs to exactly one held Root lease, and its supervisor hears about
// it. That no new owner takes a dead host's Root while a native process it started still runs is host-lease's
// native-tail integration test, on every OS.
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { processStartTime, RootLock } from '../src/lock.js';
import {
  type NativeChild,
  observeNativeChildren,
  spawnNativeChild,
} from '../src/native-children.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

const SLEEPER = ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"];
const held: RootLock[] = [];
const children: ChildProcess[] = [];
const unsubscribe: (() => void)[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  for (const lock of held.splice(0)) {
    lock.release();
  }
  for (const stop of unsubscribe.splice(0)) {
    stop();
  }
  cleanupDirs();
});
const newRoot = (): string => {
  const root = join(freshDir('flock'), 'root');
  mkdirSync(root, { recursive: true });
  return root;
};
const sleeper = (): ChildProcess => {
  const child = spawnNativeChild(process.execPath, SLEEPER, { detached: true, stdio: 'ignore' });
  children.push(child);
  return child;
};

test('a host spawn after its Root was released, or between two held Roots, is refused', async () => {
  const first = await RootLock.acquire(newRoot(), { shareWithNativeChildren: true });
  const second = await RootLock.acquire(newRoot(), { shareWithNativeChildren: true });
  expect(() => sleeper()).toThrow(/several shared Root leases/);
  second.release();
  first.release();
  expect(() => sleeper()).toThrow(/Root lease is released/);
});

test("the observer learns each native child's process group and its exit", async () => {
  held.push(await RootLock.acquire(newRoot(), { shareWithNativeChildren: true }));
  const events: [string, NativeChild][] = [];
  unsubscribe.push(
    observeNativeChildren({
      exited: (child) => events.push(['exited', child]),
      started: (child) => events.push(['started', child]),
    })
  );
  const child = sleeper();
  const identity = { group: true, pid: child.pid, start: processStartTime(child.pid ?? 0) };
  expect(events).toEqual([['started', identity]]);
  child.kill('SIGKILL');
  await once(child, 'exit');
  expect(events).toEqual([
    ['started', identity],
    ['exited', identity],
  ]);
});
