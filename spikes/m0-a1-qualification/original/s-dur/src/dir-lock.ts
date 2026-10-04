// D5: exclusive data-directory lock for the run log's PGlite dir. PGlite 0.5.8 has none (electric-sql/pglite#1106):
// two processes on one NODEFS dir corrupt it. Lock state lives NEXT TO the data dir (never inside PGDATA), in
// `<dataDir>.lock/`, as generation files `g<NNNNNNNNNNNN>` (zero-padded, so name order = generation order).
//
// Owner identity = { pid, start, host, token }. `start` is the OS-reported start time of `pid`, read the SAME way for the
// owner (at acquisition) and for a checker (at contention), so the comparison is exact and defeats PID reuse:
//   darwin/linux: `ps -o lstart= -p <pid>` with LC_ALL=C TZ=UTC (1 s resolution). Windows: not implemented (throws).
// The newest generation is the lock. It is FREE when released (owner rewrote it `released:true`) or STALE when its pid is
// gone (kill(pid,0) -> ESRCH) or alive with a different start time (reused pid). A lock from another host is never stale.
//
// Why generations (no rename/unlink of someone else's lock, ever): taking over generation g means creating g+1 with
// link(fully-written-and-fsynced temp, g+1), which is atomic and fails with EEXIST if it exists: of N processes that
// all judged g stale, exactly one creates g+1; the others re-read and find a live g+1. A winner then re-lists: if a
// generation newer than its own exists (it raced on an older listing) it deletes its OWN file and starts over. Only
// then are older generations deleted (always stale/released or a racing loser's own about-to-be-dropped file).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export interface LockOwner { pid: number; start: string; host: string; token: string; released?: boolean }

export class DataDirLockedError extends Error {
  constructor(readonly lockDir: string, readonly owner: LockOwner) {
    super(`data directory is locked by pid ${owner.pid} on ${owner.host} (started ${owner.start}); lock ${lockDir}`);
    this.name = 'DataDirLockedError';
  }
}

/** OS start time of a live pid, or null if no such process. Same formatter for owner and checker. */
export function processStartTime(pid: number): string | null {
  if (process.platform === 'win32') throw new Error('dir-lock: process start time is not implemented on Windows (see report D5 cross-platform note)');
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // ps exits 1 when the pid does not exist
  }
}

/** kill(pid, 0): ESRCH = gone; EPERM = exists (another user's process). */
function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function ownerIsAlive(o: LockOwner): boolean {
  if (o.host !== hostname()) return true; // cannot judge a foreign host's pid: refuse, never take over
  if (!pidExists(o.pid)) return false;
  const start = processStartTime(o.pid);
  return start !== null && start === o.start; // alive pid with another start time = reused pid = stale
}

const GEN = /^g(\d{12})$/;
const genName = (g: number) => `g${String(g).padStart(12, '0')}`;
function generations(dir: string): number[] {
  return readdirSync(dir).flatMap((n) => { const m = GEN.exec(n); return m ? [Number(m[1])] : []; }).sort((a, b) => a - b);
}
function readOwner(path: string): LockOwner | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const o = JSON.parse(raw) as LockOwner; // only ever created complete (link of an fsynced temp): a parse error is real corruption
  if (typeof o.pid !== 'number' || typeof o.start !== 'string' || typeof o.host !== 'string' || typeof o.token !== 'string') throw new Error(`dir-lock: malformed lock file ${path}: ${raw}`);
  return o;
}
function writeTemp(dir: string, o: LockOwner): string {
  const tmp = join(dir, `.${o.token}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx');
  try { writeSync(fd, JSON.stringify(o)); fsyncSync(fd); } finally { closeSync(fd); }
  return tmp;
}
const unlinkIfExists = (p: string) => { try { unlinkSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } };

export interface DirLockEvents { brokeStale?: (stale: LockOwner) => void }

export class DirLock {
  private released = false;
  private constructor(readonly dir: string, readonly gen: number, readonly owner: LockOwner) {}

  static lockDirOf(dataDir: string) { return `${dataDir.replace(/\/+$/, '')}.lock`; }

  /** The current (newest) generation and its owner, or null if never locked. */
  static inspect(dataDir: string): { gen: number; owner: LockOwner } | null {
    const dir = DirLock.lockDirOf(dataDir);
    let gens: number[];
    try { gens = generations(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    const g = gens.at(-1);
    if (g === undefined) return null;
    const owner = readOwner(join(dir, genName(g)));
    return owner ? { gen: g, owner } : null;
  }

  static acquire(dataDir: string, ev: DirLockEvents = {}): DirLock {
    const dir = DirLock.lockDirOf(dataDir);
    mkdirSync(dir, { recursive: true });
    const start = processStartTime(process.pid);
    if (start === null) throw new Error('dir-lock: cannot read own process start time');
    const me: LockOwner = { pid: process.pid, start, host: hostname(), token: randomBytes(12).toString('hex') };
    for (let attempt = 0; attempt < 100; attempt++) {
      const gens = generations(dir);
      const top = gens.at(-1);
      let next = 0;
      let stale: LockOwner | null = null;
      if (top !== undefined) {
        const cur = readOwner(join(dir, genName(top)));
        if (cur === null) continue; // dropped by a racing loser between list and read: re-list
        if (!cur.released) {
          if (ownerIsAlive(cur)) throw new DataDirLockedError(dir, cur);
          stale = cur;
        }
        next = top + 1;
      }
      const tmp = writeTemp(dir, me);
      let created = false;
      try { linkSync(tmp, join(dir, genName(next))); created = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } finally { unlinkSync(tmp); }
      if (!created) continue; // another process took generation `next`: re-list (it is live, or itself stale)
      if (generations(dir).some((g) => g > next)) { unlinkIfExists(join(dir, genName(next))); continue; } // raced on an old listing (a winner may already have deleted it)
      for (const g of gens) if (g < next) unlinkIfExists(join(dir, genName(g)));
      if (stale) ev.brokeStale?.(stale);
      return new DirLock(dir, next, me);
    }
    throw new Error(`dir-lock: could not acquire ${dir} after 100 attempts (persistent contention)`);
  }

  /** Mark our generation released (atomic replace of our own file). Throws if it is no longer ours. */
  release() {
    if (this.released) return;
    this.released = true;
    const path = join(this.dir, genName(this.gen));
    const cur = readOwner(path);
    if (!cur || cur.token !== this.owner.token) throw new Error(`dir-lock: ${path} is no longer ours at release (now ${JSON.stringify(cur)})`);
    renameSync(writeTemp(this.dir, { ...this.owner, released: true }), path);
  }
}
