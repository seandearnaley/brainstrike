// M0-A1 guard of the lock's start-time source on every platform (spike test/m0-dir-lock-start.test.ts). Windows:
// native GetProcessTimes; POSIX: ps -o lstart. The pid-reuse test derives "the real start"
// through the same function, so it cannot catch a wrong source (a constant passes it); this test checks the value
// against the real spawn time.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { expect, test } from 'vitest';
import { processStartTime } from '../src/lock.js';

const toMs = (s: string): number =>
  process.platform === 'win32'
    ? Number(BigInt(s) / 10_000n) - 11_644_473_600_000
    : Date.parse(`${s} UTC`);
const live = (): Promise<{ pid: number; at: number; kill: () => void }> =>
  new Promise((res) => {
    const at = Date.now();
    const p = spawn(process.execPath, ['-e', 'console.log("UP"); setTimeout(() => {}, 30000)'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    p.stdout.once('data', () => res({ at, kill: () => p.kill('SIGKILL'), pid: p.pid as number }));
  });

test('L-start: a process start time is its real creation time (+-5 s), stable across reads, distinct for a later process', async () => {
  const a = await live();
  const sa = processStartTime(a.pid) as string;
  expect(Math.abs(toMs(sa) - a.at)).toBeLessThan(5000);
  expect(processStartTime(a.pid)).toBe(sa);
  await new Promise((r) => {
    setTimeout(r, 1200); // POSIX lstart has 1 s resolution
  });
  const b = await live();
  const sb = processStartTime(b.pid) as string;
  expect(Math.abs(toMs(sb) - b.at)).toBeLessThan(5000);
  expect(sb).not.toBe(sa);
  a.kill();
  b.kill();
}, 60_000);

test('L-gone: an exited pid has no start time (null), it does not throw', async () => {
  const p = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => p.once('exit', r));
  await new Promise((r) => {
    setTimeout(r, 200);
  });
  expect(processStartTime(p.pid as number)).toBeNull();
}, 60_000);

// An unavailable OS identity source must never be interpreted as a dead owner. Both sources fail here (`ps`, and the
// Windows process-identity addon), so whichever one this OS reads is the one that is unavailable.
test('L-error: an unavailable identity source rejects identity instead of claiming the pid is gone', () => {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as typeof import('node:child_process');
  const windowsIdentity = require('@brainstrike/windows-job-native') as {
    getProcessCreationTime: (pid: number) => string | null;
  };
  const unavailable = (): never => {
    throw Object.assign(new Error('identity source unavailable'), { code: 'ENOENT' });
  };
  const originalPs = cp.execFileSync;
  const originalWindows = windowsIdentity.getProcessCreationTime;
  (cp as { execFileSync: unknown }).execFileSync = unavailable;
  windowsIdentity.getProcessCreationTime = unavailable;
  syncBuiltinESMExports();
  try {
    expect(() => processStartTime(99_999_999)).toThrow(/identity source unavailable/);
  } finally {
    (cp as { execFileSync: unknown }).execFileSync = originalPs;
    windowsIdentity.getProcessCreationTime = originalWindows;
    syncBuiltinESMExports();
  }
});

// BST-2106: an exited child its parent has not collected yet is still known to the OS (a POSIX zombie; on Windows a
// process object its parent's handle keeps open), but it holds nothing and its pid cannot be reused. Electron collects
// an exited utility process asynchronously, so reset saw its joined host "survive". Such a child has no start time.
// The parent blocks its only thread in a synchronous stdin read, so its event loop cannot collect the child until
// this test closes that stdin.
const UNCOLLECTING_PARENT = [
  "const { spawn } = require('node:child_process');",
  "const { readSync, writeSync } = require('node:fs');",
  "const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });",
  "writeSync(1, child.pid + '\\n');",
  'readSync(0, Buffer.alloc(1));',
].join('\n');

test('L-zombie: an exited child its parent has not collected yet has no start time', async () => {
  const parent = spawn(process.execPath, ['-e', UNCOLLECTING_PARENT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(parent, 'close');
  const lines = createInterface({ input: parent.stdout });
  let errors = '';
  parent.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  try {
    const child = Number((await lines[Symbol.asyncIterator]().next()).value);
    expect(child, errors).toBeGreaterThan(0);
    await expect.poll(() => processStartTime(child), { timeout: 5000 }).toBeNull();
    expect(processStartTime(parent.pid as number)).not.toBeNull();
  } finally {
    parent.stdin.end();
    expect((await exited)[0], errors).toBe(0);
    lines.close();
  }
}, 60_000);
