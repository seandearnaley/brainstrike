import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Cause, Context, Effect, Exit, Layer, Scope } from 'effect';

/** Each scheduler supplies its existing native trigger recipe, never admitted SQL. */
export interface MaintenanceTriggerAcquirer {
  readonly acquireTrigger: (isLive: () => boolean) => Effect.Effect<void, never, Scope.Scope>;
}

export class DesktopMaintenanceTriggers extends Context.Service<
  DesktopMaintenanceTriggers,
  { readonly stop: () => void }
>()('brainstrike/desktop/DesktopMaintenanceTriggers') {}

export interface DesktopMaintenanceTriggerGraph {
  readonly close: () => Promise<void>;
  readonly start: () => Promise<void>;
  /** Prevent automatic passes synchronously, including during acquisition. */
  readonly stop: () => void;
}

function failureReasons(exit: Exit.Exit<unknown, unknown>): unknown[] {
  return Exit.isSuccess(exit)
    ? []
    : exit.cause.reasons.map((reason) => Cause.squash(Cause.fromReasons([reason])));
}

function throwFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
}

/** Owns the paired native subscriptions and timers as one atomic Layer build. */
export function createDesktopMaintenanceTriggerGraph(
  database: MaintenanceTriggerAcquirer,
  dimension: MaintenanceTriggerAcquirer
): DesktopMaintenanceTriggerGraph {
  const scope = Scope.makeUnsafe();
  let stopped = false;
  let service: DesktopMaintenanceTriggers['Service'] | null = null;
  let buildPromise: Promise<
    Exit.Exit<Context.Context<DesktopMaintenanceTriggers>, unknown>
  > | null = null;
  let startPromise: Promise<void> | null = null;
  let scopeClosePromise: Promise<Exit.Exit<void, unknown>> | null = null;
  let closePromise: Promise<void> | null = null;

  const fence = (): void => {
    stopped = true;
  };
  const closeScope = (): Promise<Exit.Exit<void, unknown>> => {
    scopeClosePromise ??= runAtPromiseBoundary(Effect.exit(Scope.close(scope, Exit.void)));
    return scopeClosePromise;
  };
  const layer = Layer.effect(
    DesktopMaintenanceTriggers,
    Effect.gen(function* () {
      const layerScope = yield* Scope.Scope;
      const groupScope = yield* Scope.fork(layerScope, 'parallel');
      const databaseScope = yield* Scope.fork(groupScope, 'sequential');
      const dimensionScope = yield* Scope.fork(groupScope, 'sequential');
      if (!stopped) {
        yield* Scope.provide(
          database.acquireTrigger(() => !stopped),
          databaseScope
        );
      }
      if (!stopped) {
        yield* Scope.provide(
          dimension.acquireTrigger(() => !stopped),
          dimensionScope
        );
      }
      return DesktopMaintenanceTriggers.of({ stop: fence });
    }).pipe(
      // Layer closes its scope on build failure before the caller sees the Exit.
      // Fence first so a slow/throwing finalizer cannot permit another tick.
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.sync(fence) : Effect.void))
    )
  );

  const start = (): Promise<void> => {
    if (startPromise) {
      return startPromise;
    }
    if (stopped) {
      return Promise.resolve();
    }
    // Publish both latches before any subscription callback can reenter start
    // or close during synchronous Layer acquisition.
    const building = Promise.resolve().then(() =>
      runAtPromiseBoundary(Effect.exit(Layer.buildWithScope(layer, scope)))
    );
    buildPromise = building;
    startPromise = (async () => {
      const built = await building;
      if (Exit.isFailure(built)) {
        fence();
        const closed = await closeScope();
        throwFailures(
          [...failureReasons(built), ...failureReasons(closed)],
          'Desktop maintenance acquisition and cleanup failed'
        );
        return;
      }
      service = Context.get(built.value, DesktopMaintenanceTriggers);
      if (stopped) {
        service.stop();
      }
    })();
    return startPromise;
  };

  const stop = (): void => {
    // This flag exists before Layer.buildWithScope begins and remains the
    // fallback while its typed service is not yet available.
    (service?.stop ?? fence)();
  };

  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    stop();
    closePromise = (async () => {
      const built = await buildPromise;
      const closed = await closeScope();
      throwFailures(
        [...(built ? failureReasons(built) : []), ...failureReasons(closed)],
        'Desktop maintenance trigger cleanup failed'
      );
    })();
    return closePromise;
  };

  return { close, start, stop };
}
