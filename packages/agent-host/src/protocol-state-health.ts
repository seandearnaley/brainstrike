import { Schema } from 'effect';

/**
 * `state/health/read` (BST-1880): the state store's damage, when it opened the
 * state DB read-only, and how many records it could not read; never their contents.
 */
export const HostStateHealthSchema = Schema.Struct({
  stateDamage: Schema.NullOr(Schema.String),
  unreadableRecords: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type HostStateHealth = (typeof HostStateHealthSchema)['Type'];
