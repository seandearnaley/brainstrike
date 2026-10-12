// ADR-0017: on POSIX the Root is also an flock that every native process the host starts inherits. A record whose
// owner is gone (or released) is still refused while such a process lives, and the Root is reusable once it exits.
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { processStartTime, RootLock, RootLockedError } from '../src/lock.js';
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

describe.skipIf(process.platform === 'win32')('Root flock', () => {
  test('a native child keeps a released Root refused, naming the owner that started it, until it exits', async () => {
    const root = newRoot();
    const owner = await RootLock.acquire(root, { shareWithNativeChildren: true });
    expect(RootLock.isFlockHeld(root)).toBe(true);
    const child = sleeper();
    owner.release();
    expect(RootLock.isFlockHeld(root)).toBe(true);
    const refusal = await RootLock.acquire(root).then(
      () => null,
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(RootLockedError);
    expect(refusal).toMatchObject({
      holder: 'native-tail',
      owner: { released: true, token: owner.owner.token },
    });
    expect(RootLock.inspect(root)).toMatchObject({
      gen: owner.gen,
      owner: { token: owner.owner.token },
    });

    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(RootLock.isFlockHeld(root)).toBe(false);
    held.push(await RootLock.acquire(root));
  });

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
});
