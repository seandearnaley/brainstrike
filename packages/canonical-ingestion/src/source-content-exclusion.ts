import type { CanonicalSourceExclusion } from './ports.js';

/** Filesystem content eligibility, never a read, authority, parser or cancellation failure. */
export class CanonicalSourceContentExcludedError extends Error {
  constructor(
    readonly reason: CanonicalSourceExclusion['reason'],
    message: string
  ) {
    super(message);
    this.name = 'CanonicalSourceContentExcludedError';
  }
}
