// BST-1941: a release marks the Root released once, or fails leaving it held; it never renames over the held record.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { RootLock } from '../src/lock.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const original = { ...fs };
const generation = (lock: RootLock, gen = lock.gen): string =>
  join(lock.dir, `g${String(gen).padStart(12, '0')}`);
const temps = (lock: RootLock): string[] =>
  fs.readdirSync(lock.dir).filter((p) => p.endsWith('.tmp'));
const acquire = (): Promise<RootLock> => RootLock.acquire(freshDir('release'));

afterEach(() => {
  Object.defineProperty(fs, 'writeSync', { value: original.writeSync });
  Object.defineProperty(fs, 'unlinkSync', { value: original.unlinkSync });
  syncBuiltinESMExports();
  cleanupDirs();
});

test('release adds one released generation, keeps the held record, and repeating it does nothing', async () => {
  const lock = await acquire();
  const held = fs.readFileSync(generation(lock), 'utf8');
  lock.release();
  lock.release();
  expect(lock.isReleased).toBe(true);
  expect(RootLock.inspect(lock.owner.root)).toEqual({
    gen: lock.gen + 1,
    owner: { ...lock.owner, released: true },
  });
  expect(fs.readFileSync(generation(lock), 'utf8')).toBe(held);
  expect(temps(lock)).toEqual([]);
  const next = await RootLock.acquire(lock.owner.root);
  expect(next.gen).toBe(lock.gen + 2);
  expect(fs.existsSync(generation(lock))).toBe(false);
  expect(fs.existsSync(generation(lock, lock.gen + 1))).toBe(false);
  next.release();
});

for (const field of ['token', 'pid', 'start', 'host', 'root', 'released', 'missing']) {
  test(`release refuses a ${field} change to the held record and leaves the Root held`, async () => {
    const lock = await acquire();
    if (field === 'missing') {
      fs.unlinkSync(generation(lock));
    } else {
      const value = field === 'pid' ? lock.owner.pid + 1 : field === 'released' ? true : 'changed';
      fs.writeFileSync(generation(lock), JSON.stringify({ ...lock.owner, [field]: value }));
    }
    expect(() => lock.release()).toThrow(/no longer ours/u);
    expect(lock.isReleased).toBe(false);
    expect(fs.existsSync(generation(lock, lock.gen + 1))).toBe(false);
    expect(temps(lock)).toEqual([]);
  });
}

test('release refuses once a newer generation exists and leaves that claim as it is', async () => {
  const lock = await acquire();
  const newer = JSON.stringify({ ...lock.owner, token: 'new-owner' });
  fs.writeFileSync(generation(lock, lock.gen + 1), newer);
  expect(() => lock.release()).toThrow(/superseded/u);
  expect(lock.isReleased).toBe(false);
  expect(fs.readFileSync(generation(lock, lock.gen + 1), 'utf8')).toBe(newer);
  expect(temps(lock)).toEqual([]);
});

test('a release whose record cannot be written leaves the Root held and no temp behind', async () => {
  const lock = await acquire();
  const full = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  Object.defineProperty(fs, 'writeSync', {
    value: () => {
      throw full;
    },
  });
  syncBuiltinESMExports();
  expect(() => lock.release()).toThrow(full);
  expect(lock.isReleased).toBe(false);
  expect(fs.existsSync(generation(lock, lock.gen + 1))).toBe(false);
  expect(temps(lock)).toEqual([]);
});

test('a release whose temp a reader still holds (EBUSY) completes and leaves only that temp', async () => {
  const lock = await acquire();
  const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  Object.defineProperty(fs, 'unlinkSync', {
    value: (path: string) => {
      if (String(path).endsWith('.tmp')) {
        throw busy;
      }
      original.unlinkSync(path);
    },
  });
  syncBuiltinESMExports();
  lock.release();
  expect(lock.isReleased).toBe(true);
  expect(RootLock.inspect(lock.owner.root)?.owner).toEqual({ ...lock.owner, released: true });
  expect(temps(lock)).toHaveLength(1);
  Object.defineProperty(fs, 'unlinkSync', { value: original.unlinkSync });
  syncBuiltinESMExports();
  const next = await RootLock.acquire(lock.owner.root);
  expect(next.gen).toBe(lock.gen + 2);
  next.release();
});
