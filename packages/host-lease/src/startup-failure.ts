import { hostname } from 'node:os';
import {
  ForeignLockError,
  type LockOwner,
  processStartTime,
  RootLock,
  RootLockedError,
} from '@brainstrike/state-store';
import type { StartupMessage } from './startup-message.ts';

type FailedStartup = Extract<StartupMessage, { readonly event: 'failed' }>;

/**
 * A starter refused `root-locked` by an owner that no longer holds the root
 * (BST-2142): the race's winner released it, or exited, before the refusal was
 * read. Nothing is in use any more, so the launcher acquires again within its
 * one deadline; reporting "in use by pid N" would name an owner that is gone.
 */
export class RootContentionError extends Error {
  constructor(refusal: string) {
    super(`The data root was taken by another starter that has since released it: ${refusal}`);
    this.name = 'RootContentionError';
  }
}

/**
 * The `failed` report of a host whose start threw `cause`. Every host entry reports through
 * it, so every starter reads one vocabulary. A refusal by a native process an earlier owner
 * started names that owner (ADR-0017, BST-2477).
 */
export function failedStartupReport(cause: unknown): FailedStartup {
  return {
    event: 'failed',
    kind:
      cause instanceof RootLockedError
        ? 'root-locked'
        : cause instanceof ForeignLockError
          ? 'foreign-lock'
          : 'error',
    message: cause instanceof Error ? cause.message : String(cause),
    ...(cause instanceof RootLockedError && cause.holder === 'native-tail'
      ? {
          nativeTail: {
            host: cause.owner.host,
            pid: cause.owner.pid,
            start: cause.owner.start,
            token: cause.owner.token,
          },
        }
      : {}),
  };
}

/**
 * Whether `owner`'s own process is still running on this machine. An owner releases its
 * record before it closes its flock (`RootLock.release`), so a host that asks in between
 * finds the flock held by an owner that is only leaving.
 */
function ownerStillRunning(owner: LockOwner): boolean {
  return owner.host === hostname() && processStartTime(owner.pid) === owner.start;
}

/**
 * A starter's failure report as the error its launcher acts on. Every host
 * starter (the Node spawner, the desktop's utility process) maps it here, so
 * the launcher sees one vocabulary.
 */
export function startupFailure(root: string, message: FailedStartup): Error {
  const lease = RootLock.inspect(root)?.owner;
  if (message.kind === 'root-locked') {
    // ADR-0017 (BST-2477): a native process the newest owner started still holds the Root.
    // A record naming another owner means the Root changed hands since, so the report no
    // longer describes it. While that owner's own process still runs, it is releasing the
    // Root, not leaving a native process behind: the launch acquires again (below).
    if (lease && message.nativeTail?.token === lease.token && !ownerStillRunning(lease)) {
      return new RootLockedError(lease, 'native-tail');
    }
    return lease && !lease.released
      ? new RootLockedError(lease)
      : new RootContentionError(message.message);
  }
  if (message.kind === 'foreign-lock' && lease) {
    return new ForeignLockError(lease);
  }
  return new Error(message.message);
}
