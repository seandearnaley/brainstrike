import { Schema } from 'effect';

/**
 * `state/health/read` (BST-1880): the state store's damage, when it opened the
 * state DB read-only, and how many conversations the host could not read when
 * it hydrated them; never their contents.
 */
export const HostStateHealthSchema = Schema.Struct({
  damagedThreads: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stateDamage: Schema.NullOr(Schema.String),
});
export type HostStateHealth = (typeof HostStateHealthSchema)['Type'];
