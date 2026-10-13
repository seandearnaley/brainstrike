import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Data, Effect, Semaphore, SubscriptionRef } from 'effect';
import {
  type NativeIndexAction,
  type NativeIndexCause,
  type NativeIndexEvent,
  type NativeIndexState,
  reduceNativeIndex,
} from './native-index-lifecycle';

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
}

export interface NativeIndexLifecycle {
  /** Reduces one event and performs its actions; events are serialized by one permit. */
  dispatch(event: NativeIndexEvent): Promise<NativeIndexState>;
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
  const step = (event: NativeIndexEvent): Effect.Effect<NativeIndexState, unknown> =>
    Effect.gen(function* () {
      const transition = reduceNativeIndex(yield* SubscriptionRef.get(ref), event);
      if (transition.refused) {
        return yield* new NativeIndexEventRefusedError({
          cause: transition.refused,
          event: event.kind,
        });
      }
      yield* SubscriptionRef.set(ref, transition.state);
      for (const action of transition.actions) {
        const followUp = yield* perform(action).pipe(
          Effect.catch((error: unknown) =>
            action.kind === 'open'
              ? step({
                  generation: action.generation,
                  kind: 'failure',
                  message: error instanceof Error ? error.message : String(error),
                }).pipe(Effect.andThen(Effect.fail(error)))
              : Effect.fail(error)
          )
        );
        if (followUp) {
          yield* step(followUp);
        }
      }
      return yield* SubscriptionRef.get(ref);
    });
  return {
    dispatch: (event) => runAtPromiseBoundary(permit.withPermits(1)(step(event))),
    state: () => runAtPromiseBoundary(SubscriptionRef.get(ref)),
  };
}
