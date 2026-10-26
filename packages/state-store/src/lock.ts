// Data-root lock (M0-A2 src/lock.ts, adapted from spike s-dur D5), with the Windows process start time from M0-A1
// src/dir-lock.ts:32-59.
//
// Generation files `g<12 digits>` are created with link(fsynced temp), which fails with EEXIST, so exactly one of N
// contenders wins a generation; a winner re-lists and drops its own file if a newer generation exists. Nobody ever
// renames or unlinks someone else's live lock. A release claims the next generation with its record marked released
// and leaves the held record in place: on Windows a reader that withholds delete sharing (an antivirus scan, held by
// the System process) refuses any rename over a file it has open.
//
// The lock lives INSIDE the root (`<root>/lock/`), so any file-level copy of a root (Time Machine, Migration Assistant,
// `cp -R`, the export bundle) carries it, and the owner records the root's canonical path (`canonicalRoot`, BST-2234). A lock from another host is refused unconditionally. A same-host lock copied from another root cannot be judged
// by pid: the opener confirms the copied-root takeover explicitly.
//
// The record names the owner; on POSIX the Root itself is an flock(2) on `<root>/lock/root.flock`, taken right after a
// generation is claimed and inherited by every native process the owner starts (`spawnNativeChild`). An flock belongs
// to the open file description, so it outlives a crashed owner for as long as any descendant that inherited it lives:
// a record is stale only when its pid is dead AND that flock is free (ADR-0017). A claim that finds the flock held is
// withdrawn, so the earlier record stays newest. Windows has no inheritable lock; the host's Job Object ends its native
// processes with it instead.
//
// Owner identity = { pid, start, host, root, token }. `start` is the OS-reported start time of `pid`, read the SAME way
// for the owner (at acquisition) and for a checker, so the comparison is exact and defeats pid reuse:
//   darwin: `ps -o lstart= -p <pid>` with LC_ALL=C TZ=UTC (1 s resolution);
//   linux: the same text, computed from /proc as procps computes it, so no process is started per read;
//   win32: the creation time from GetProcessTimes (100 ns FILETIME).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { canonicalRoot } from './root-identity.ts';

export interface LockOwner {
  readonly host: string;
  readonly pid: number;
  readonly released?: boolean;
  readonly root: string;
  readonly start: string;
  readonly token: string;
}

/** Who holds a refused Root: its live owner, or a surviving native process the named owner started. */
export type RootHolder = 'owner' | 'native-tail';

export class RootLockedError extends Error {
  readonly holder: RootHolder;
  readonly owner: LockOwner;

  constructor(owner: LockOwner, holder: RootHolder = 'owner') {
    super(
      holder === 'owner'
        ? `data root is in use by pid ${owner.pid} on ${owner.host} (started ${owner.start})`
        : `data root is still held by a native process that pid ${owner.pid} on ${owner.host} (started ${owner.start}) started`
    );
    this.name = 'RootLockedError';
    this.holder = holder;
    this.owner = owner;
  }
}

/** The opener declined (or was not asked) to take over a lock it cannot judge. Opening again asks again. */
export class ForeignLockError extends Error {
  readonly owner: LockOwner;

  constructor(owner: LockOwner) {
    super(
      `data root is locked by ${owner.host} pid ${owner.pid} for ${owner.root}; it cannot be checked from here. Foreign host locks cannot be taken over; a copied same-host root requires explicit confirmation.`
    );
    this.name = 'ForeignLockError';
    this.owner = owner;
  }
}

let ownStart: string | null | undefined;

/** OS start time of a live pid, or null if no such process. Same formatter for owner and checker. */
export function processStartTime(pid: number): string | null {
  if (pid === process.pid && ownStart !== undefined) {
    return ownStart; // a process's own start time never changes
  }
  const start =
    process.platform === 'win32'
      ? windowsStartTime(pid)
      : process.platform === 'linux'
        ? linuxStartTime(pid)
        : posixStartTime(pid);
  if (pid === process.pid) {
    ownStart = start;
  }
  return start;
}

/** `ps` in the C locale and UTC, so the same start time always formats the same way. */
function psEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['LC_ALL'] = 'C';
  env['TZ'] = 'UTC';
  return env;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
/** Linux reports /proc times in USER_HZ, which is 100 on every architecture (`man 5 proc`). */
const LINUX_USER_HZ = 100;

/**
 * The `ps -o stat=,lstart=` reading of {@link posixStartTime}, without starting `ps`: procps
 * computes `lstart` as the boot time (`btime` in /proc/stat, read fresh as procps reads it) plus
 * the process's start in clock ticks (field 22 of /proc/<pid>/stat), printed as `ctime` in UTC.
 * Every host process records and checks its native children this way, so a `ps` per spawn kept
 * the host's event loop blocked for each git command on a slow machine.
 */
function linuxStartTime(pid: number): string | null {
  // Read first: without /proc the identity source is unavailable, which never implies a stale owner.
  const bootTime = Number(/^btime (\d+)$/mu.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (e) {
    if (e !== null && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      return null; // /proc is readable, and it has no such process
    }
    throw e;
  }
  // `comm` (field 2) is parenthesized and may hold spaces or parentheses; fields 3+ follow the last ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // A zombie has exited and holds nothing (BST-2106), as in posixStartTime.
  if (fields[0] === 'Z') {
    return null;
  }
  const startTicks = Number(fields[19]);
  if (!(Number.isSafeInteger(startTicks) && Number.isSafeInteger(bootTime))) {
    throw new Error(`Unreadable start time in /proc for pid ${pid}`);
  }
  const started = new Date((bootTime + Math.floor(startTicks / LINUX_USER_HZ)) * 1000);
  const two = (value: number): string => String(value).padStart(2, '0');
  return [
    WEEKDAYS[started.getUTCDay()],
    MONTHS[started.getUTCMonth()],
    String(started.getUTCDate()).padStart(2, ' '),
    `${two(started.getUTCHours())}:${two(started.getUTCMinutes())}:${two(started.getUTCSeconds())}`,
    started.getUTCFullYear(),
  ].join(' ');
}

function posixStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: psEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const row = /^(\S+)\s+(.+)$/.exec(out);
    if (!row) {
      return null;
    }
    // A zombie has exited and holds nothing; only its parent's reap is pending,
    // which Electron does asynchronously for a utility process (BST-2106).
    // The start text is the same `lstart` column as before, so recorded starts still match.
    return row[1]?.startsWith('Z') ? null : (row[2] ?? null);
  } catch (e) {
    if (e !== null && typeof e === 'object' && 'status' in e && e.status === 1) {
      return null; // ps exits 1 when the pid does not exist
    }
    throw e; // an unavailable OS identity source never implies a stale owner
  }
}

type ProcessIdentityAddon = Pick<
  typeof import('@brainstrike/windows-job-native'),
  'getProcessCreationTime' | 'waitForProcessExit'
>;
let processIdentityAddon: ProcessIdentityAddon | undefined;

function windowsProcessIdentity(): ProcessIdentityAddon {
  processIdentityAddon ??= createRequire(import.meta.url)(
    '@brainstrike/windows-job-native'
  ) as ProcessIdentityAddon;
  return processIdentityAddon;
}

/** How often POSIX re-reads the identity of a process this process cannot wait for. */
const POSIX_EXIT_POLL_MS = 25;

/**
 * Settles once the process `pid` that started at `start` (from {@link processStartTime}) has
 * exited (ADR-0030). Windows waits on the process's own handle, which the OS signals at its exit.
 * On POSIX only a parent can wait for its child, and Electron reaps its utilities itself, so the
 * identity is re-read until it is gone (an exited zombie has none).
 */
export async function joinProcessExit(pid: number, start: string): Promise<void> {
  if (process.platform === 'win32') {
    await windowsProcessIdentity().waitForProcessExit(pid, start);
    return;
  }
  while (processStartTime(pid) === start) {
    await new Promise((resolve) => setTimeout(resolve, POSIX_EXIT_POLL_MS));
  }
}

/**
 * Keep the same lossless FILETIME previously returned by .NET Process.StartTime.
 * Only a missing/exited process means null; access and identity-source failures
 * throw. Native handle queries avoid blocking every contender on PowerShell.
 */
function windowsStartTime(pid: number): string | null {
  return windowsProcessIdentity().getProcessCreationTime(pid);
}

/** kill(pid, 0): ESRCH = gone; EPERM = exists (another user's process). */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    throw e;
  }
}

type FlockAddon = Pick<typeof import('@brainstrike/secure-fs-native'), 'tryExclusiveFlock'>;
let flockAddon: FlockAddon | undefined;
/** Loaded on first use, so processes that only read records or start times never load the native addon. */
function tryExclusiveFlock(fd: number): boolean {
  flockAddon ??= createRequire(import.meta.url)('@brainstrike/secure-fs-native') as FlockAddon;
  return flockAddon.tryExclusiveFlock(fd);
}

const FLOCK_FILE = 'root.flock';

/**
 * POSIX: open the Root's flock file and take its exclusive lock; null when another open file description (a live
 * owner, or a native process an earlier owner started) holds it. Windows: undefined, there is no inheritable lock.
 */
function holdRootFlock(dir: string): number | null | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  const fd = openSync(join(dir, FLOCK_FILE), constants.O_RDWR | constants.O_CREAT, 0o600);
  let held: boolean;
  try {
    held = tryExclusiveFlock(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (held) {
    return fd;
  }
  closeSync(fd);
  return null;
}

const GEN = /^g(\d{12})$/;
const genName = (g: number): string => `g${String(g).padStart(12, '0')}`;
const generations = (dir: string): number[] =>
  readdirSync(dir)
    .flatMap((n) => {
      const m = GEN.exec(n);
      return m ? [Number(m[1])] : [];
    })
    .sort((a, b) => a - b);

function readOwner(path: string): LockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw e;
  }
  // Only ever created complete (link of an fsynced temp): a parse error is real corruption.
  const o = JSON.parse(raw) as LockOwner;
  if (
    typeof o.pid !== 'number' ||
    !Number.isSafeInteger(o.pid) ||
    o.pid <= 0 ||
    typeof o.start !== 'string' ||
    typeof o.host !== 'string' ||
    typeof o.root !== 'string' ||
    typeof o.token !== 'string'
  ) {
    throw new Error(`lock: malformed ${path}`);
  }
  return o;
}

const unlinkIfExists = (p: string): void => {
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }
};

export interface LockOptions {
  /** Identity of this machine. Defaults to os.hostname(); tests inject a fake one. */
  readonly host?: string;
  /** Asked only for a same-host lock copied from another root. Foreign host locks are always refused. */
  readonly onForeignLock?: (owner: LockOwner) => boolean | Promise<boolean>;
  readonly onStaleBroken?: (owner: LockOwner) => void;
  /** The host's Root: every native process this process starts through `spawnNativeChild` inherits its flock. */
  readonly shareWithNativeChildren?: boolean;
}

/**
 * Judge a held (not released) lock: return it when it may be taken over (stale: a dead or reused pid; or a foreign lock
 * from a copied same-host root whose takeover was confirmed), throw when it is live or the takeover was declined.
 */
async function judgeHeld(
  cur: LockOwner,
  host: string,
  realRoot: string,
  opts: LockOptions
): Promise<LockOwner> {
  if (cur.host !== host) {
    throw new ForeignLockError(cur);
  }
  const judgeable = cur.root === realRoot;
  if (!judgeable) {
    const ok = await opts.onForeignLock?.(cur);
    if (ok !== true) {
      throw new ForeignLockError(cur);
    }
    return cur;
  }
  // A pid that still answers signals but has no start time exited: it is a zombie
  // awaiting its parent's reap, or it exited between the two reads (BST-2106). An
  // unavailable identity source throws from `processStartTime`, never null. The
  // Root's flock still refuses while any inheriting native process survives.
  if (pidExists(cur.pid) && processStartTime(cur.pid) === cur.start) {
    throw new RootLockedError(cur);
  }
  return cur;
}

/** Remove a claim's temp. One a reader still holds without delete sharing (EBUSY on Windows) stays behind. */
function removeTemp(tmp: string): void {
  try {
    unlinkSync(tmp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EBUSY') {
      throw e;
    }
  }
}

/** Create generation `next` as a link of a complete, fsynced temp file: false when another process holds it (EEXIST). */
function linkGeneration(dir: string, record: LockOwner, next: number): boolean {
  const tmp = join(dir, `.${record.token}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx');
  try {
    try {
      writeSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, join(dir, genName(next)));
  } catch (e) {
    removeTemp(tmp);
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw e;
    }
    return false;
  }
  // Once linked, the generation stands: its temp is only scaffolding.
  removeTemp(tmp);
  return true;
}

/**
 * Take generation `next`: false when another process holds it (re-list: it is live, or itself stale) or when a newer
 * generation appeared meanwhile (we raced on an old listing: our own file is dropped, a winner may already have deleted
 * it). The older generations stay until the Root's flock is held (`dropOlderGenerations`).
 */
function claimGeneration(dir: string, me: LockOwner, next: number): boolean {
  if (!linkGeneration(dir, me, next)) {
    return false;
  }
  if (generations(dir).some((g) => g > next)) {
    unlinkIfExists(join(dir, genName(next)));
    return false;
  }
  return true;
}

/**
 * Remove the generations below `next`. Only the newest is ever read, so an older one that a reader still holds without
 * delete sharing (EBUSY on Windows, as an antivirus scan does) stays inert until a later acquisition removes it.
 */
function dropOlderGenerations(dir: string, next: number, gens: readonly number[]): void {
  for (const g of gens) {
    if (g >= next) {
      continue;
    }
    try {
      unlinkSync(join(dir, genName(g)));
    } catch (e) {
      const { code } = e as NodeJS.ErrnoException;
      if (code !== 'ENOENT' && code !== 'EBUSY') {
        throw e;
      }
    }
  }
}

// A production host process holds one; a test process may run several in-process hosts, and `spawnNativeChild`
// refuses to guess between held leases. Released leases stay until the next shared acquisition, so a late spawn after
// the Root was released is refused rather than started outside it.
const sharedLeases = new Set<RootLock>();

/** The Root leases this process's native children inherit (`LockOptions.shareWithNativeChildren`). */
export function sharedRootLeases(): readonly RootLock[] {
  return [...sharedLeases];
}

function shareLease(lock: RootLock): void {
  for (const shared of sharedLeases) {
    if (shared.isReleased) {
      sharedLeases.delete(shared);
    }
  }
  sharedLeases.add(lock);
}

/**
 * After claiming generation `next`, take the Root's flock. When a native process an earlier owner started still holds
 * it, withdraw the claim so the earlier record (`previous`) stays newest and names who started that process.
 */
function holdClaimedRoot(
  dir: string,
  next: number,
  previous: LockOwner | null
): number | undefined {
  let flock: number | null | undefined;
  try {
    flock = holdRootFlock(dir);
  } catch (error) {
    unlinkIfExists(join(dir, genName(next)));
    throw error;
  }
  if (flock !== null) {
    return flock;
  }
  unlinkIfExists(join(dir, genName(next)));
  if (previous === null) {
    throw new Error(`lock: ${dir} is flocked by a process without a lock record`);
  }
  throw new RootLockedError(previous, 'native-tail');
}

export class RootLock {
  readonly dir: string;
  readonly gen: number;
  readonly owner: LockOwner;
  private released = false;
  #flock: number | undefined;

  private constructor(dir: string, gen: number, owner: LockOwner, flock: number | undefined) {
    this.dir = dir;
    this.gen = gen;
    this.owner = owner;
    this.#flock = flock;
  }

  /**
   * POSIX, while held: the descriptor whose flock a native child inherits as an extra stdio slot. Undefined on Windows
   * and after release.
   */
  get inheritableFd(): number | undefined {
    return this.released ? undefined : this.#flock;
  }

  /**
   * POSIX: whether any process still holds this Root's flock. Main asks after its host has exited and the native
   * process groups it registered were signalled; a held flock means a native process survives and the Root stays
   * refused. Windows has no flock (its host's Job Object ends the native processes), so asking there throws.
   */
  static isFlockHeld(root: string): boolean {
    if (process.platform === 'win32') {
      throw new Error('lock: the Root flock is POSIX-only');
    }
    let fd: number;
    try {
      fd = openSync(join(RootLock.dirOf(root), FLOCK_FILE), constants.O_RDWR);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw e;
    }
    try {
      return !tryExclusiveFlock(fd);
    } finally {
      closeSync(fd);
    }
  }

  static dirOf(root: string): string {
    return join(root, 'lock');
  }

  /** The current (newest) generation and its owner, or null if never locked. */
  static inspect(root: string): { gen: number; owner: LockOwner } | null {
    let gens: number[];
    try {
      gens = generations(RootLock.dirOf(root));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw e;
    }
    const g = gens.at(-1);
    if (g === undefined) {
      return null;
    }
    const owner = readOwner(join(RootLock.dirOf(root), genName(g)));
    return owner ? { gen: g, owner } : null;
  }

  static async acquire(root: string, opts: LockOptions = {}): Promise<RootLock> {
    const realRoot = canonicalRoot(root);
    const host = opts.host ?? hostname();
    const dir = RootLock.dirOf(realRoot);
    mkdirSync(dir, { recursive: true });
    const start = processStartTime(process.pid);
    if (start === null) {
      throw new Error('lock: cannot read own process start time');
    }
    const me: LockOwner = {
      host,
      pid: process.pid,
      root: realRoot,
      start,
      token: randomBytes(12).toString('hex'),
    };
    for (let attempt = 0; attempt < 100; attempt++) {
      const gens = generations(dir);
      const top = gens.at(-1);
      let next = 0;
      let cur: LockOwner | null = null;
      let broken: LockOwner | null = null;
      if (top !== undefined) {
        cur = readOwner(join(dir, genName(top)));
        if (cur === null) {
          continue; // dropped by a racing loser between list and read: re-list
        }
        if (!cur.released) {
          broken = await judgeHeld(cur, host, realRoot, opts);
        }
        next = top + 1;
      }
      if (!claimGeneration(dir, me, next)) {
        continue;
      }
      const flock = holdClaimedRoot(dir, next, cur);
      dropOlderGenerations(dir, next, gens);
      if (broken) {
        opts.onStaleBroken?.(broken);
      }
      const lock = new RootLock(dir, next, me, flock);
      if (opts.shareWithNativeChildren) {
        shareLease(lock);
      }
      return lock;
    }
    throw new Error(`lock: could not acquire ${dir} after 100 attempts`);
  }

  get isReleased(): boolean {
    return this.released;
  }

  private assertReleaseOwner(path: string): void {
    const cur = readOwner(path);
    if (
      !cur ||
      (cur.released !== undefined && cur.released !== false) ||
      cur.token !== this.owner.token ||
      cur.pid !== this.owner.pid ||
      cur.start !== this.owner.start ||
      cur.host !== this.owner.host ||
      cur.root !== this.owner.root
    ) {
      throw new Error(`lock: ${path} is no longer ours at release`);
    }
    if (generations(this.dir).at(-1) !== this.gen) {
      throw new Error(`lock: ${path} was superseded at release`);
    }
  }

  /** The record says released first; the flock frees once every native child that inherited it has exited too. */
  #closeFlock(): void {
    const flock = this.#flock;
    this.#flock = undefined;
    if (flock !== undefined) {
      closeSync(flock);
    }
  }

  /** Release: a new generation holding this owner's record marked released, claimed while our authority holds. */
  release(): void {
    if (this.released) {
      return;
    }
    const path = join(this.dir, genName(this.gen));
    this.assertReleaseOwner(path);
    if (!linkGeneration(this.dir, { ...this.owner, released: true }, this.gen + 1)) {
      throw new Error(`lock: ${path} was superseded at release`);
    }
    this.released = true;
    this.#closeFlock();
  }

  /** Factory reset: release, then remove the lock directory itself. */
  releaseAndRemove(): void {
    this.release();
    rmSync(this.dir, { recursive: true });
  }
}
