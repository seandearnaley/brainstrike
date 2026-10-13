import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Data, Effect, Semaphore, Stream, SubscriptionRef } from 'effect';
import {
  type NativeIndexAction,
  type NativeIndexCause,
  type NativeIndexEvent,
  type NativeIndexState,
  type NativeIndexTransition,
  reduceNativeIndex,
} from './native-index-lifecycle';
import type { NativeIndexSettings } from './native-index-settings';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

/** An event the current state refuses, with that state's cause. */
export class NativeIndexEventRefusedError extends Data.TaggedError('NativeIndexEventRefused')<{
  readonly cause: NativeIndexCause;
  readonly event: NativeIndexEvent['kind'];
}> {
  override get message(): string {
    return `Native index ${this.event} refused: ${this.cause.kind}.`;
  }
}

/** Performs the reducer's actions. An opened generation reports `opened` back. */
export interface NativeIndexLifecycleExecutor {
  execute(action: NativeIndexAction): Promise<NativeIndexEvent | undefined>;
  /** Abort admitted work immediately; execute(close) still joins its physical exit. */
  fence(): void;
}

export class NativeSourceRetirementFailure extends Data.TaggedError(
  'NativeSourceRetirementFailure'
)<{ readonly error: unknown }> {}

export interface PreparedNativeIndexPause {
  complete(): Promise<void>;
  readonly physical: Promise<void>;
}

export interface NativeIndexLifecycle {
  configure(read: () => Promise<NativeIndexSettings>, roots?: boolean): Promise<NativeIndexState>;
  /** Reduces one event and performs its actions; events are serialized by one permit. */
  dispatch(event: NativeIndexEvent): Promise<NativeIndexState>;
  observe(listener: (state: NativeIndexState) => void, signal: AbortSignal): Promise<void>;
  preparePause(settings: NativeIndexSettings): Promise<PreparedNativeIndexPause>;
  prepareSavedPause(
    read: () => Promise<NativeIndexSettings>
  ): Promise<PreparedNativeIndexPause | null>;
  rebuild(read: () => Promise<NativeIndexSettings>): Promise<NativeIndexState>;
  settled(): Promise<NativeIndexState>;
  start(settings: Promise<NativeIndexSettings>): Promise<NativeIndexState>;
  /** The current lifecycle value. */
  state(): Promise<NativeIndexState>;
}

/**
 * The native index's one owner (BST-1988 lifecycle): one state value, one permit,
 * and the pure reducer. IO happens only in the executor's actions. An action that
 * fails records the generation's failure before its error reaches the caller.
 */
export async function createNativeIndexLifecycle(
  initial: NativeIndexState,
  executor: NativeIndexLifecycleExecutor
): Promise<NativeIndexLifecycle> {
  const { permit, ref } = await runAtPromiseBoundary(
    Effect.all({ permit: Semaphore.make(1), ref: SubscriptionRef.make(initial) })
  );
  const perform = (action: NativeIndexAction) =>
    Effect.tryPromise({ catch: (error: unknown) => error, try: () => executor.execute(action) });
  const prepare = Effect.fnUntraced(function* (event: NativeIndexEvent) {
    const transition = reduceNativeIndex(yield* SubscriptionRef.get(ref), event);
    if (transition.refused) {
      return yield* new NativeIndexEventRefusedError({
        cause: transition.refused,
        event: event.kind,
      });
    }
    yield* SubscriptionRef.set(ref, transition.state);
    return transition;
  });
  const execute = Effect.fnUntraced(function* (
    event: NativeIndexEvent,
    transition: NativeIndexTransition
  ): Effect.fn.Return<NativeIndexState, unknown> {
    for (const action of transition.actions) {
      const followUp = yield* perform(action).pipe(
        Effect.catch((failure: unknown) => {
          const error = failure instanceof NativeSourceRetirementFailure ? failure.error : failure;
          return action.kind === 'open' || action.kind === 'apply-sources'
            ? step({
                error,
                generation: transition.state.generation,
                kind: 'failure',
                message: error instanceof Error ? error.message : String(error),
                ...(failure instanceof NativeSourceRetirementFailure
                  ? { recovery: 'sources' as const }
                  : {}),
              }).pipe(Effect.andThen(Effect.fail(error)))
            : Effect.fail(error);
        })
      );
      if (followUp) {
        yield* step(followUp);
      }
    }
    if (event.kind === 'stop-sources' && transition.actions.length > 0) {
      yield* step({ generation: transition.state.generation, kind: 'sources-stopped' });
    }
    if (event.kind === 'terminal' && transition.actions.length > 0) {
      yield* step({ generation: transition.state.generation, kind: 'retired' });
    }
    return yield* SubscriptionRef.get(ref);
  });
  const step = Effect.fnUntraced(function* (
    event: NativeIndexEvent
  ): Effect.fn.Return<NativeIndexState, unknown> {
    return yield* execute(event, yield* prepare(event));
  });
  const withSettings = Effect.fnUntraced(function* <A>(
    read: () => Promise<NativeIndexSettings>,
    use: (settings: NativeIndexSettings) => Effect.Effect<A, unknown>,
    onInvalid?: () => void
  ): Effect.fn.Return<A, unknown> {
    yield* step({ kind: 'settings-reading' });
    const settings = yield* Effect.tryPromise({ catch: (error: unknown) => error, try: read }).pipe(
      Effect.catch((error: unknown) =>
        Effect.gen(function* () {
          const event = {
            cause: {
              error,
              kind:
                error instanceof NativeIndexSetupRequiredError
                  ? ('setup-required' as const)
                  : ('settings-invalid' as const),
              message: error instanceof Error ? error.message : String(error),
            },
            kind: 'settings-unreadable' as const,
          };
          const transition = yield* prepare(event);
          onInvalid?.();
          yield* execute(event, transition).pipe(
            Effect.catch((cleanup: unknown) => {
              const failure = new AggregateError(
                [error, cleanup],
                'Invalid native settings retained cleanup ownership.'
              );
              return step({ ...event, cause: { ...event.cause, error: failure } }).pipe(
                Effect.andThen(Effect.fail(failure))
              );
            })
          );
          return yield* Effect.fail(error);
        })
      )
    );
    return yield* use(settings);
  });
  const dispatch = (event: NativeIndexEvent): Promise<NativeIndexState> =>
    runAtPromiseBoundary(
      event.kind === 'terminal' || event.kind === 'fence' || event.kind === 'stop-sources'
        ? prepare(event).pipe(
            Effect.flatMap((transition) => {
              if (transition.actions.length > 0 || event.kind === 'fence') {
                executor.fence();
              }
              return permit.withPermits(1)(execute(event, transition));
            })
          )
        : permit.withPermits(1)(step(event))
    );
  const preparePause = (
    read: () => Promise<NativeIndexSettings>,
    saved: boolean
  ): Promise<PreparedNativeIndexPause | null> => {
    const prepared = Promise.withResolvers<PreparedNativeIndexPause | null>();
    const finished = Promise.withResolvers<void>();
    finished.promise.catch(() => undefined);
    const use = (settings: NativeIndexSettings): Effect.Effect<NativeIndexState, unknown> => {
      if (saved && !settings.paused) {
        prepared.resolve(null);
        return step({ kind: 'settings-unchanged' });
      }
      const event = { kind: 'prepare-pause', settings } as const;
      return prepare(event).pipe(
        Effect.flatMap((transition) => {
          if (transition.state.kind !== 'pausing') {
            prepared.resolve(null);
            return execute(event, transition);
          }
          prepared.resolve({
            complete: async () => {
              await finished.promise;
              await dispatch({ generation: transition.state.generation, kind: 'complete-pause' });
            },
            physical: finished.promise,
          });
          return execute(event, transition);
        })
      );
    };
    const operation = runAtPromiseBoundary(
      permit.withPermits(1)(
        saved
          ? withSettings(read, use, () =>
              prepared.resolve({
                complete: () => finished.promise,
                physical: finished.promise,
              })
            )
          : Effect.promise(read).pipe(Effect.flatMap(use))
      )
    );
    operation.then(
      () => finished.resolve(),
      (error: unknown) => {
        prepared.reject(error);
        finished.reject(error);
      }
    );
    return prepared.promise;
  };
  return {
    configure: (read, roots = false) =>
      runAtPromiseBoundary(
        permit.withPermits(1)(
          withSettings(read, (settings) =>
            step({ kind: roots ? 'roots-changed' : 'settings-saved', settings })
          )
        )
      ),
    dispatch,
    observe: (listener, signal) =>
      runAtPromiseBoundary(
        SubscriptionRef.changes(ref).pipe(
          Stream.interruptWhen(
            Effect.callback<never, unknown>((resume) => {
              const abort = (): void => resume(Effect.fail(signal.reason));
              if (signal.aborted) {
                abort();
                return;
              }
              signal.addEventListener('abort', abort, { once: true });
              return Effect.sync(() => signal.removeEventListener('abort', abort));
            })
          ),
          Stream.runForEach((state) => Effect.sync(() => listener(state)))
        )
      ),
    preparePause: async (settings) => {
      const prepared = await preparePause(() => Promise.resolve(settings), false);
      if (!prepared) {
        throw new Error('Explicit native pause produced no preparation.');
      }
      return prepared;
    },
    prepareSavedPause: (read) => preparePause(read, true),
    rebuild: (read) =>
      runAtPromiseBoundary(
        permit.withPermits(1)(
          withSettings(read, (settings) => step({ kind: 'rebuild-settings', settings }))
        )
      ),
    settled: () => runAtPromiseBoundary(permit.withPermits(1)(SubscriptionRef.get(ref))),
    start: (settings) =>
      runAtPromiseBoundary(
        SubscriptionRef.get(ref).pipe(
          Effect.flatMap((state) =>
            state.kind === 'idle'
              ? permit.withPermits(1)(
                  SubscriptionRef.get(ref).pipe(
                    Effect.flatMap((current) =>
                      current.kind === 'idle'
                        ? withSettings(
                            () => settings,
                            (saved) => step({ kind: 'settings-saved', settings: saved })
                          )
                        : Effect.succeed(current)
                    )
                  )
                )
              : Effect.succeed(state)
          )
        )
      ),
    state: () => runAtPromiseBoundary(SubscriptionRef.get(ref)),
  };
}
