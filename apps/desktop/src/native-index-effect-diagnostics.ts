import { createDiagnosticTracer, type DiagnosticSpanEvent } from '@brainstrike/effect-kit';
import { createLogger, redactSensitiveLogValue } from '@brainstrike/logging';
import { Cause, Effect, Logger, type Tracer } from 'effect';

const logger = createLogger('NativeIndexWorkflow');
const OPERATIONS = [
  'native-index.configure',
  'native-index.dispatch',
  'native-index.pause',
  'native-index.rebuild',
  'native-index.start',
  'native-index.admission',
  'native-index.execute',
  'native-index.transition',
  'native-index.settings',
  'native-index.action',
] as const;

/** Count independent failures after the existing redactor, without copying error text or stacks. */
function failureSummary(cause: Cause.Cause<unknown>) {
  let truncated = false;
  const redacted = redactSensitiveLogValue(
    cause.reasons.flatMap((reason) =>
      Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : []
    ),
    [],
    new WeakMap(),
    {
      maxDepth: 8,
      onDepthTruncated: () => {
        truncated = true;
      },
    }
  );
  let failures = 0;
  const seen = new Set<object>();
  const visitArray = (value: readonly unknown[], depth: number): void => {
    for (const entry of value.slice(0, 8)) {
      visit(entry, depth + 1);
    }
    if (value.length > 8) {
      truncated = true;
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) {
      truncated = true;
      return;
    }
    if (typeof value !== 'object' || value === null) {
      failures += 1;
      return;
    }
    if (seen.has(value)) {
      truncated = true;
      return;
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        visitArray(value, depth);
        return;
      }
      if ('errors' in value && Array.isArray(value.errors)) {
        visit(value.errors, depth + 1);
        return;
      }
      if ('cause' in value && value.cause !== undefined) {
        visit(value.cause, depth + 1);
        return;
      }
      failures += 1;
    } finally {
      seen.delete(value);
    }
  };
  visit(redacted, 0);
  return {
    defects: cause.reasons.filter(Cause.isDieReason).length,
    expected: cause.reasons.filter(Cause.isFailReason).length,
    failures,
    interruptions: cause.reasons.filter(Cause.isInterruptReason).length,
    truncated,
  };
}
function record(event: DiagnosticSpanEvent): void {
  const { cause, ...safe } = event;
  const metadata = { ...safe, ...(cause ? { error: failureSummary(cause) } : {}) };
  if (event.outcome === 'failure' || event.outcome === 'defect') {
    logger.warn(`Effect ${event.operation} ${event.phase}`, metadata);
    return;
  }
  logger.info(`Effect ${event.operation} ${event.phase}`, metadata);
}
const tracer = createDiagnosticTracer({
  attributes: new Map([
    ['action', new Set(['open', 'close', 'stop-sources', 'apply-sources', 'retire-profile'])],
  ]),
  events: new Set(['native-index.transition']),
  operations: new Set(OPERATIONS),
  record,
});
/** Adds observation only: admission, reducer, cancellation and physical joins keep their owners. */
export function traceNativeIndexWorkflow<A, E>(
  effect: Effect.Effect<A, E>,
  operation: (typeof OPERATIONS)[number],
  parent?: Tracer.AnySpan
) {
  return effect.pipe(
    Effect.withSpan(operation, { parent }),
    Effect.withTracer(tracer),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.tracerLogger]))
  );
}
