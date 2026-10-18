import { ForeignLockError, RootLock, RootLockedError } from '@brainstrike/state-store';
import type { StartupMessage } from './startup-message.js';

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
 * A starter's failure report as the error its launcher acts on. Every host
 * starter (the Node spawner, the desktop's utility process) maps it here, so
 * the launcher sees one vocabulary.
 */
export function startupFailure(
  root: string,
  message: Extract<StartupMessage, { readonly event: 'failed' }>
): Error {
  const lease = RootLock.inspect(root)?.owner;
  if (message.kind === 'root-locked') {
    return lease && !lease.released
      ? new RootLockedError(lease)
      : new RootContentionError(message.message);
  }
  if (message.kind === 'foreign-lock' && lease) {
    return new ForeignLockError(lease);
  }
  return new Error(message.message);
}
