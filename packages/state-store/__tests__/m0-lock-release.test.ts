// BST-1941: deterministic controls for the observed Windows release EPERM.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { RootLock } from '../src/lock.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const original = { ...fs };
const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
const generation = (lock: RootLock): string =>
  join(lock.dir, `g${String(lock.gen).padStart(12, '0')}`);
const temps = (lock: RootLock): string[] =>
  original.readdirSync(lock.dir).filter((p) => p.endsWith('.tmp'));
const caught = (fn: () => void): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};
const acquire = async (os: 'win32' | 'darwin' = 'win32'): Promise<RootLock> => {
  const lock = await RootLock.acquire(freshDir('release'));
  Object.defineProperty(process, 'platform', { value: os });
  vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
  return lock;
};
const inject = <K extends keyof typeof fs>(name: K, value: (typeof fs)[K]): void => {
  fs[name] = value;
  syncBuiltinESMExports();
};

afterEach(() => {
  for (const name of [
    'renameSync',
    'fsyncSync',
    'closeSync',
    'readFileSync',
    'readdirSync',
    'writeSync',
    'openSync',
    'unlinkSync',
  ] as const) {
    Object.defineProperty(fs, name, { value: original[name] });
  }
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  cleanupDirs();
});

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`release retries transient ${code} with one closed, fsynced temp`, async () => {
    const lock = await acquire();
    const paths: string[] = [];
    let ownedFd: number | undefined;
    let synced = false;
    let closed = false;
    inject('openSync', (path, flags, mode) => {
      const fd = original.openSync(path, flags, mode);
      if (flags === 'wx') {
        ownedFd = fd;
      }
      return fd;
    });
    inject('fsyncSync', (fd) => {
      expect(fd).toBe(ownedFd);
      original.fsyncSync(fd);
      synced = true;
    });
    inject('closeSync', (fd) => {
      original.closeSync(fd);
      if (fd === ownedFd) {
        closed = true;
      }
    });
    inject('renameSync', (from, to) => {
      paths.push(String(from));
      expect(synced && closed).toBe(true);
      expect(JSON.parse(original.readFileSync(from, 'utf8'))).toEqual({
        ...lock.owner,
        released: true,
      });
      if (paths.length === 1) {
        throw errno(code);
      }
      original.renameSync(from, to);
    });
    lock.release();
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(1);
    expect(lock.isReleased).toBe(true);
    expect(RootLock.inspect(lock.owner.root)?.owner).toEqual({ ...lock.owner, released: true });
    expect(temps(lock)).toEqual([]);
    expect(lock.releaseRetryStats).toEqual({
      codes: { [code]: 1 },
      failures: 0,
      maxAttempts: 2,
      ops: 1,
      retried: 1,
      retries: 1,
    });
    const snapshot = lock.releaseRetryStats;
    expect(snapshot.codes).not.toBe(lock.releaseRetryStats.codes);
    lock.release();
    expect(paths).toHaveLength(2);
    expect(lock.releaseRetryStats).toEqual(snapshot);
  });

  test(`release stops after 20 persistent ${code} failures and preserves authority`, async () => {
    const lock = await acquire();
    const before = original.readFileSync(generation(lock));
    const error = errno(code);
    const paths: string[] = [];
    inject('renameSync', (from) => {
      paths.push(String(from));
      throw error;
    });
    expect(caught(() => lock.release())).toBe(error);
    expect(paths).toHaveLength(20);
    expect(new Set(paths).size).toBe(1);
    expect(original.readFileSync(generation(lock))).toEqual(before);
    expect(lock.isReleased).toBe(false);
    expect(temps(lock)).toEqual([]);
    expect(lock.releaseRetryStats).toEqual({
      codes: { [code]: 20 },
      failures: 1,
      maxAttempts: 20,
      ops: 1,
      retried: 0,
      retries: 0,
    });
    expect(vi.mocked(Atomics.wait).mock.calls.map((args) => args[3])).toEqual([
      1,
      2,
      4,
      8,
      16,
      32,
      ...new Array<number>(13).fill(64),
    ]);
  });
}

for (const field of ['token', 'pid', 'start', 'host', 'root', 'released', 'newer', 'missing']) {
  test(`release refuses ${field} change between attempts without another rename`, async () => {
    const lock = await acquire();
    let attempts = 0;
    let changedPath = generation(lock);
    const value = field === 'pid' ? lock.owner.pid + 1 : field === 'released' ? true : 'changed';
    inject('renameSync', () => {
      attempts++;
      if (field === 'newer') {
        changedPath = join(lock.dir, `g${String(lock.gen + 1).padStart(12, '0')}`);
        original.writeFileSync(changedPath, JSON.stringify({ ...lock.owner, token: 'new-owner' }));
      } else if (field === 'missing') {
        original.unlinkSync(changedPath);
      } else {
        original.writeFileSync(changedPath, JSON.stringify({ ...lock.owner, [field]: value }));
      }
      throw errno('EPERM');
    });
    expect(() => lock.release()).toThrow(/no longer ours|superseded/);
    expect(attempts).toBe(1);
    expect(lock.isReleased).toBe(false);
    expect(temps(lock)).toEqual([]);
    expect(lock.releaseRetryStats).toMatchObject({
      codes: { EPERM: 1, LOCK_RELEASE_AUTHORITY: 1 },
      failures: 1,
      maxAttempts: 2,
      retried: 0,
      retries: 0,
    });
    if (field === 'missing') {
      expect(original.existsSync(changedPath)).toBe(false);
    } else {
      expect(JSON.parse(original.readFileSync(changedPath, 'utf8'))).toMatchObject(
        field === 'newer' ? { token: 'new-owner' } : { [field]: value }
      );
    }
  });
}

test('a nonretryable rename preserves its cause and cleans only its own temp', async () => {
  const lock = await acquire();
  original.writeFileSync(join(lock.dir, '.other-owner.tmp'), 'other');
  const before = original.readFileSync(generation(lock));
  const error = errno('EIO');
  const rename = vi.fn(() => {
    throw error;
  });
  inject('renameSync', rename);
  expect(caught(() => lock.release())).toBe(error);
  expect(rename).toHaveBeenCalledTimes(1);
  expect(original.readFileSync(generation(lock))).toEqual(before);
  expect(temps(lock)).toEqual(['.other-owner.tmp']);
  expect(lock.isReleased).toBe(false);
  expect(lock.releaseRetryStats).toMatchObject({ codes: { EIO: 1 }, failures: 1, maxAttempts: 1 });
});

for (const mode of ['read', 'listing', 'json', 'malformed']) {
  test(`authority ${mode} failure between attempts is terminal even for a retryable errno`, async () => {
    const lock = await acquire();
    const error = errno('EPERM');
    let attempts = 0;
    inject('renameSync', () => {
      attempts++;
      if (mode === 'read') {
        inject('readFileSync', (() => {
          throw error;
        }) as typeof fs.readFileSync);
      } else if (mode === 'listing') {
        inject('readdirSync', (() => {
          throw error;
        }) as typeof fs.readdirSync);
      } else {
        original.writeFileSync(generation(lock), mode === 'json' ? '{' : '{}');
      }
      throw errno('EBUSY');
    });
    const failure = caught(() => lock.release());
    if (mode === 'read' || mode === 'listing') {
      expect(failure).toBe(error);
    } else {
      expect(failure).toBeInstanceOf(mode === 'json' ? SyntaxError : Error);
    }
    expect(attempts).toBe(1);
    expect(lock.isReleased).toBe(false);
    expect(temps(lock)).toEqual([]);
    expect(vi.mocked(Atomics.wait)).toHaveBeenCalledTimes(1);
    expect(lock.releaseRetryStats).toMatchObject({
      codes: { EBUSY: 1, LOCK_RELEASE_AUTHORITY: 1 },
      failures: 1,
      maxAttempts: 2,
    });
  });
}

test('preflight read failure preserves its cause without preparing a temp or entering retry', async () => {
  const lock = await acquire();
  const error = errno('EPERM');
  const open = vi.fn(original.openSync);
  const rename = vi.fn(original.renameSync);
  inject('readFileSync', (() => {
    throw error;
  }) as typeof fs.readFileSync);
  inject('openSync', open);
  inject('renameSync', rename);
  expect(caught(() => lock.release())).toBe(error);
  expect(open).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  expect(temps(lock)).toEqual([]);
  expect(lock.releaseRetryStats).toEqual({
    codes: {},
    failures: 0,
    maxAttempts: 0,
    ops: 0,
    retried: 0,
    retries: 0,
  });
  expect(lock.isReleased).toBe(false);
});

for (const stage of ['writeSync', 'fsyncSync', 'closeSync'] as const) {
  test(`release ${stage} preparation failure closes and removes its owned temp`, async () => {
    const lock = await acquire();
    const before = original.readFileSync(generation(lock));
    const error = errno('ENOSPC');
    const rename = vi.fn(original.renameSync);
    inject('renameSync', rename);
    let ownedFd: number | undefined;
    inject('openSync', (path, flags, mode) => {
      const fd = original.openSync(path, flags, mode);
      if (flags === 'wx') {
        ownedFd = fd;
      }
      return fd;
    });
    let closed = false;
    const close = original.closeSync;
    inject('closeSync', (fd) => {
      close(fd);
      if (fd === ownedFd) {
        closed = true;
      }
    });
    let failed = false;
    inject(stage, ((fd: number) => {
      if (stage === 'closeSync' && fd !== ownedFd) {
        close(fd);
        return;
      }
      if (stage === 'closeSync' && failed) {
        close(fd);
        closed = true;
        return;
      }
      failed = true;
      throw error;
    }) as (typeof fs)[typeof stage]);
    expect(caught(() => lock.release())).toBe(error);
    inject('closeSync', close);
    expect(closed).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    expect(original.readFileSync(generation(lock))).toEqual(before);
    expect(lock.isReleased).toBe(false);
    expect(temps(lock)).toEqual([]);
  });
}

test('release cleanup failure retains both causes and exact owned temp identity', async () => {
  const lock = await acquire();
  const primary = errno('EIO');
  const cleanup = errno('EACCES');
  let ownedTemp = '';
  inject('renameSync', (from) => {
    ownedTemp = String(from);
    throw primary;
  });
  inject('unlinkSync', (path) => {
    expect(String(path)).toBe(ownedTemp);
    throw cleanup;
  });
  const failure = caught(() => lock.release());
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
  expect((failure as Error).cause).toBe(primary);
  expect((failure as Error).message).toContain(ownedTemp);
  expect(original.existsSync(ownedTemp)).toBe(true);
  expect(lock.isReleased).toBe(false);
});

test('preparation preserves write, close and cleanup failures together', async () => {
  const lock = await acquire();
  const write = errno('ENOSPC');
  const close = errno('EIO');
  const cleanup = errno('EACCES');
  inject('writeSync', (() => {
    throw write;
  }) as typeof fs.writeSync);
  inject('closeSync', (fd) => {
    original.closeSync(fd);
    throw close;
  });
  inject('unlinkSync', () => {
    throw cleanup;
  });
  const failure = caught(() => lock.release()) as AggregateError;
  expect(failure.errors).toEqual([write, close, cleanup]);
  expect(failure.cause).toBe(write);
  expect(temps(lock)).toHaveLength(1);
  expect(failure.message).toContain(join(lock.dir, temps(lock)[0] as string));
  expect(lock.isReleased).toBe(false);
});

test('failed exclusive open never removes a temp it does not own', async () => {
  const lock = await acquire();
  const error = errno('EEXIST');
  const unlink = vi.fn(original.unlinkSync);
  inject('openSync', () => {
    throw error;
  });
  inject('unlinkSync', unlink);
  expect(caught(() => lock.release())).toBe(error);
  expect(unlink).not.toHaveBeenCalled();
  expect(lock.isReleased).toBe(false);
});

test('POSIX makes exactly one rename attempt on EPERM and preserves authority', async () => {
  const lock = await acquire('darwin');
  const before = original.readFileSync(generation(lock));
  const error = errno('EPERM');
  const rename = vi.fn(() => {
    throw error;
  });
  inject('renameSync', rename);
  expect(caught(() => lock.release())).toBe(error);
  expect(rename).toHaveBeenCalledTimes(1);
  expect(original.readFileSync(generation(lock))).toEqual(before);
  expect(lock.isReleased).toBe(false);
  expect(temps(lock)).toEqual([]);
  expect(vi.mocked(Atomics.wait)).not.toHaveBeenCalled();
});

test('POSIX successful release is atomic and repeat release does nothing', async () => {
  const lock = await acquire('darwin');
  const rename = vi.fn(original.renameSync);
  inject('renameSync', rename);
  lock.release();
  lock.release();
  expect(rename).toHaveBeenCalledTimes(1);
  expect(lock.isReleased).toBe(true);
  expect(RootLock.inspect(lock.owner.root)?.owner).toEqual({ ...lock.owner, released: true });
  expect(temps(lock)).toEqual([]);
});
