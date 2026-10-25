import { Schema } from 'effect';

/** A workspace root Main disconnected: the host releases what it runs there. */
export const HostRootCleanupRequestSchema = Schema.Struct({
  rootId: Schema.String.check(Schema.isMinCodePoints(1)),
});

/** The host reaped and forgot this many command sessions in a disconnected root. */
export const HostCommandSessionDisposeRootResultSchema = Schema.Struct({
  disposed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
