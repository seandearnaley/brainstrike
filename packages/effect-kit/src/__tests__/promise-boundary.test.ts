import { Data, Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { runAtPromiseBoundary } from '../promise-boundary.js';

class TaskMissing extends Data.TaggedError('TaskMissing')<{ readonly taskId: string }> {}

describe('runAtPromiseBoundary', () => {
  it('resolves with the success value', async () => {
    await expect(runAtPromiseBoundary(Effect.succeed(42))).resolves.toBe(42);
  });

  it('rejects with the failure value itself so instanceof checks keep working', async () => {
    const failure = new TaskMissing({ taskId: 't-1' });

    const rejection = await runAtPromiseBoundary(Effect.fail(failure)).catch(
      (error: unknown) => error
    );

    expect(rejection).toBe(failure);
    expect(rejection).toBeInstanceOf(TaskMissing);
  });

  it('rejects with the thrown value for a defect', async () => {
    const defect = new RangeError('bad index');

    await expect(runAtPromiseBoundary(Effect.die(defect))).rejects.toBe(defect);
  });

  it('keeps the failure value when a signal is supplied but never aborted', async () => {
    const failure = new TaskMissing({ taskId: 't-2' });
    const controller = new AbortController();

    await expect(
      runAtPromiseBoundary(Effect.fail(failure), { signal: controller.signal })
    ).rejects.toBe(failure);
  });

  it('interrupts the effect on abort, runs its finalizers, and rejects with signal.reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('caller went away', 'AbortError');
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    let finalized = false;

    const running = runAtPromiseBoundary(
      Effect.sync(markStarted).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          })
        )
      ),
      { signal: controller.signal }
    );
    await started;
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(finalized).toBe(true);
  });

  it('does not start the effect when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;

    await expect(
      runAtPromiseBoundary(
        Effect.sync(() => {
          ran = true;
        }),
        { signal: controller.signal }
      )
    ).rejects.toBe(controller.signal.reason);
    expect(ran).toBe(false);
  });

  it('rejects with an Error for an interruption that no signal caused', async () => {
    const rejection = await runAtPromiseBoundary(Effect.interrupt).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
  });
});
