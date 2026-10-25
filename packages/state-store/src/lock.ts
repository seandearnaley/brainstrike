// Data-root lock (ADR-0031 decision 4): one OS file lock on `<root>/lock/root.lock`, held by the process that opened
// the root's store and by nothing else. The OS drops it when that process exits, however it exits, so there is no
// record to judge, no stale owner to take over and nothing to clean up after a crash. `secure-fs-native` holds it on
// one native handle no child inherits: flock(2) on POSIX, LockFileEx on Windows.
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ExclusiveLock } from '@brainstrike/secure-fs-native';
import { canonicalRoot } from './root-identity.ts';

/** A second opener asked for a data root that is already open. */
export class RootLockedError extends Error {
  readonly root: string;

  constructor(root: string) {
    super(`data root ${root} is in use by another Brainstrike process`);
    this.name = 'RootLockedError';
    this.root = root;
  }
}

type LockAddon = Pick<typeof import('@brainstrike/secure-fs-native'), 'tryExclusiveLock'>;
let lockAddon: LockAddon | undefined;
/** Loaded on first use, so a process that never locks a root never loads the native addon. */
function tryExclusiveLock(path: string): ExclusiveLock | null {
  lockAddon ??= createRequire(import.meta.url)('@brainstrike/secure-fs-native') as LockAddon;
  return lockAddon.tryExclusiveLock(path);
}

const LOCK_FILE = 'root.lock';

export class RootLock {
  readonly dir: string;
  readonly root: string;
  #held: ExclusiveLock | undefined;

  private constructor(root: string, dir: string, held: ExclusiveLock) {
    this.root = root;
    this.dir = dir;
    this.#held = held;
  }

  static dirOf(root: string): string {
    return join(root, 'lock');
  }

  /** Takes the root's lock now, or throws {@link RootLockedError} while another opener holds it. */
  static acquire(root: string): RootLock {
    const realRoot = canonicalRoot(root);
    const dir = RootLock.dirOf(realRoot);
    mkdirSync(dir, { recursive: true });
    const held = tryExclusiveLock(join(dir, LOCK_FILE));
    if (held === null) {
      throw new RootLockedError(realRoot);
    }
    return new RootLock(realRoot, dir, held);
  }

  get isReleased(): boolean {
    return this.#held === undefined;
  }

  /** Closing the handle is the release. */
  release(): void {
    const held = this.#held;
    this.#held = undefined;
    held?.release();
  }

  /** Factory reset: release, then remove the lock directory itself. */
  releaseAndRemove(): void {
    this.release();
    rmSync(this.dir, { force: true, recursive: true });
  }
}
