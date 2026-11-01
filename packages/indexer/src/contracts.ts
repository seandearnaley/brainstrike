import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

const nonblank = Schema.String.check(Schema.isPattern(/\S/u));
const positive = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const nonnegative = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const identityStateSchema = Schema.Struct({ storeId: hash });
export type IndexerIdentity = typeof identityStateSchema.Type;
const stateProjectionOptionsSchema = Schema.Struct({
  mode: Schema.Literals(['dev', 'prod']),
  module: nonblank,
});
export type StateProjectionOptions = typeof stateProjectionOptionsSchema.Type;
/** The host state index: its database file, the state root it projects and that root's producer. */
export const optionsSchema = Schema.Struct({
  dbPath: nonblank,
  stateProjection: stateProjectionOptionsSchema,
  stateRoot: nonblank,
});
export type IndexerOptions = typeof optionsSchema.Type;
export const stateThreadsSchema = Schema.Array(nonblank);
/**
 * Events one catch-up request projects. A cold projection of a real 73k-event state
 * log ran at about 11k events/s idle, so a step is ~45 ms, and no request queued
 * behind a catch-up waits for a whole backlog, even under heavy CPU contention.
 * Event payloads are bounded (large content lives in blobs), so a count bounds the work.
 */
export const STATE_CATCH_UP_STEP_EVENTS = 500;
/** One bounded catch-up request: project at most `maxEvents` events of these threads. */
export const stateCatchUpStepSchema = Schema.Struct({
  maxEvents: positive,
  threads: stateThreadsSchema,
});
export const stateEventIdentitySchema = Schema.Struct({ seq: positive, threadId: nonblank });
export const stateGcSchema = Schema.Struct({
  hashes: Schema.Array(hash),
  threads: stateThreadsSchema,
});
export const stateMatchSchema = Schema.Struct({ query: nonblank, threadId: nonblank });
/** Gap 10: one committed event's searchable conversation text, as its producer projects it. */
export const stateSearchRowSchema = Schema.NullOr(
  Schema.Struct({
    role: Schema.Literals(['user', 'assistant']),
    runId: nonblank,
    text: nonblank,
  })
);
export type StateSearchRow = typeof stateSearchRowSchema.Type;
export const stateSearchSchema = Schema.Struct({
  limit: positive.check(Schema.isLessThanOrEqualTo(100)),
  /** BST-1939: every query word (the default) or any one of them. */
  match: Schema.optional(Schema.Literals(['all', 'any'])),
  query: nonblank,
  threadIds: Schema.Array(nonblank),
});
export type StateSearch = typeof stateSearchSchema.Type;
export const stateSearchHitSchema = Schema.Struct({
  /** FTS5 bm25: lower is a better match. */
  rank: Schema.Finite,
  role: Schema.Literals(['user', 'assistant']),
  runId: nonblank,
  seq: positive,
  /** The matched text with each match wrapped in `<mark>`. */
  snippet: Schema.String,
  threadId: nonblank,
});
export type StateSearchHit = typeof stateSearchHitSchema.Type;
export const stateHealthSchema = Schema.Struct({ indexerErrors: Schema.Array(Schema.String) });
export const stateCountsSchema = Schema.Record(Schema.String, nonnegative);
export const stateStatsSchema = Schema.Struct({
  cursor: nonnegative,
  docs: nonnegative,
  gaps: Schema.Array(Schema.Struct({ from: positive, reason: Schema.String, to: positive })),
});
export type StateProjectionStats = typeof stateStatsSchema.Type;
export const infoSchema = Schema.Struct({
  ...identityStateSchema.fields,
  dbPath: nonblank,
  journalMode: Schema.String,
  pid: positive,
  writerThreadId: positive,
});
export type IndexerInfo = typeof infoSchema.Type;
export const faultSchema = Schema.Struct({ code: nonblank, message: Schema.String });
export const requestSchema = Schema.Struct({ id: positive, op: nonblank, payload: Schema.Unknown });
export const frameSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('ready'), value: Schema.Unknown }),
  Schema.Struct({ error: faultSchema, kind: Schema.Literal('startup-error') }),
  Schema.Struct({
    id: positive,
    kind: Schema.Literal('response'),
    ok: Schema.Literal(true),
    value: Schema.Unknown,
  }),
  Schema.Struct({
    error: faultSchema,
    id: positive,
    kind: Schema.Literal('response'),
    ok: Schema.Literal(false),
  }),
]);
export function decoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): (input: unknown) => S['Type'] {
  return makeThrowingDecoder(schema, { onExcessProperty: 'error' });
}
export class IndexerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'IndexerError';
  }
}
export function fault(error: unknown): typeof faultSchema.Type {
  return {
    code:
      error instanceof IndexerError
        ? error.code
        : error instanceof TypeError
          ? 'invalid-input'
          : 'indexer-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}
