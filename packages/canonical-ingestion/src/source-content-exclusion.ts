import type { CanonicalSourceExclusion } from './ports.ts';

/** Filesystem content eligibility, never a read, authority, parser or cancellation failure. */
export class CanonicalSourceContentExcludedError extends Error {
  readonly reason: CanonicalSourceExclusion['reason'];

  constructor(reason: CanonicalSourceExclusion['reason'], message: string) {
    super(message);
    this.reason = reason;
    this.name = 'CanonicalSourceContentExcludedError';
  }
}
