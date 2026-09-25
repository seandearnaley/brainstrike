import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Effect, Exit, Scope } from 'effect';

export interface MaintenanceTriggerRuntime {
  readonly close: () => Promise<void>;
  readonly start: () => Promise<void>;
  /** Seal tick admission synchronously; resource release is joined by close(). */
  readonly stop: () => void;
}

export interface MaintenanceTriggerRuntimeOptions {
  readonly initialDelayMs: number;
  readonly intervalMs: number;
  readonly onCloseError: (error: unknown) => void;
  readonly subscribe?: () => (() => void) | null;
  /** Dispatch an observed pass without waiting for its database operation. */
  readonly tick: () => void;
}

interface TriggerState {
  closePromise: Promise<void> | null;
  readonly scope: Scope.Closeable;
  startPromise: Promise<void>;
  stopped: boolean;
}

interface TimerHandles {
  initial: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
}

/** Own the two unref'd trigger timers and observer; never own admitted DB work. */
export function createMaintenanceTriggerRuntime(
  options: MaintenanceTriggerRuntimeOptions
): MaintenanceTriggerRuntime {
  let current: TriggerState | null = null;
  let lastClose: Promise<void> = Promise.resolve();

  const closeState = (state: TriggerState): Promise<void> => {
    if (state.closePromise) {
      return state.closePromise;
    }
    state.stopped = true;
    const closing = runAtPromiseBoundary(Scope.close(state.scope, Exit.void)).finally(() => {
      if (current === state) {
        current = null;
      }
    });
    state.closePromise = closing;
    lastClose = closing;
    void closing.catch(options.onCloseError);
    return closing;
  };

  return {
    close: () => (current ? closeState(current) : lastClose),
    start: () => {
      if (current && !current.stopped) {
        return current.startPromise;
      }
      const state: TriggerState = {
        closePromise: null,
        scope: Scope.makeUnsafe(),
        startPromise: Promise.resolve(),
        stopped: false,
      };
      current = state;
      const acquire = Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => options.subscribe?.() ?? null),
          (unsubscribe) => Effect.sync(() => unsubscribe?.())
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const handles: TimerHandles = { initial: null, interval: null };
            const isLive = (): boolean => current === state && !state.stopped;
            const fire = (): void => {
              if (isLive()) {
                options.tick();
              }
            };
            handles.initial = setTimeout(() => {
              handles.initial = null;
              if (!isLive()) {
                return;
              }
              fire();
              if (!isLive()) {
                return;
              }
              handles.interval = setInterval(fire, options.intervalMs);
              handles.interval.unref?.();
            }, options.initialDelayMs);
            handles.initial.unref?.();
            return handles;
          }),
          (handles) =>
            Effect.sync(() => {
              if (handles.initial !== null) {
                clearTimeout(handles.initial);
                handles.initial = null;
              }
              if (handles.interval !== null) {
                clearInterval(handles.interval);
                handles.interval = null;
              }
            })
        );
      });
      state.startPromise = runAtPromiseBoundary(
        Effect.provideService(acquire, Scope.Scope, state.scope)
      ).catch(async (error: unknown) => {
        try {
          await closeState(state);
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            'Maintenance trigger acquisition and cleanup failed'
          );
        }
        throw error;
      });
      return state.startPromise;
    },
    stop: () => {
      if (current) {
        current.stopped = true;
        void closeState(current);
      }
    },
  };
}
