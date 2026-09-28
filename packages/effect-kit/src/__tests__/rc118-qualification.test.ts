import { Cause, Data, Effect, Exit, Layer, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { runAtPromiseBoundary } from '../promise-boundary.js';

class PrimaryFailure extends Data.TaggedError('PrimaryFailure') {}

describe('Effect resource qualification', () => {
  it('joins an interrupted explicit Scope close and runs every finalizer', async () => {
    const scope = Scope.makeUnsafe();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    await runAtPromiseBoundary(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          events.push('last release');
        })
      )
    );
    await runAtPromiseBoundary(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          events.push('first started');
          started.resolve();
        }).pipe(
          Effect.andThen(Effect.promise(() => gate.promise)),
          Effect.andThen(
            Effect.sync(() => {
              events.push('first completed');
            })
          )
        )
      )
    );
    let settled = false;
    const closing = runAtPromiseBoundary(Scope.close(scope, Exit.void), {
      signal: controller.signal,
    }).then(
      () => {
        settled = true;
        return;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await started.promise;
    controller.abort(new DOMException('close caller cancelled', 'AbortError'));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      expect(settled).toBe(false);
      expect(events).toEqual(['first started']);
    } finally {
      gate.resolve();
    }
    await closing;
    expect(events).toEqual(['first started', 'first completed', 'last release']);
  });

  it('preserves the primary failure when its onExit callback throws synchronously', async () => {
    const primary = new PrimaryFailure();
    const cleanup = new Error('finalizer callback threw');
    await expect(
      runAtPromiseBoundary(
        Effect.fail(primary).pipe(
          Effect.onExit(() => {
            throw cleanup;
          })
        )
      )
    ).rejects.toBe(primary);
  });

  it('settles shared Layer waiters when the owning build is interrupted', async () => {
    const memo = Layer.makeMemoMapUnsafe();
    const ownerScope = Scope.makeUnsafe();
    const waiterScope = Scope.makeUnsafe();
    const owner = new AbortController();
    const waiter = new AbortController();
    const started = Promise.withResolvers<void>();
    let builds = 0;
    const layer = Layer.effectDiscard(
      Effect.sync(() => {
        builds++;
        started.resolve();
      }).pipe(Effect.andThen(Effect.never))
    );
    const owning = runAtPromiseBoundary(Layer.buildWithMemoMap(layer, memo, ownerScope), {
      signal: owner.signal,
    }).catch((error: unknown) => error);
    await started.promise;
    let settled = false;
    const observed: { exit?: Exit.Exit<unknown, unknown> } = {};
    const waiting = runAtPromiseBoundary(
      Layer.buildWithMemoMap(layer, memo, waiterScope).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            observed.exit = exit;
          })
        )
      ),
      {
        signal: waiter.signal,
      }
    ).then(
      () => {
        settled = true;
        return { status: 'resolved' } as const;
      },
      (error: unknown) => {
        settled = true;
        return { error, status: 'rejected' } as const;
      }
    );
    owner.abort();
    await owning;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      expect(settled).toBe(true);
      const outcome = await waiting;
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') {
        throw new Error('Interrupted Layer unexpectedly succeeded');
      }
      expect(outcome.error).toBeInstanceOf(Error);
      expect(builds).toBe(1);
      const exit = observed.exit;
      expect(exit && Exit.isFailure(exit)).toBe(true);
      if (!(exit && Exit.isFailure(exit))) {
        throw new Error('Expected interrupted waiter exit');
      }
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    } finally {
      waiter.abort();
      await waiting;
      await runAtPromiseBoundary(Scope.close(waiterScope, Exit.void));
      await runAtPromiseBoundary(Scope.close(ownerScope, Exit.void));
    }
  });

  it('runs later finalizers after a defect and preserves its identity', async () => {
    const scope = Scope.makeUnsafe();
    const failure = new Error('owned resource release failed');
    const events: string[] = [];
    await runAtPromiseBoundary(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          events.push('later');
        })
      )
    );
    await runAtPromiseBoundary(
      Scope.addFinalizerExit(scope, () => {
        throw failure;
      })
    );
    await expect(runAtPromiseBoundary(Scope.close(scope, Exit.void))).rejects.toBe(failure);
    expect(events).toEqual(['later']);
    await expect(runAtPromiseBoundary(Scope.close(scope, Exit.void))).resolves.toBeUndefined();
    expect(events).toEqual(['later']);
  });
});
