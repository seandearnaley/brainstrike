// Data-root lock (M0-A2 src/lock.ts, adapted from spike s-dur D5), with the Windows process start time from M0-A1
// src/dir-lock.ts:32-59.
//
// Generation files `g<12 digits>` are created with link(fsynced temp), which fails with EEXIST, so exactly one of N
// contenders wins a generation; a winner re-lists and drops its own file if a newer generation exists. Nobody ever
// renames or unlinks someone else's live lock.
//
// The lock lives INSIDE the root (`<root>/lock/`), so any file-level copy of a root (Time Machine, Migration Assistant,
// `cp -R`, the export bundle) carries it, and the owner records the root's realpath. A lock from another host is refused unconditionally. A same-host lock copied from another root cannot be judged
// by pid: the opener confirms the copied-root takeover explicitly.
//
// Owner identity = { pid, start, host, root, token }. `start` is the OS-reported start time of `pid`, read the SAME way
// for the owner (at acquisition) and for a checker, so the comparison is exact and defeats pid reuse:
//   darwin/linux: `ps -o lstart= -p <pid>` with LC_ALL=C TZ=UTC (1 s resolution);
//   win32: the creation time from GetProcessTimes, read through PowerShell's .NET Process.StartTime (100 ns FILETIME).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export interface LockOwner {
  readonly host: string;
  readonly pid: number;
  readonly released?: boolean;
  readonly root: string;
  readonly start: string;
  readonly token: string;
}

export class RootLockedError extends Error {
  readonly owner: LockOwner;

  constructor(owner: LockOwner) {
    super(`data root is in use by pid ${owner.pid} on ${owner.host} (started ${owner.start})`);
    this.name = 'RootLockedError';
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
  const start = process.platform === 'win32' ? windowsStartTime(pid) : posixStartTime(pid);
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

function posixStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: psEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch (e) {
    if (e !== null && typeof e === 'object' && 'status' in e && e.status === 1) {
      return null; // ps exits 1 when the pid does not exist
    }
    throw e; // an unavailable OS identity source never implies a stale owner
  }
}

/**
 * The process creation time from GetProcessTimes, via .NET Process.StartTime (which calls it), as a UTC FILETIME
 * (100 ns ticks). Only "no such process" (GetProcessById's ArgumentException) means null; anything else (e.g. access
 * denied) throws: guessing "gone" would let a live owner's lock be taken over.
 */
export const WIN_START_PS = (pid: number): string =>
  `$ErrorActionPreference='Stop'; try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}) } catch [System.ArgumentException] { 'NOPROC'; exit 0 }; 'START ' + $p.StartTime.ToFileTimeUtc()`;

function windowsStartTime(pid: number): string | null {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WIN_START_PS(pid)],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  ).trim();
  if (out === 'NOPROC') {
    return null;
  }
  const m = /^START (\d+)$/.exec(out);
  if (!m?.[1]) {
    throw new Error(
      `lock: unexpected PowerShell start-time output for pid ${pid}: ${JSON.stringify(out)}`
    );
  }
  return m[1];
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

function writeTemp(dir: string, o: LockOwner): string {
  const tmp = join(dir, `.${o.token}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, JSON.stringify(o));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
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
  if (pidExists(cur.pid)) {
    const observed = processStartTime(cur.pid);
    if (observed === null) {
      throw new Error(`lock: cannot verify process start time for live pid ${cur.pid}`);
    }
    if (observed === cur.start) {
      throw new RootLockedError(cur);
    }
  }
  return cur;
}

/** Create generation `next` as a link of a complete, fsynced temp file: false when another process holds it (EEXIST). */
function linkGeneration(dir: string, me: LockOwner, next: number): boolean {
  const tmp = writeTemp(dir, me);
  try {
    linkSync(tmp, join(dir, genName(next)));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw e;
    }
    return false;
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * Take generation `next`: false when another process holds it (re-list: it is live, or itself stale) or when a newer
 * generation appeared meanwhile (we raced on an old listing: our own file is dropped, a winner may already have deleted
 * it). On success, the older generations listed in `gens` are removed.
 */
function claimGeneration(
  dir: string,
  me: LockOwner,
  next: number,
  gens: readonly number[]
): boolean {
  if (!linkGeneration(dir, me, next)) {
    return false;
  }
  if (generations(dir).some((g) => g > next)) {
    unlinkIfExists(join(dir, genName(next)));
    return false;
  }
  for (const g of gens) {
    if (g < next) {
      unlinkIfExists(join(dir, genName(g)));
    }
  }
  return true;
}

export class RootLock {
  readonly dir: string;
  readonly gen: number;
  readonly owner: LockOwner;
  private released = false;

  private constructor(dir: string, gen: number, owner: LockOwner) {
    this.dir = dir;
    this.gen = gen;
    this.owner = owner;
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
    const realRoot = realpathSync(root);
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
      let broken: LockOwner | null = null;
      if (top !== undefined) {
        const cur = readOwner(join(dir, genName(top)));
        if (cur === null) {
          continue; // dropped by a racing loser between list and read: re-list
        }
        if (!cur.released) {
          broken = await judgeHeld(cur, host, realRoot, opts);
        }
        next = top + 1;
      }
      if (!claimGeneration(dir, me, next, gens)) {
        continue;
      }
      if (broken) {
        opts.onStaleBroken?.(broken);
      }
      return new RootLock(dir, next, me);
    }
    throw new Error(`lock: could not acquire ${dir} after 100 attempts`);
  }

  get isReleased(): boolean {
    return this.released;
  }

  /** Mark our generation released (atomic replace of our own file). Throws if it is no longer ours. */
  release(): void {
    if (this.released) {
      return;
    }
    const path = join(this.dir, genName(this.gen));
    const cur = readOwner(path);
    if (!cur || cur.token !== this.owner.token) {
      throw new Error(`lock: ${path} is no longer ours at release`);
    }
    renameSync(writeTemp(this.dir, { ...this.owner, released: true }), path);
    this.released = true;
  }

  /** Factory reset: release, then remove the lock directory itself. */
  releaseAndRemove(): void {
    this.release();
    rmSync(this.dir, { recursive: true });
  }
}
