import { describe, expect, it } from 'vitest';
import { runWithTimeout } from '../timeout.js';

const pendingTimers = (): number =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

const neverSettles = (): Promise<never> => new Promise<never>(() => undefined);

describe('runWithTimeout', () => {
  it('resolves with the task value and clears the deadline timer', async () => {
    const before = pendingTimers();

    await expect(
      runWithTimeout(async () => 'chunked', {
        onTimeout: () => new Error('unused'),
        timeoutMs: 60_000,
      })
    ).resolves.toBe('chunked');
    // Let any scheduler yield timer settle before sampling, so only a leaked
    // 60-second deadline can keep the count above its starting value.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(pendingTimers()).toBe(before);
  });

  it('passes a task rejection through unchanged', async () => {
    const failure = new TypeError('parse failed');

    await expect(
      runWithTimeout(() => Promise.reject(failure), {
        onTimeout: () => new Error('unused'),
        timeoutMs: 60_000,
      })
    ).rejects.toBe(failure);
  });

  it('rejects with the onTimeout value and aborts the task signal when the deadline passes', async () => {
    const timeoutError = new Error('Processing timeout after 20ms: a.ts (1)');
    let taskSignal: AbortSignal | undefined;

    await expect(
      runWithTimeout(
        (signal) => {
          taskSignal = signal;
          return neverSettles();
        },
        { onTimeout: () => timeoutError, timeoutMs: 20 }
      )
    ).rejects.toBe(timeoutError);

    expect(taskSignal?.aborted).toBe(true);
  });

  it('rejects with the caller signal reason and aborts the task signal', async () => {
    const controller = new AbortController();
    const reason = new DOMException('stopped', 'AbortError');
    let taskSignal: AbortSignal | undefined;
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();

    const running = runWithTimeout(
      (signal) => {
        taskSignal = signal;
        markStarted();
        return neverSettles();
      },
      { onTimeout: () => new Error('unused'), signal: controller.signal, timeoutMs: 60_000 }
    );
    await started;
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(taskSignal?.aborted).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a timeoutMs of %s before running the task',
    async (timeoutMs) => {
      let ran = false;

      await expect(
        runWithTimeout(
          async () => {
            ran = true;
          },
          { onTimeout: () => new Error('unused'), timeoutMs }
        )
      ).rejects.toBeInstanceOf(RangeError);
      expect(ran).toBe(false);
    }
  );
});
