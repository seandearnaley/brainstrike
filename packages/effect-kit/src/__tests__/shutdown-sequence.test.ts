import { describe, expect, it, vi } from 'vitest';
import {
  runShutdownSequence,
  type ShutdownStepInFlight,
  type ShutdownStepOutcome,
} from '../shutdown-sequence.js';

const pendingTimers = (): number =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

const neverSettles = (): Promise<never> => new Promise<never>(() => undefined);

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('runShutdownSequence', () => {
  it('runs steps one at a time, in order, and reports each duration', async () => {
    let now = 0;
    const order: string[] = [];
    const { promise: firstGate, resolve: openFirst } = Promise.withResolvers<void>();

    const running = runShutdownSequence(
      [
        {
          name: 'renderers',
          run: async () => {
            order.push('renderers:start');
            await firstGate;
            now += 40;
            order.push('renderers:end');
          },
        },
        {
          name: 'database',
          run: () => {
            order.push('database');
            now += 7;
          },
        },
      ],
      { deadlineMs: 60_000, now: () => now, onDeadline: () => undefined }
    );
    await settle();
    // The second step has not started while the first is still pending.
    expect(order).toEqual(['renderers:start']);

    openFirst();
    await expect(running).resolves.toEqual({
      steps: [
        { elapsedMs: 40, outcome: 'succeeded', step: 'renderers' },
        { elapsedMs: 7, outcome: 'succeeded', step: 'database' },
      ],
      timedOut: false,
    });
    expect(order).toEqual(['renderers:start', 'renderers:end', 'database']);
  });

  it('records a failed step with its own error and still runs later steps', async () => {
    const rejection = new Error('close failed');
    const thrown = new TypeError('sync teardown threw');
    const ran: string[] = [];

    const report = await runShutdownSequence(
      [
        { name: 'embedding-host', run: () => Promise.reject(rejection) },
        {
          name: 'forge',
          run: () => {
            throw thrown;
          },
        },
        {
          name: 'database',
          run: () => {
            ran.push('database');
          },
        },
      ],
      { deadlineMs: 60_000, now: () => 0, onDeadline: () => undefined }
    );

    expect(report.steps).toEqual([
      { elapsedMs: 0, error: rejection, outcome: 'failed', step: 'embedding-host' },
      { elapsedMs: 0, error: thrown, outcome: 'failed', step: 'forge' },
      { elapsedMs: 0, outcome: 'succeeded', step: 'database' },
    ]);
    expect(ran).toEqual(['database']);
  });

  it('reports each settled step before the next one starts', async () => {
    const events: string[] = [];

    await runShutdownSequence(
      [
        { name: 'a', run: () => void events.push('run:a') },
        { name: 'b', run: () => Promise.reject(new Error('b failed')) },
      ],
      {
        deadlineMs: 60_000,
        onDeadline: () => undefined,
        onStepSettled: (outcome: ShutdownStepOutcome) => {
          events.push(`settled:${outcome.step}:${outcome.outcome}`);
        },
      }
    );

    expect(events).toEqual(['run:a', 'settled:a:succeeded', 'settled:b:failed']);
  });

  it('at the deadline aborts the running step, names it, and skips the rest', async () => {
    let now = 0;
    let stepSignal: AbortSignal | undefined;
    let abortedWhenReported: boolean | undefined;
    const ranAfter = vi.fn();
    const onDeadline = vi.fn((inFlight: ShutdownStepInFlight | null) => {
      abortedWhenReported = stepSignal?.aborted;
      return inFlight;
    });

    const report = await runShutdownSequence(
      [
        { name: 'renderers', run: () => undefined },
        {
          name: 'embedding-host',
          run: (signal) => {
            stepSignal = signal;
            now = 4998;
            return neverSettles();
          },
        },
        { name: 'database', run: ranAfter },
      ],
      { deadlineMs: 20, now: () => now, onDeadline }
    );

    expect(onDeadline).toHaveBeenCalledTimes(1);
    expect(onDeadline).toHaveBeenCalledWith({ elapsedMs: 4998, step: 'embedding-host' });
    // Interrupted BEFORE the caller hears about it, so an owner that listens to
    // its signal starts stopping before the caller forces an exit.
    expect(abortedWhenReported).toBe(true);
    expect(ranAfter).not.toHaveBeenCalled();
    expect(report).toEqual({
      steps: [{ elapsedMs: 0, outcome: 'succeeded', step: 'renderers' }],
      timedOut: true,
    });
  });

  it('clears the deadline timer when every step finishes in time', async () => {
    const before = pendingTimers();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const onDeadline = vi.fn();

    const running = runShutdownSequence([{ name: 'database', run: () => gate }], {
      deadlineMs: 60_000,
      onDeadline,
    });
    await settle();
    // Visible while the sequence runs, so the equality below is not vacuous.
    expect(pendingTimers()).toBeGreaterThan(before);

    open();
    await expect(running).resolves.toMatchObject({ timedOut: false });
    await settle();

    expect(pendingTimers()).toBe(before);
    expect(onDeadline).not.toHaveBeenCalled();
  });

  it('rejects invalid options without running a step', async () => {
    const run = vi.fn();
    const onDeadline = (): void => undefined;

    await expect(
      runShutdownSequence([{ name: 'a', run }], { deadlineMs: 0, onDeadline })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      runShutdownSequence([{ name: 'a', run }], { deadlineMs: Number.NaN, onDeadline })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      runShutdownSequence(
        [
          { name: 'a', run },
          { name: 'a', run },
        ],
        { deadlineMs: 1000, onDeadline }
      )
    ).rejects.toThrow(/non-empty and unique; got "a"/);
    await expect(
      runShutdownSequence([{ name: ' ', run }], { deadlineMs: 1000, onDeadline })
    ).rejects.toBeInstanceOf(TypeError);
    expect(run).not.toHaveBeenCalled();
  });
});
