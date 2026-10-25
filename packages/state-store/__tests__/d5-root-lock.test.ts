// D5: the data-root lock (ADR-0031 decision 4). One OS file lock per root, held by the process that opened the store:
// a second opener is refused, in another process or this one; the OS frees it the moment its holder dies, however it
// dies; no child process inherits it; N racing processes -> exactly one winner.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { RootLock, RootLockedError } from '../src/lock.js';
import { canonicalRoot } from '../src/root-identity.js';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { fixture, killKids, runTs } from './helpers/proc.js';

afterEach(() => {
  killKids();
  cleanupDirs();
});

const HOLDER = fixture('lock-holder.ts');
const CONTENDER = fixture('lock-contender.ts');
const holder = (root: string, mode?: string): ReturnType<typeof runTs> =>
  runTs(HOLDER, mode ? [root, mode] : [root]);
const newRoot = (): string => {
  const d = join(freshDir('d5'), 'root');
  mkdirSync(d, { recursive: true });
  return d;
};
/** Whether the temp directory's file system ignores case: macOS and Windows by default, not Linux. */
const tmpFoldsCase = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'bs-ss-case-'));
  try {
    return existsSync(join(dirname(probe), basename(probe).toUpperCase()));
  } finally {
    rmSync(probe, { recursive: true });
  }
})();
const refusalOf = (open: () => unknown): unknown => {
  try {
    const lock = open();
    if (lock instanceof RootLock) {
      lock.release();
    }
    return null;
  } catch (cause) {
    return cause;
  }
};

describe('D5: data-root lock', () => {
  test('a second process opening the same data root is refused (and so is a second open in this process)', async () => {
    const root = newRoot();
    const h = holder(root);
    await h.line('READY');
    const second = holder(root, 'try');
    await second.line('REFUSED');
    expect(await second.exit()).toBe(3);
    expect(refusalOf(() => RootLock.acquire(root))).toBeInstanceOf(RootLockedError);
    // a clean close releases it (requested on stdin: Windows has no catchable SIGTERM)
    h.p.stdin?.write('CLOSE\n');
    await h.line('CLOSED');
    await h.exit();
    const store = await StateStore.open(root);
    const again = await StateStore.open(root).then(
      () => null,
      (e: unknown) => e
    );
    expect(again).toBeInstanceOf(RootLockedError); // same process, still open -> refused
    await store.close();
    expect(refusalOf(() => RootLock.acquire(root))).toBeNull();
  });

  test('a SIGKILLed owner holds nothing: the next open succeeds at once and its data is intact', async () => {
    const root = newRoot();
    const h = holder(root);
    const pid = Number((await h.line('READY')).split('pid=')[1]);
    h.p.kill('SIGKILL');
    await h.exit();
    const store = await StateStore.open(root);
    const rows = await store.read('held');
    expect(rows[0]?.raw).toContain(`written by ${pid}`);
    await store.close();
  });

  test('a child process the owner started does not hold the root after the owner is gone', async () => {
    const root = newRoot();
    const h = holder(root, 'child');
    const child = Number((await h.line('CHILD')).split('pid=')[1]);
    await h.line('READY');
    h.p.kill('SIGKILL');
    await h.exit();
    expect(() => process.kill(child, 0)).not.toThrow(); // still running
    expect(refusalOf(() => RootLock.acquire(root))).toBeNull();
    h.p.stdin?.end(); // its stdin's end lets the child exit
  });

  test('8 processes racing for one root: exactly one wins, the rest are refused', async () => {
    const root = newRoot();
    const cs = Array.from({ length: 8 }, () => runTs(CONTENDER, [root]));
    await Promise.all(cs.map((c) => c.line('READY')));
    const at = Date.now();
    for (const c of cs) {
      c.p.stdin?.write(`ACQUIRE ${at}\n`);
    }
    // The winner holds until every contender has decided, so a slow machine cannot make the race sequential.
    const decisions = await Promise.all(cs.map((c) => c.line('DECIDED')));
    expect(decisions.filter((d) => d === 'DECIDED WON')).toHaveLength(1);
    expect(decisions.filter((d) => d === 'DECIDED REFUSED')).toHaveLength(7);
    expect(refusalOf(() => RootLock.acquire(root))).toBeInstanceOf(RootLockedError);
    cs[decisions.indexOf('DECIDED WON')]?.p.stdin?.write('RELEASE\n');
    expect(await Promise.all(cs.map((c) => c.exit()))).toEqual(Array.from({ length: 8 }, () => 0));
    expect(refusalOf(() => RootLock.acquire(root))).toBeNull();
  }, 120_000);

  // A contender's own clock never decides: the OS refuses it while the winner holds, however far its clock is off.
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
      expect(refusalOf(() => RootLock.acquire(root))).toBeInstanceOf(RootLockedError);
      winner.p.stdin?.write('RELEASE\n');
      expect(await Promise.all([winner.exit(), refuser.exit()])).toEqual([0, 0]);
      expect(refusalOf(() => RootLock.acquire(root))).toBeNull();
    }
  );

  // BST-2234: Node's JS realpathSync keeps a spelling's case (and a Windows 8.3 short name) as given, so a root had
  // two identities. A trailing `.` is a second spelling on every file system; a case-folding one has another.
  test('a lock taken through another spelling of its root records the canonical root, and that root is refused', () => {
    const root = newRoot();
    const spellings = [
      `${root}${sep}.`,
      ...(tmpFoldsCase ? [join(dirname(root), basename(root).toUpperCase())] : []),
    ];
    for (const respelled of spellings) {
      const lock = RootLock.acquire(respelled);
      try {
        const refusal = refusalOf(() => RootLock.acquire(root));
        expect(refusal).toBeInstanceOf(RootLockedError);
        expect(refusal).toMatchObject({ root: canonicalRoot(root) });
        expect(lock.root).toBe(canonicalRoot(root));
        expect(lock.root).not.toBe(respelled);
      } finally {
        lock.release();
      }
    }
  });
});
