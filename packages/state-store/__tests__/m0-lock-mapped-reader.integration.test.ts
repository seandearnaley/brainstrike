import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, test } from 'vitest';
import { RootLock } from '../src/lock.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);
const generation = (lock: RootLock): string =>
  join(lock.dir, `g${String(lock.gen).padStart(12, '0')}`);

// M4 Windows release EPERM: a live mapped reader reproduces the observed
// MoveFileExW/FILE_RENAME_INFORMATION access denial with unchanged owner bytes.
test.skipIf(process.platform !== 'win32')(
  'release atomically replaces a mapped generation while its reader retains old bytes',
  async () => {
    const lock = await RootLock.acquire(freshDir('mapped-release'));
    const target = generation(lock);
    const before = readFileSync(target, 'utf8');
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(import.meta.dirname, 'fixtures/mapped-lock-reader.ps1'),
        target,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    const exited = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    const output = lines[Symbol.asyncIterator]();
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    try {
      expect((await output.next()).value, errors).toBe(before);
      lock.release();
      expect(lock.isReleased).toBe(true);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ ...lock.owner, released: true });
      expect(lock.releaseRetryStats).toMatchObject({ failures: 0, maxAttempts: 1, retries: 0 });
      expect(readdirSync(lock.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      child.stdin.end('\n');
      expect((await output.next()).value).toBe(before);
      expect((await exited)[0], errors).toBe(0);
      const next = await RootLock.acquire(lock.owner.root);
      expect(next.gen).toBeGreaterThan(lock.gen);
      next.release();
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
      await exited;
      lines.close();
      if (!lock.isReleased) {
        lock.release();
      }
    }
  }
);

test.skipIf(process.platform !== 'win32')(
  'release refuses a read-only generation without changing owner bytes',
  async () => {
    const lock = await RootLock.acquire(freshDir('readonly-release'));
    const target = generation(lock);
    const before = readFileSync(target);
    chmodSync(target, 0o444);
    try {
      expect(() => lock.release()).toThrow(
        expect.objectContaining({ code: 'EACCES', win32Code: 5 })
      );
      expect(lock.isReleased).toBe(false);
      expect(readFileSync(target)).toEqual(before);
      expect(lock.releaseRetryStats).toMatchObject({
        codes: { EACCES: 20 },
        failures: 1,
        maxAttempts: 20,
      });
      expect(readdirSync(lock.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      chmodSync(target, 0o666);
      lock.release();
    }
  }
);
