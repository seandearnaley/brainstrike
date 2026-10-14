import type { DiagnosticEventsQueryFilter } from '@brainstrike/db';
import { z } from 'zod';

const identifier = z.string().min(1);
const instant = z.number().int().nonnegative().max(8_640_000_000_000_000);
const query = z
  .strictObject({
    fingerprint: identifier.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    runId: identifier.optional(),
    severity: z.enum(['warn', 'error', 'fatal']).optional(),
    sinceMs: instant.optional(),
    threadId: identifier.optional(),
    untilMs: instant.optional(),
  })
  .refine(
    (value) =>
      value.sinceMs === undefined || value.untilMs === undefined || value.sinceMs <= value.untilMs,
    'Diagnostic window is reversed'
  );
const count = z.strictObject({ fingerprint: identifier, sinceMs: instant });

export function assertRetainedEventsQuery(input: unknown): DiagnosticEventsQueryFilter {
  const value = query.parse(input);
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
  return count.parse(input);
}

export function assertUnseenDiagnosticsWatermark(input: unknown): number {
  return instant.parse(input);
}
