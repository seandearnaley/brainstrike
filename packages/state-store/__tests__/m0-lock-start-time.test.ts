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

// An unavailable OS identity source must never be interpreted as a dead owner.
test.skipIf(process.platform === 'win32')(
  'L-error: a missing ps executable rejects identity instead of claiming the pid is gone',
  () => {
    const cp = createRequire(import.meta.url)(
      'node:child_process'
    ) as typeof import('node:child_process');
    const original = cp.execFileSync;
    (cp as { execFileSync: unknown }).execFileSync = () => {
      throw Object.assign(new Error('ps unavailable'), { code: 'ENOENT' });
    };
    syncBuiltinESMExports();
    try {
      expect(() => processStartTime(99_999_999)).toThrow(/ps unavailable/);
    } finally {
      (cp as { execFileSync: unknown }).execFileSync = original;
      syncBuiltinESMExports();
    }
  }
);

// BST-2106: an exited child its parent has not reaped yet is a zombie. It holds
// no descriptors and its pid cannot be reused, but `ps` still lists it with its
// start time. Electron reaps an exited utility process asynchronously on Linux,
// so reset saw its joined host "survive". A zombie has no start time: it is gone.
test.skipIf(process.platform === 'win32')(
  'L-zombie: an exited child not yet reaped by its parent has no start time',
  async () => {
    // A shell can reap `sleep 0` before exec, and the old five-second parent
    // could expire before a loaded runner observed it. Hold the real fork's
    // parent until this test releases it, then reap and join both processes.
    const parent = spawn(
      'python3',
      [
        '-c',
        [
          'import os, sys',
          'child = os.fork()',
          'if child == 0:',
          '    os._exit(0)',
          'print(child, flush=True)',
          'sys.stdin.read()',
          'os.waitpid(child, 0)',
        ].join('\n'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const exited = once(parent, 'close');
    const lines = createInterface({ input: parent.stdout });
    let errors = '';
    parent.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    try {
      const zombie = Number((await lines[Symbol.asyncIterator]().next()).value);
      expect(zombie, errors).toBeGreaterThan(0);
      const state = (): string =>
        createRequire(import.meta.url)('node:child_process')
          .execFileSync('ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' })
          .trim();
      await expect.poll(state, { timeout: 5000 }).toMatch(/^Z/);

      expect(processStartTime(zombie)).toBeNull();
      expect(processStartTime(parent.pid as number)).not.toBeNull();
    } finally {
      parent.stdin.end();
      expect((await exited)[0], errors).toBe(0);
      lines.close();
    }
  },
  60_000
);
