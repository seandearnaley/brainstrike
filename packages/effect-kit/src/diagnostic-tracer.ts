import { Cause, Exit, Option, Tracer } from 'effect';

export interface DiagnosticSpanEvent {
  readonly attributes: Readonly<Record<string, string>>;
  readonly cause?: Cause.Cause<unknown>;
  readonly durationMs?: number;
  readonly event?: string;
  readonly operation: string;
  readonly outcome?: 'success' | 'failure' | 'defect' | 'interruption';
  readonly parentSpanId?: string;
  readonly phase: 'start' | 'event' | 'end';
  readonly spanId: string;
  readonly traceId: string;
}

/** A bounded observation of native Effect spans, with no exporter or persistence owner. */
export function createDiagnosticTracer(options: {
  readonly operations: ReadonlySet<string>;
  readonly events: ReadonlySet<string>;
  readonly attributes: ReadonlyMap<string, ReadonlySet<string>>;
  readonly record: (event: DiagnosticSpanEvent) => void;
}): Tracer.Tracer {
  return Tracer.make({
    span: (input) => {
      const span = new Tracer.NativeSpan(input);
      if (!options.operations.has(span.name)) {
        return span;
      }
      const identity = {
        operation: span.name,
        spanId: span.spanId,
        traceId: span.traceId,
        ...(Option.isSome(span.parent) ? { parentSpanId: span.parent.value.spanId } : {}),
      };
      const attributes = (): Readonly<Record<string, string>> =>
        Object.fromEntries(
          [...span.attributes].filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' &&
              options.attributes.get(entry[0])?.has(entry[1]) === true
          )
        );
      options.record({ ...identity, attributes: {}, phase: 'start' });
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        if (span.status._tag === 'Ended') {
          return;
        }
        end(endTime, exit);
        const outcome = Exit.isSuccess(exit)
          ? 'success'
          : Cause.hasDies(exit.cause)
            ? 'defect'
            : Cause.hasFails(exit.cause)
              ? 'failure'
              : 'interruption';
        options.record({
          ...identity,
          attributes: attributes(),
          durationMs: Number(endTime - input.startTime) / 1_000_000,
          outcome,
          phase: 'end',
          ...(Exit.isFailure(exit) ? { cause: exit.cause } : {}),
        });
      };
      // Logger.tracerLogger reaches this public Span method. Unlisted messages
      // and all of their free-form annotations stay out of the diagnostic event.
      span.event = (name) => {
        if (span.status._tag === 'Ended' || !options.events.has(name)) {
          return;
        }
        options.record({ ...identity, attributes: attributes(), event: name, phase: 'event' });
      };
      return span;
    },
  });
}
