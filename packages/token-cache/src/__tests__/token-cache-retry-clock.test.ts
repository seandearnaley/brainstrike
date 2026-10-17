import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Cause, Clock, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'vitest';
import { tokenCacheTransactionRetrySchedule } from '../token-cache-store';

const transient = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });

it('makes exactly three attempts at 0, 25 and 75ms before exhausting the store policy', async () => {
  const times: number[] = [];
  const program = Effect.gen(function* () {
    const transaction = Effect.gen(function* () {
      times.push(yield* Clock.currentTimeMillis);
      return yield* Effect.fail({ original: transient });
    });
    const fiber = yield* Effect.forkChild(
      transaction.pipe(
        Effect.retry(tokenCacheTransactionRetrySchedule({ baseDelayMs: 25, maxAttempts: 3 }))
      )
    );
    yield* TestClock.adjust(0);
    expect(times).toEqual([0]);
    yield* TestClock.adjust(24);
    expect(times).toEqual([0]);
    yield* TestClock.adjust(1);
    expect(times).toEqual([0, 25]);
    yield* TestClock.adjust(49);
    expect(times).toEqual([0, 25]);
    yield* TestClock.adjust(1);
    expect(times).toEqual([0, 25, 75]);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    return yield* Fiber.join(fiber);
  });
  await expect(
    runAtPromiseBoundary(program.pipe(Effect.provide(TestClock.layer())))
  ).rejects.toMatchObject({ original: transient });
});

it('stops on the first permanent failure without advancing a retry', async () => {
  let attempts = 0;
  const permanent = new Error('constraint violation');
  const program = Effect.gen(function* () {
    const transaction = Effect.suspend(() => {
      attempts++;
      return Effect.fail({ original: permanent });
    });
    const fiber = yield* Effect.forkChild(
      transaction.pipe(
        Effect.retry(tokenCacheTransactionRetrySchedule({ baseDelayMs: 25, maxAttempts: 3 }))
      )
    );
    yield* TestClock.adjust(1000);
    expect(attempts).toBe(1);
    return yield* Fiber.join(fiber);
  });
  await expect(
    runAtPromiseBoundary(program.pipe(Effect.provide(TestClock.layer())))
  ).rejects.toMatchObject({ original: permanent });
});

it('cancels a backoff without running a replacement attempt', async () => {
  let attempts = 0;
  const program = Effect.gen(function* () {
    const transaction = Effect.suspend(() => {
      attempts++;
      return Effect.fail({ original: transient });
    });
    const fiber = yield* Effect.forkChild(
      transaction.pipe(
        Effect.retry(tokenCacheTransactionRetrySchedule({ baseDelayMs: 25, maxAttempts: 3 }))
      )
    );
    yield* TestClock.adjust(0);
    expect(attempts).toBe(1);
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust(1000);
    expect(attempts).toBe(1);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  });
  await runAtPromiseBoundary(program.pipe(Effect.provide(TestClock.layer())));
});
