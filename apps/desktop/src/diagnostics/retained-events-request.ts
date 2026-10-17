import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import type { DiagnosticEventsQueryFilter } from '@brainstrike/db';
import { Schema } from 'effect';

const identifier = Schema.String.check(Schema.isMinCodePoints(1));
const instant = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(8_640_000_000_000_000)
);
const query = Schema.Struct({
  fingerprint: Schema.optional(identifier),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(200))
  ),
  runId: Schema.optional(identifier),
  severity: Schema.optional(Schema.Literals(['warn', 'error', 'fatal'])),
  sinceMs: Schema.optional(instant),
  threadId: Schema.optional(identifier),
  untilMs: Schema.optional(instant),
}).check(
  Schema.makeFilter((value) =>
    value.sinceMs === undefined || value.untilMs === undefined || value.sinceMs <= value.untilMs
      ? undefined
      : { issue: 'Diagnostic window is reversed', path: [] }
  )
);
const count = Schema.Struct({ fingerprint: identifier, sinceMs: instant });

export function assertRetainedEventsQuery(input: unknown): DiagnosticEventsQueryFilter {
  const value = wireDecoder(query, { errors: 'all', onExcessProperty: 'error' })(input);
  return {
    ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.severity === undefined ? {} : { severity: value.severity }),
    ...(value.sinceMs === undefined ? {} : { sinceMs: value.sinceMs }),
    ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
    ...(value.untilMs === undefined ? {} : { untilMs: value.untilMs }),
  };
}
export function assertRetainedFingerprintCount(input: unknown): {
  fingerprint: string;
  sinceMs: number;
} {
  return wireDecoder(count, { errors: 'all', onExcessProperty: 'error' })(input);
}

export function assertUnseenDiagnosticsWatermark(input: unknown): number {
  return wireDecoder(instant, { errors: 'all', onExcessProperty: 'error' })(input);
}
