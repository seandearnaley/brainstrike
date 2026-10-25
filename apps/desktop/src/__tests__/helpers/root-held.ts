import { RootLock, RootLockedError } from '@brainstrike/state-store';

/** Whether another process holds `root`'s lock now: a free root is taken and released at once. */
export function isRootHeld(root: string): boolean {
  try {
    RootLock.acquire(root).release();
    return false;
  } catch (cause) {
    if (cause instanceof RootLockedError) {
      return true;
    }
    throw cause;
  }
}
