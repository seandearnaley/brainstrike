// M0-A1 guard of the lock's start-time source on every platform (spike test/m0-dir-lock-start.test.ts). Windows:
// native GetProcessTimes; macOS: ps -o lstart; Linux: the start in ticks since boot, with the boot's id, from /proc. The
// pid-reuse test derives "the real start" through the same function, so it cannot catch a wrong source (a constant
// passes it); this test checks the value against the real spawn time.

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { expect, test } from 'vitest';
import { processStartTime } from '../src/lock.js';

/** Now, in ms on the clock a start time is read against: the time since boot on Linux, the wall clock elsewhere. */
const now = (): number =>
  process.platform === 'linux'
    ? Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000
    : Date.now();
const toMs = (s: string): number =>
  process.platform === 'win32'
    ? Number(BigInt(s) / 10_000n) - 11_644_473_600_000
    : process.platform === 'linux'
      ? Number(/^(\d+\.\d{2}) s after boot \S+$/u.exec(s)?.[1]) * 1000
      : Date.parse(`${s} UTC`);
const live = (): Promise<{ pid: number; at: number; kill: () => void }> =>
  new Promise((res) => {
    const at = now();
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

// macOS reads `ps -o stat=,lstart=` and keeps only the start column, which must read as `ps -o lstart=` prints it.
// Linux reads /proc instead and keeps no wall-clock text (L-clock-step).
test.skipIf(process.platform === 'win32' || process.platform === 'linux')(
  'L-ps: a process start time reads exactly as ps -o lstart reports it',
  async () => {
    const a = await live();
    try {
      const ps = execFileSync('ps', ['-o', 'lstart=', '-p', String(a.pid)], {
        encoding: 'utf8',
        env: { ...process.env, ['LC_ALL']: 'C', ['TZ']: 'UTC' },
      }).trim();
      expect(processStartTime(a.pid)).toBe(ps);
    } finally {
      a.kill();
    }
  },
  60_000
);

// An unavailable OS identity source must never be interpreted as a dead owner. Every source fails here (`ps`, /proc
// and the Windows process-identity addon), so whichever one this OS reads is the one that is unavailable.
test('L-error: an unavailable identity source rejects identity instead of claiming the pid is gone', () => {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as typeof import('node:child_process');
  const fs = require('node:fs') as typeof import('node:fs');
  const windowsIdentity = require('@brainstrike/windows-job-native') as {
    getProcessCreationTime: (pid: number) => string | null;
  };
  const unavailable = (): never => {
    throw Object.assign(new Error('identity source unavailable'), { code: 'ENOENT' });
  };
  const originalPs = cp.execFileSync;
  const originalProc = fs.readFileSync;
  const originalWindows = windowsIdentity.getProcessCreationTime;
  (cp as { execFileSync: unknown }).execFileSync = unavailable;
  (fs as { readFileSync: unknown }).readFileSync = unavailable;
  windowsIdentity.getProcessCreationTime = unavailable;
  syncBuiltinESMExports();
  try {
    expect(() => processStartTime(99_999_999)).toThrow(/identity source unavailable/u);
  } finally {
    (cp as { execFileSync: unknown }).execFileSync = originalPs;
    (fs as { readFileSync: unknown }).readFileSync = originalProc;
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

/** Runs `check` while this Linux process reads `stat` (a value, or a thrown error) as pid 99999999's /proc stat. */
function withFakeProcStat(stat: string | Error, check: () => void): void {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const original = fs.readFileSync;
  (fs as { readFileSync: unknown }).readFileSync = (path: string, ...rest: unknown[]): unknown => {
    if (path === '/proc/99999999/stat') {
      if (stat instanceof Error) {
        throw stat;
      }
      return stat;
    }
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    check();
  } finally {
    (fs as { readFileSync: unknown }).readFileSync = original;
    syncBuiltinESMExports();
  }
}

/** A /proc stat line for a process in `state` with `threads` threads, started 100 s after boot. */
const procStat = (state: string, threads: number): string =>
  `99999999 (electron) ${state} 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 ${threads} 0 10000 0 0\n`;

// A process that exits while its /proc entry is read fails the read with ESRCH; it is gone, not an unavailable source.
test.runIf(process.platform === 'linux')(
  'L-exiting: a pid that exits during the read has no start time',
  () => {
    withFakeProcStat(Object.assign(new Error('no such process, read'), { code: 'ESRCH' }), () => {
      expect(processStartTime(99_999_999)).toBeNull();
    });
  }
);

/** Runs `check` while this Linux process reads /proc/stat with its boot time (`btime`) moved by `seconds`. */
function withSteppedClock(seconds: number, check: () => void): void {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const original = fs.readFileSync;
  (fs as { readFileSync: unknown }).readFileSync = (path: string, ...rest: unknown[]): unknown => {
    const real = (original as (...args: unknown[]) => unknown)(path, ...rest);
    return path === '/proc/stat'
      ? String(real).replace(
          /^btime (\d+)$/mu,
          (_, boot: string) => `btime ${Number(boot) + seconds}`
        )
      : real;
  };
  syncBuiltinESMExports();
  try {
    check();
  } finally {
    (fs as { readFileSync: unknown }).readFileSync = original;
    syncBuiltinESMExports();
  }
}

// BST-2514: the kernel reports the boot's wall time (`btime` in /proc/stat) from the wall clock as it is now, so a
// clock step (an NTP step, a VM its hypervisor resumed) moves it. A live owner's start must not move with it: the
// CLI read a running host's start after a step, judged it gone, and its next host was refused the Root.
test.runIf(process.platform === 'linux')(
  'L-clock-step: a live process keeps its start time when the wall clock is stepped',
  async () => {
    const a = await live();
    try {
      const before = processStartTime(a.pid);
      expect(before).not.toBeNull();
      withSteppedClock(1, () => {
        expect(processStartTime(a.pid)).toBe(before);
      });
    } finally {
      a.kill();
    }
  },
  60_000
);

// A killed multi-threaded process (an Electron utility) turns zombie at its leader while another thread is still
// exiting, and that thread still holds the process's files, the Root's flock among them.
test.runIf(process.platform === 'linux')(
  'L-zombie-threads: a zombie whose other threads are still exiting keeps its start time',
  () => {
    withFakeProcStat(procStat('Z', 2), () => {
      expect(processStartTime(99_999_999)).not.toBeNull();
    });
    withFakeProcStat(procStat('Z', 1), () => {
      expect(processStartTime(99_999_999)).toBeNull();
    });
  }
);
