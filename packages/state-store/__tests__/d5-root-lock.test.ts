// D5 / M0-A1 / M0-A2: the data-root lock (spike test/d5-dir-lock.test.ts, on RootLock). A second process is refused;
// a SIGKILLed owner's stale lock is recovered (pid + start time); a reused pid is stale; a foreign host's lock is never
// taken over (live host-discovery contract supersedes historical spike confirmation policy); N racing processes ->
// exactly one winner. On Windows the start time comes from GetProcessTimes (BST-1941).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ForeignLockError,
  type LockOwner,
  processStartTime,
  RootLock,
  RootLockedError,
} from '../src/lock.js';
import { canonicalRoot } from '../src/root-identity.js';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { fixture, killKids, run, runTs } from './helpers/proc.js';

const fsCjs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
/** Whether the temp directory's file system ignores case: macOS and Windows by default, not Linux. */
const tmpFoldsCase = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'bs-ss-case-'));
  try {
    return existsSync(join(dirname(probe), basename(probe).toUpperCase()));
  } finally {
    rmSync(probe, { recursive: true });
  }
})();
afterEach(() => {
  killKids();
  cleanupDirs();
});

/**
 * What `processStartTime` reads per platform: Windows' FILETIME count, Linux's start in ticks
 * since boot with the boot's id (BST-2514), and elsewhere `ps`'s `lstart`, which ends in the year.
 */
const START_TIME_FORMAT: Partial<Record<NodeJS.Platform, RegExp>> = {
  linux: /^\d+\.\d{2} s after boot \S+$/u,
  win32: /^\d+$/u,
};
const HOLDER = fixture('lock-holder.ts');
const CONTENDER = fixture('lock-contender.ts');
const holder = (root: string, mode?: string): ReturnType<typeof runTs> =>
  runTs(HOLDER, mode ? [root, mode] : [root]);
/** The live owner of the newest generation (null if none or released). */
const lockOf = (root: string): LockOwner | null => {
  const i = RootLock.inspect(root);
  return i && !i.owner.released ? i.owner : null;
};
/** Plant a lock owned by someone else as the next generation. */
const plant = (root: string, o: Omit<LockOwner, 'root'> & { root?: string }): void => {
  const ld = RootLock.dirOf(root);
  mkdirSync(ld, { recursive: true });
  const g = (RootLock.inspect(root)?.gen ?? -1) + 1;
  writeFileSync(
    join(ld, `g${String(g).padStart(12, '0')}`),
    JSON.stringify({ root: canonicalRoot(root), ...o })
  );
};
const newRoot = (): string => {
  const d = join(freshDir('d5'), 'root');
  mkdirSync(d, { recursive: true });
  return d;
};
const exited = async (): Promise<number> => {
  const ghost = run(['-e', 'console.log("UP")']);
  await ghost.line('UP');
  await ghost.exit();
  return ghost.p.pid as number;
};

/** Every decision is observed before RELEASE, and the winner must still refuse a real opener. */
async function finishHeldRace(
  root: string,
  contenders: readonly ReturnType<typeof runTs>[]
): Promise<string[]> {
  const decisions = await Promise.all(contenders.map((contender) => contender.line('DECIDED')));
  expect(decisions.filter((decision) => decision === 'DECIDED WON')).toHaveLength(1);
  expect(decisions.filter((decision) => decision === 'DECIDED REFUSED')).toHaveLength(
    contenders.length - 1
  );
  const winner = contenders[decisions.indexOf('DECIDED WON')];
  if (!winner) {
    throw new Error('the race reported no winning contender');
  }
  expect(lockOf(root)?.pid).toBe(winner.p.pid);
  const refusal = await RootLock.acquire(root).then(
    (lock) => {
      lock.release();
      return null;
    },
    (error: unknown) => error
  );
  expect(refusal).toBeInstanceOf(RootLockedError);
  if (refusal instanceof RootLockedError) {
    expect(refusal.owner.pid).toBe(winner.p.pid);
  }
  winner.p.stdin?.write('RELEASE\n');
  const exits = await Promise.all(contenders.map((contender) => contender.exit()));
  for (const code of exits) {
    expect(code).toBe(0);
  }
  expect(lockOf(root)).toBeNull();
  return contenders.map(
    (contender) =>
      contender
        .out()
        .split('\n')
        .find((line) => /^(WON|REFUSED|ERROR) /u.test(line))
        ?.trim() ?? ''
  );
}

describe('D5: data-root lock', () => {
  test('a second process opening the same data root is refused (and so is a second open in this process)', async () => {
    const root = newRoot();
    const h = holder(root);
    const ready = await h.line('READY');
    const pid = Number(ready.split('pid=')[1]);
    expect(lockOf(root)?.pid).toBe(pid);
    // another process
    const second = holder(root, 'try');
    expect(await second.line('REFUSED')).toBe(`REFUSED owner=${pid}`);
    expect(await second.exit()).toBe(3);
    // this process
    const err = await StateStore.open(root).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(RootLockedError);
    expect((err as RootLockedError).owner.pid).toBe(pid);
    // a clean close releases it (requested on stdin: Windows has no catchable SIGTERM)
    h.p.stdin?.write('CLOSE\n');
    await h.line('CLOSED');
    await h.exit();
    expect(lockOf(root)).toBeNull();
    const store = await StateStore.open(root);
    const again = await StateStore.open(root).then(
      () => null,
      (e: unknown) => e
    );
    expect(again).toBeInstanceOf(RootLockedError); // same process, still open -> refused
    expect((again as RootLockedError).owner.pid).toBe(process.pid);
    await store.close();
    expect(lockOf(root)).toBeNull();
  });

  test('a stale lock left by a SIGKILLed owner is recovered; the owner data is intact', async () => {
    const root = newRoot();
    const h = holder(root);
    const pid = Number((await h.line('READY')).split('pid=')[1]);
    h.p.kill('SIGKILL');
    await h.exit();
    expect(lockOf(root)?.pid).toBe(pid); // left behind
    const broken: LockOwner[] = [];
    const store = await StateStore.open(root, { onStaleBroken: (o) => broken.push(o) });
    expect(broken.map((o) => o.pid)).toEqual([pid]);
    expect(lockOf(root)?.pid).toBe(process.pid);
    const rows = await store.read('held');
    expect(rows[0]?.raw).toContain(`written by ${pid}`);
    await store.close();
    expect(lockOf(root)).toBeNull();
  });

  test('pid reuse: a live pid with another start time is stale; the same pid + start time is live', async () => {
    const root = newRoot();
    const sleeper = run(['-e', 'console.log("UP"); setTimeout(() => {}, 30000)']);
    await sleeper.line('UP');
    const pid = sleeper.p.pid as number;
    const start = processStartTime(pid) as string;
    expect(start).toMatch(START_TIME_FORMAT[process.platform] ?? /\d{4}$/u);
    // same pid, different start time -> the pid was reused -> stale
    plant(root, { host: hostname(), pid, start: 'Thu Jan  1 00:00:00 1970', token: 'reused' });
    const broken: LockOwner[] = [];
    const store = await StateStore.open(root, { onStaleBroken: (o) => broken.push(o) });
    expect(broken.map((o) => o.token)).toEqual(['reused']);
    await store.close();
    // same pid AND start time -> live -> refused
    plant(root, { host: hostname(), pid, start, token: 'live' });
    const err = await StateStore.open(root).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(RootLockedError);
    expect((err as RootLockedError).owner.token).toBe('live');
  });

  test('an unexpected process probe failure leaves the owner lock intact', async () => {
    const root = newRoot();
    plant(root, {
      host: hostname(),
      pid: process.pid,
      start: processStartTime(process.pid) as string,
      token: 'probe-error',
    });
    const original = process.kill;
    process.kill = () => {
      throw Object.assign(new Error('process probe unavailable'), { code: 'EIO' });
    };
    try {
      await expect(RootLock.acquire(root)).rejects.toThrow(/process probe unavailable/u);
      expect(lockOf(root)?.token).toBe('probe-error');
    } finally {
      process.kill = original;
    }
  });

  test('a lock from another host is never taken over, even if its pid does not exist here', async () => {
    const root = newRoot();
    plant(root, { host: `not-${hostname()}`, pid: 99_999_999, start: 'x', token: 'foreign' });
    const err = await StateStore.open(root).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ForeignLockError);
    expect(lockOf(root)?.token).toBe('foreign');
  });

  test('a foreign host lock is never taken over even when a callback approves it', async () => {
    const root = newRoot();
    plant(root, { host: `not-${hostname()}`, pid: 99_999_999, start: 'x', token: 'foreign' });
    let asked = false;
    await expect(
      RootLock.acquire(root, {
        onForeignLock: () => {
          asked = true;
          return true;
        },
      })
    ).rejects.toThrow(ForeignLockError);
    expect(asked).toBe(false);
    expect(lockOf(root)?.token).toBe('foreign');
  });

  test('a same-host lock copied from another root is taken over only when the opener confirms it', async () => {
    const root = newRoot();
    // A live pid: a copied root's lock cannot be judged by pid, so only the opener's answer decides.
    const copied = {
      host: hostname(),
      pid: process.pid,
      root: '/some/other/root',
      start: processStartTime(process.pid) as string,
      token: 'copied',
    };
    plant(root, copied);
    await expect(RootLock.acquire(root)).rejects.toThrow(ForeignLockError);
    await expect(RootLock.acquire(root, { onForeignLock: () => false })).rejects.toThrow(
      ForeignLockError
    );
    expect(lockOf(root)?.token).toBe('copied');

    const asked: LockOwner[] = [];
    const lock = await RootLock.acquire(root, {
      onForeignLock: (owner) => {
        asked.push(owner);
        return true;
      },
    });
    try {
      expect(asked).toEqual([copied]);
      expect(lock.owner.root).toBe(canonicalRoot(root));
    } finally {
      lock.release();
    }
  });

  // BST-2234: Node's JS realpathSync keeps a spelling's case (and a Windows 8.3 short name) as given, so the lock
  // recorded one spelling and its comparers derived another. A case-sensitive file system has no second spelling.
  test.skipIf(!tmpFoldsCase)(
    'a lock taken through another spelling of its root records the canonical root, and that root is refused as live, not foreign',
    async () => {
      const root = newRoot();
      const respelled = join(dirname(root), basename(root).toUpperCase());
      const lock = await RootLock.acquire(respelled);
      try {
        await expect(RootLock.acquire(root)).rejects.toThrow(RootLockedError);
        expect(lock.owner.root).toBe(canonicalRoot(root));
        expect(lock.owner.root).not.toBe(respelled);
      } finally {
        lock.release();
      }
    }
  );

  test('a winner that acted on an old listing drops its generation when a newer one exists (deterministic interleaving)', async () => {
    // X lists the lock dir and sees only a stale g0. Before X links g1, another process takes over: it creates g1 and
    // then g2, and its cleanup deletes g1. Simulated by injecting g2 (live owner) right after X's first listing.
    const root = newRoot();
    plant(root, { host: hostname(), pid: await exited(), start: 'gone', token: 'stale' });
    const sleeper = run(['-e', 'console.log("UP"); setTimeout(() => {}, 30000)']);
    await sleeper.line('UP');
    const ld = RootLock.dirOf(canonicalRoot(root));
    const orig = fsCjs.readdirSync;
    let fired = false;
    (fsCjs as { readdirSync: unknown }).readdirSync = function (
      this: unknown,
      p: string,
      ...rest: unknown[]
    ) {
      const out = (orig as (...a: unknown[]) => unknown).call(this, p, ...rest);
      if (!fired && String(p) === ld) {
        fired = true;
        const newer: LockOwner = {
          host: hostname(),
          pid: sleeper.p.pid as number,
          root: canonicalRoot(root),
          start: processStartTime(sleeper.p.pid as number) as string,
          token: 'newer',
        };
        writeFileSync(join(ld, 'g000000000002'), JSON.stringify(newer));
      }
      return out;
    };
    syncBuiltinESMExports();
    let err: unknown = null;
    try {
      (await RootLock.acquire(root)).release();
    } catch (e) {
      err = e;
    } finally {
      (fsCjs as { readdirSync: unknown }).readdirSync = orig;
      syncBuiltinESMExports();
    }
    expect(fired).toBe(true);
    expect(err).toBeInstanceOf(RootLockedError);
    expect((err as RootLockedError).owner.token).toBe('newer');
    expect(existsSync(join(ld, 'g000000000001'))).toBe(false); // X dropped the generation it raced into
  });

  test('8 processes racing for one stale lock: exactly one wins, the rest are refused', async () => {
    const rounds: Array<{ won: number; refused: number; errors: string[] }> = [];
    const lateness: number[][] = [];
    // One real eight-process race covers the ownership contract. Repeated
    // scheduling stress is explicit, rather than paid for on every unit run.
    const roundCount = process.env['BRAINSTRIKE_TEST_STRESS'] === '1' ? 10 : 1;
    for (let round = 0; round < roundCount; round++) {
      const root = newRoot();
      // a stale owner: a process that existed and is gone
      plant(root, {
        host: hostname(),
        pid: await exited(),
        start: 'gone',
        token: `stale-${round}`,
      });
      const cs = Array.from({ length: 8 }, () => runTs(CONTENDER, [root]));
      // Start together after every real process is ready. Retain the winner
      // until every contender decides, so a slow machine cannot turn this
      // into sequential ownership. No platform-specific sleeps are needed.
      await Promise.all(cs.map((c) => c.line('READY')));
      const at = Date.now();
      for (const c of cs) {
        c.p.stdin?.write(`ACQUIRE ${at}\n`);
      }
      const outs = await finishHeldRace(root, cs);
      const r = {
        errors: outs.filter((o) => !(o.startsWith('WON') || o.startsWith('REFUSED'))),
        refused: outs.filter((o) => o.startsWith('REFUSED')).length,
        won: outs.filter((o) => o.startsWith('WON')).length,
      };
      lateness.push(outs.map((o) => Number(/late=(-?\d+)ms/u.exec(o)?.[1] ?? Number.NaN)));
      rounds.push(r);
    }
    process.stdout.write(
      `[D5 race] ${JSON.stringify(rounds)}\n[D5 race lateness] ${JSON.stringify(lateness)}\n`
    );
    for (const r of rounds) {
      expect(r.errors).toEqual([]);
      expect(r.won).toBe(1);
      expect(r.refused).toBe(7);
    }
  }, 600_000);

  test.each([60_000, -60_000])(
    'refusal stays inside the held-lock barrier with a %i ms contender clock skew',
    async (offsetMs) => {
      const root = newRoot();
      const winner = runTs(CONTENDER, [root]);
      const refuser = runTs(CONTENDER, [root, String(offsetMs)]);
      await Promise.all([winner.line('READY'), refuser.line('READY')]);
      winner.p.stdin?.write(`ACQUIRE ${Date.now()}\n`);
      expect(await winner.line('DECIDED')).toBe('DECIDED WON');
      refuser.p.stdin?.write(`ACQUIRE ${Date.now()}\n`);
      expect(await refuser.line('DECIDED')).toBe('DECIDED REFUSED');
      expect(lockOf(root)?.pid).toBe(winner.p.pid);
      const outs = await finishHeldRace(root, [winner, refuser]);
      expect(outs[0]).toMatch(/^WON /u);
      expect(outs[1]).toMatch(/^REFUSED /u);
    }
  );
});
