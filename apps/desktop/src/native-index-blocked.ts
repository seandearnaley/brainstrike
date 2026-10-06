/** Trusted activation-owner evidence of a retained failure, never a fresh read failure. */
export class NativeIndexBlockedError extends Error {
  readonly code = 'native-index-blocked';

  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Native indexing is blocked: ${reason} Open Diagnostics for details.`, { cause });
    this.name = 'NativeIndexBlockedError';
  }
}

/** Preserve setup and independent cleanup failures at the trusted retained-failure seam. */
export function retainedNativeIndexFailure(cause: unknown): Error {
  if (cause instanceof AggregateError || cause instanceof NativeIndexSetupRequiredError) {
    return cause;
  }
  return new NativeIndexBlockedError(cause);
}

import { NativeIndexSetupRequiredError } from './native-index-setup-required';
