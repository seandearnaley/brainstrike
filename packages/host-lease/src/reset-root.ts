import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RootLock } from '@brainstrike/state-store';

export interface ProfileResetLease {
  clearRootContents(): Promise<void>;
  readonly isReleased: boolean;
  release(): void;
  readonly root: string;
}

/**
 * Own the existing profile lock throughout the entire destructive reset phase.
 * The caller first joins every profile writer, then retains this guard through
 * profile clearing and all later userData/storage purge. Never remove its lock
 * path or ancestors. Errors retain this accessible guard for retry or policy.
 */
export async function acquireProfileResetLease(root: string): Promise<ProfileResetLease> {
  const lock = await RootLock.acquire(root);
  const canonicalRoot = lock.owner.root;
  const lockEntry = basename(RootLock.dirOf(canonicalRoot));
  let clearing: Promise<void> | undefined;
  const assertOwned = (): void => {
    if (lock.isReleased) {
      throw new Error('Profile reset lease is released');
    }
    const current = RootLock.inspect(canonicalRoot)?.owner;
    if (!current || current.token !== lock.owner.token || current.released) {
      throw new Error('Profile reset lock namespace is no longer owned');
    }
  };
  const clear = async (): Promise<void> => {
    assertOwned();
    const entries = await readdir(canonicalRoot);
    for (const entry of entries) {
      if (entry === lockEntry) {
        continue;
      }
      await rm(join(canonicalRoot, entry), { force: true, recursive: true });
    }
    assertOwned();
  };
  return {
    clearRootContents(): Promise<void> {
      if (lock.isReleased) {
        return Promise.reject(new Error('Profile reset lease is released'));
      }
      clearing ??= clear().finally(() => {
        clearing = undefined;
      });
      return clearing;
    },
    get isReleased(): boolean {
      return lock.isReleased;
    },
    release(): void {
      if (clearing) {
        throw new Error('Cannot release profile reset lease while clearing');
      }
      if (lock.isReleased) {
        return;
      }
      assertOwned();
      // Retain the namespace: deleting it would let a contender bypass ownership.
      lock.release();
    },
    root: canonicalRoot,
  };
}
