// D5 / M0-A1 / M0-A2: the data-root lock (spike test/d5-dir-lock.test.ts, on RootLock). A second process is refused;
// a SIGKILLed owner's stale lock is recovered (pid + start time); a reused pid is stale; a foreign host's lock is never
// taken over (live host-discovery contract supersedes historical spike confirmation policy); N racing processes ->
// exactly one winner. On Windows the start time comes from GetProcessTimes (BST-1941).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ForeignLockError,
  type LockOwner,
  processStartTime,
  RootLock,
  RootLockedError,
} from '../src/lock.js';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { fixture, killKids, run, runTs } from './helpers/proc.js';

const fsCjs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
afterEach(() => {
  killKids();
  cleanupDirs();
});

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
    JSON.stringify({ root: realpathSync(root), ...o })
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
    expect(start).toMatch(process.platform === 'win32' ? /^\d+$/ : /\d{4}$/);
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

  test.skipIf(process.platform !== 'linux')(
    'an unreaped exited owner is stale while its live identity still refuses Root takeover',
    async () => {
      const root = newRoot();
      // Stop only our direct parent before the owned holder exits, so Linux
      // retains a real zombie until this test resumes and joins its parent.
      const parent = run([
        '-e',
        `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['--import','tsx',process.argv[1],process.argv[2]],{stdio:['pipe','pipe','pipe']});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.once('error',error=>{throw error});
child.once('close',()=>process.exit(0));
process.stdin.on('data',()=>child.kill('SIGKILL'));`,
        HOLDER,
        root,
      ]);
      const parentClosed = new Promise<number | null>((resolve, reject) => {
        parent.p.once('close', resolve);
        parent.p.once('error', reject);
      });
      let recovered: StateStore | undefined;
      const state = (pid: number): string[] => {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      };
      try {
        const pid = Number((await parent.line('READY')).split('pid=')[1]);
        const owner = lockOf(root) as LockOwner;
        expect(processStartTime(pid)).toBe(owner.start);
        await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
        expect(lockOf(root)).toEqual(owner);

        parent.p.kill('SIGSTOP');
        await expect.poll(() => state(parent.p.pid as number)[0]).toBe('T');
        process.kill(pid, 'SIGKILL');
        await expect.poll(() => state(pid)[0]).toBe('Z');
        expect(Number(state(pid)[1])).toBe(parent.p.pid);
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(lockOf(root)).toEqual(owner);

        const broken: LockOwner[] = [];
        recovered = await StateStore.open(root, { onStaleBroken: (value) => broken.push(value) });
        expect(broken).toEqual([owner]);
        expect(processStartTime(pid)).toBeNull();
        expect(lockOf(root)?.pid).toBe(process.pid);
        const rows = await recovered.read('held');
        expect(rows[0]?.raw).toContain(`written by ${pid}`);
      } finally {
        try {
          await recovered?.close();
        } finally {
          parent.p.kill('SIGCONT');
          parent.p.stdin?.end('KILL\n');
          await parentClosed;
        }
      }
    }
  );

  test
    .skipIf(process.platform !== 'linux')
    .each(['unknown state', 'unavailable ps', 'invisible live pid', 'permission denied live pid'])(
    'a live Linux owner is retained when identity has %s',
    async (failure) => {
      const root = newRoot();
      const sleeper = run(['-e', 'console.log("UP"); setInterval(() => {}, 1000)']);
      const cp = createRequire(import.meta.url)(
        'node:child_process'
      ) as typeof import('node:child_process');
      const original = cp.execFileSync;
      const originalKill = process.kill;
      const psFailure = Object.assign(
        new Error(failure === 'unavailable ps' ? 'ps unavailable' : 'ps cannot observe owner'),
        failure === 'unavailable ps' ? { code: 'ENOENT' } : { status: 1, stderr: '', stdout: '' }
      );
      try {
        await sleeper.line('UP');
        const pid = sleeper.p.pid as number;
        const start = processStartTime(pid) as string;
        plant(root, { host: hostname(), pid, start, token: 'unverified' });
        const owner = lockOf(root);
        (cp as { execFileSync: unknown }).execFileSync = (
          executable: string,
          args: readonly string[],
          options: unknown
        ) => {
          if (executable === 'ps' && args.at(-1) === String(pid)) {
            if (failure !== 'unknown state') {
              throw psFailure;
            }
            return `? ${start}`;
          }
          return Reflect.apply(original, cp, [executable, args, options]);
        };
        if (failure === 'permission denied live pid') {
          process.kill = (target, signal) => {
            if (target === pid && signal === 0) {
              throw Object.assign(new Error('Live owner cannot be signalled'), { code: 'EPERM' });
            }
            return originalKill.call(process, target, signal);
          };
        }
        syncBuiltinESMExports();
        if (failure === 'unknown state') {
          await expect(RootLock.acquire(root)).rejects.toThrow(/process identity/);
        } else {
          await expect(RootLock.acquire(root)).rejects.toBe(psFailure);
        }
        expect(lockOf(root)).toEqual(owner);
      } finally {
        (cp as { execFileSync: unknown }).execFileSync = original;
        process.kill = originalKill;
        syncBuiltinESMExports();
        sleeper.p.kill('SIGTERM');
        await sleeper.exit();
      }
    }
  );

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
      await expect(RootLock.acquire(root)).rejects.toThrow(/process probe unavailable/);
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

  test('a winner that acted on an old listing drops its generation when a newer one exists (deterministic interleaving)', async () => {
    // X lists the lock dir and sees only a stale g0. Before X links g1, another process takes over: it creates g1 and
    // then g2, and its cleanup deletes g1. Simulated by injecting g2 (live owner) right after X's first listing.
    const root = newRoot();
    plant(root, { host: hostname(), pid: await exited(), start: 'gone', token: 'stale' });
    const sleeper = run(['-e', 'console.log("UP"); setTimeout(() => {}, 30000)']);
    await sleeper.line('UP');
    const ld = RootLock.dirOf(realpathSync(root));
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
          root: realpathSync(root),
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

  test('8 processes racing for one stale lock: exactly one wins, the rest are refused (10 rounds)', async () => {
    const rounds: Array<{ won: number; refused: number; errors: string[] }> = [];
    const lateness: number[][] = [];
    for (let round = 0; round < 10; round++) {
      const root = newRoot();
      // a stale owner: a process that existed and is gone
      plant(root, {
        host: hostname(),
        pid: await exited(),
        start: 'gone',
        token: `stale-${round}`,
      });
      // On Windows, tsx + a PowerShell start-time read take seconds, so the barrier and the hold are longer: the winner
      // must still hold the lock when the slowest contender decides, or a later (legitimate) owner looks like a 2nd winner.
      const win = process.platform === 'win32';
      const at = Date.now() + (win ? 10_000 : 2500);
      const cs = Array.from({ length: 8 }, () =>
        runTs(CONTENDER, [root, String(at), String(win ? 15_000 : 1000)])
      );
      await Promise.all(cs.map((c) => c.exit()));
      const outs = cs.map((c) => c.out().trim());
      const r = {
        errors: outs.filter((o) => !(o.startsWith('WON') || o.startsWith('REFUSED'))),
        refused: outs.filter((o) => o.startsWith('REFUSED')).length,
        won: outs.filter((o) => o.startsWith('WON')).length,
      };
      lateness.push(outs.map((o) => Number(/late=(-?\d+)ms/.exec(o)?.[1] ?? Number.NaN)));
      // every refusal was decided while the winner held the lock (the race was real, not sequential)
      const held = outs.map((o) => /held=(\d+)\.\.(\d+)/.exec(o)).find(Boolean);
      if (held) {
        for (const o of outs) {
          const d = /decided=(\d+)/.exec(o);
          if (d) {
            expect(Number(d[1])).toBeLessThanOrEqual(Number(held[2]));
          }
        }
      }
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
});
