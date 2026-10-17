import { Cause, Data, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'vitest';
import { runAtPromiseBoundary } from '../promise-boundary.js';
import { withTimeout } from '../timeout.js';

class TestDeadline extends Data.TaggedError('TestDeadline')<{ readonly message: string }> {}

it('advances the owned deadline exactly and joins its interrupted finalizer', async () => {
  const deadline = new TestDeadline({ message: 'deadline reached' });
  const events: string[] = [];
  const program = Effect.gen(function* () {
    const task = Effect.sleep(100).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          events.push('released');
        })
      )
    );
    const fiber = yield* Effect.forkChild(
      withTimeout(task, { onTimeout: () => deadline, timeoutMs: 50 })
    );
    yield* TestClock.adjust(49);
    expect(events).toEqual([]);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(1);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(events).toEqual(['released']);
    return yield* Fiber.join(fiber);
  });
  await expect(runAtPromiseBoundary(program.pipe(Effect.provide(TestClock.layer())))).rejects.toBe(
    deadline
  );
});

it('keeps completion before the deadline and clears the losing sleep', async () => {
  const onTimeout = () => {
    throw new Error('completed task was timed out');
  };
  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      withTimeout(Effect.sleep(20).pipe(Effect.as('done')), { onTimeout, timeoutMs: 50 })
    );
    yield* TestClock.adjust(20);
    expect(yield* Fiber.join(fiber)).toBe('done');
    yield* TestClock.adjust(100);
  });
  await runAtPromiseBoundary(program.pipe(Effect.provide(TestClock.layer())));
});

it('cancellation before a deadline joins cleanup and never invokes its timeout failure', async () => {
  let timedOut = false;
  let released = false;
  const program = Effect.gen(function* () {
    const task = Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          released = true;
        })
      )
    );
    const fiber = yield* Effect.forkChild(
      withTimeout(task, {
        onTimeout: () => {
          timedOut = true;
          return new TestDeadline({ message: 'late deadline' });
        },
        timeoutMs: 50,
      })
    );
    yield* TestClock.adjust(10);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(released).toBe(true);
    yield* TestClock.adjust(100);
    expect(timedOut).toBe(false);
  });
  await runAtPromiseBoundary(program.pipe(Effect.provide(TestClock.layer())));
});
