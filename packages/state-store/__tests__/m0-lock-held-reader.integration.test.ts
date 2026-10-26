import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, test } from 'vitest';
import { RootLock } from '../src/lock.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);
const generation = (lock: RootLock, gen = lock.gen): string =>
  join(lock.dir, `g${String(gen).padStart(12, '0')}`);
// Python's own command names: `python3` on POSIX (PEP 394), `python` on Windows
// (docs.python.org/3/using/windows.html). A missing interpreter fails the test.
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// Windows: an antivirus scan held by the System process keeps a fresh record open without delete sharing, which
// refused the old rename over it with ERROR_ACCESS_DENIED. Python's open() withholds delete sharing the same way.
test('a reader holding the record without delete sharing fails neither a release nor the next acquisition', async () => {
  const lock = await RootLock.acquire(freshDir('held-release'));
  const target = generation(lock);
  const before = readFileSync(target, 'utf8');
  const child = spawn(PYTHON, [join(import.meta.dirname, 'fixtures/held-lock-reader.py'), target], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  const output = lines[Symbol.asyncIterator]();
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  let next: RootLock | undefined;
  try {
    expect((await output.next()).value, errors).toBe(before);
    lock.release();
    expect(lock.isReleased).toBe(true);
    expect(RootLock.inspect(lock.owner.root)?.owner).toEqual({ ...lock.owner, released: true });
    next = await RootLock.acquire(lock.owner.root);
    expect(next.gen).toBe(lock.gen + 2);
    expect(readdirSync(lock.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    child.stdin.end('\n');
    expect((await output.next()).value).toBe(before);
    expect((await exited)[0], errors).toBe(0);
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
    await exited;
    lines.close();
    next?.release();
  }
  const last = await RootLock.acquire(lock.owner.root);
  expect(readdirSync(lock.dir).filter((name) => name.startsWith('g'))).toEqual([
    `g${String(last.gen).padStart(12, '0')}`,
  ]);
  last.release();
});
