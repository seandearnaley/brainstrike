import { randomUUID } from 'node:crypto';
import type { BoundaryFailure } from '@brainstrike/assistant-contract';

const ids = new WeakMap<object, string>();

/**
 * One failure, one reference (BST-2202): every boundary that reports the same
 * failure object (a memory step, the run's attempt outcome and its owner's
 * joined failure) names the same correlation id, so its cause is one lookup.
 */
export function correlationIdFor(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) {
    return randomUUID();
  }
  const known = ids.get(cause);
  if (known !== undefined) {
    return known;
  }
  const id = randomUUID();
  ids.set(cause, id);
  return id;
}

/** A fault names the correlation id its cause is logged under; a refusal needs none. */
export function correlatedFailure(failure: BoundaryFailure, cause: unknown): BoundaryFailure {
  return failure.kind === 'fault' && failure.correlationId === undefined
    ? { ...failure, correlationId: correlationIdFor(cause) }
    : failure;
}
