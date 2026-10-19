import { randomUUID } from 'node:crypto';

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
