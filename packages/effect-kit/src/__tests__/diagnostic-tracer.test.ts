import { Cause, Context, Data, Effect, Exit, Logger, Option, Tracer } from 'effect';
import { expect, it } from 'vitest';
import { createDiagnosticTracer, type DiagnosticSpanEvent } from '../diagnostic-tracer.js';
import { runAtPromiseBoundary } from '../promise-boundary.js';

class ExpectedFailure extends Data.TaggedError('ExpectedFailure')<{ readonly cause: Error }> {}
function recorder() {
  const events: DiagnosticSpanEvent[] = [];
  const tracer = createDiagnosticTracer({
    attributes: new Map([['action', new Set(['open'])]]),
    events: new Set(['checkpoint']),
    operations: new Set(['root', 'child']),
    record: (event) => events.push(event),
  });
  return { events, tracer };
}
it('carries explicit parent context across the sanctioned Promise boundary and filters metadata', async () => {
  const { events, tracer } = recorder();
  await runAtPromiseBoundary(
    Effect.gen(function* () {
      const parentSpan = yield* Effect.currentSpan;
      yield* Effect.promise(() =>
        runAtPromiseBoundary(
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({
              action: 'open',
              password: 'secret',
              path: '/private/file',
              url: 'https://u:p@host/?token=secret',
            });
            yield* Effect.logInfo('checkpoint');
            yield* Effect.logInfo('secret message');
          }).pipe(
            Effect.withSpan('child'),
            Effect.provideService(Logger.CurrentLoggers, new Set([Logger.tracerLogger]))
          ),
          { tracing: { parentSpan, tracer } }
        )
      );
    }).pipe(Effect.withSpan('root')),
    { tracing: { tracer } }
  );
  const root = events.find((e) => e.operation === 'root' && e.phase === 'start');
  const child = events.find((e) => e.operation === 'child' && e.phase === 'end');
  expect(root).toBeDefined();
  expect(child?.parentSpanId).toBe(root?.spanId);
  expect(child?.traceId).toBe(root?.traceId);
  expect(child?.attributes).toEqual({ action: 'open' });
  expect(events.filter((e) => e.phase === 'event')).toHaveLength(1);
  expect(JSON.stringify(events)).not.toMatch(/secret|private|password|token|https/u);
  for (const operation of ['root', 'child']) {
    expect(events.filter((e) => e.operation === operation && e.phase === 'start')).toHaveLength(1);
    expect(events.filter((e) => e.operation === operation && e.phase === 'end')).toHaveLength(1);
  }
});
const exits: readonly [string, Effect.Effect<unknown, unknown>][] = [
  ['success', Effect.void],
  ['failure', Effect.fail(new ExpectedFailure({ cause: new Error('expected') }))],
  ['defect', Effect.die(new Error('fault'))],
  ['interruption', Effect.interrupt],
];
it.each(exits)('ends %s exactly once after final cleanup', (outcome, effect) => {
  const { events, tracer } = recorder();
  const order: string[] = [];
  const program = effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        expect(events.filter((e) => e.phase === 'end')).toHaveLength(0);
        order.push('cleanup');
      })
    ),
    Effect.withSpan('root')
  );
  return runAtPromiseBoundary(program, { tracing: { tracer } })
    .catch(() => undefined)
    .then(() => {
      const ended = events.filter((e) => e.phase === 'end');
      expect(ended).toHaveLength(1);
      expect(ended[0]?.outcome).toBe(outcome);
      expect(order).toEqual(['cleanup']);
    });
});
it('joins interrupted cleanup before ending and keeps caller abort identity', async () => {
  const { events, tracer } = recorder();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const running = runAtPromiseBoundary(
    Effect.sync(() => started.resolve()).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(
        Effect.promise(() => {
          entered.resolve();
          return release.promise;
        })
      ),
      Effect.withSpan('root')
    ),
    { signal: controller.signal, tracing: { tracer } }
  ).catch((error: unknown) => error);
  await started.promise;
  controller.abort(new Error('caller stop'));
  await entered.promise;
  expect(events.filter((e) => e.phase === 'end')).toHaveLength(0);
  release.resolve();
  expect(await running).toBe(controller.signal.reason);
  expect(events.filter((e) => e.phase === 'end').map((e) => e.outcome)).toEqual(['interruption']);
});
it('retains independent expected and cleanup defects on one terminal span', async () => {
  const { events, tracer } = recorder();
  await runAtPromiseBoundary(
    Effect.fail(new ExpectedFailure({ cause: new Error('primary') })).pipe(
      Effect.ensuring(Effect.die(new Error('cleanup'))),
      Effect.withSpan('root')
    ),
    { tracing: { tracer } }
  ).catch(() => undefined);
  const ended = events.find((e) => e.phase === 'end');
  expect(ended?.outcome).toBe('defect');
  expect(ended?.cause && Cause.hasFails(ended.cause)).toBe(true);
  expect(ended?.cause && Cause.hasDies(ended.cause)).toBe(true);
});
it('ignores unlisted operations and duplicate end calls using the native span state', () => {
  const { events, tracer } = recorder();
  const input = {
    annotations: Context.empty(),
    kind: 'internal' as const,
    links: [],
    parent: Option.none(),
    root: true,
    sampled: true,
    startTime: 0n,
  };
  const ignored = tracer.span({ ...input, name: 'private path' });
  ignored.end(1n, Exit.void);
  expect(events).toEqual([]);
  const span = tracer.span({ ...input, name: 'root' });
  span.end(1n, Exit.void);
  span.end(2n, Exit.void);
  span.event('checkpoint', 3n);
  expect(events.map((e) => e.phase)).toEqual(['start', 'end']);
});
it('measures bounded event volume and elapsed overhead on the same fixture', async () => {
  const { events, tracer } = recorder();
  const count = 100;
  const fixture = Effect.gen(function* () {
    yield* Effect.void.pipe(Effect.withSpan('child'));
    yield* Effect.logInfo('checkpoint');
  }).pipe(
    Effect.withSpan('root'),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.tracerLogger]))
  );
  const measure = async (selected: Tracer.Tracer) => {
    const start = performance.now();
    for (let index = 0; index < count; index += 1) {
      await runAtPromiseBoundary(fixture, { tracing: { tracer: selected } });
    }
    return performance.now() - start;
  };
  const baselineMs = await measure(Tracer.nativeTracer);
  const tracedMs = await measure(tracer);
  expect(events).toHaveLength(count * 5);
  expect(Number.isFinite(tracedMs)).toBe(true);
  console.info(
    JSON.stringify({
      baselineMs,
      deltaMs: tracedMs - baselineMs,
      eventsPerOperation: events.length / count,
      fixture: 'one parent, one child, one checkpoint',
      iterations: count,
      tracedMs,
    })
  );
});
