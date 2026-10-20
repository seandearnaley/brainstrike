import { afterEach, describe, expect, it, vi } from 'vitest';
import { runShutdownSequence, type ShutdownStepOutcome } from '../shutdown-sequence.js';

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

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
      { now: () => now }
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
      { now: () => 0 }
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
        onStepSettled: (outcome: ShutdownStepOutcome) => {
          events.push(`settled:${outcome.step}:${outcome.outcome}`);
        },
      }
    );

    expect(events).toEqual(['run:a', 'settled:a:succeeded', 'settled:b:failed']);
  });

  it('a slow step is reported once and every later step runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const onSlow = vi.fn();
    const ran: string[] = [];
    const running = runShutdownSequence(
      [
        {
          name: 'renderers',
          run: () => new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        },
        { name: 'file-system', run: () => void ran.push('file-system') },
        { name: 'git-commands', run: () => void ran.push('git-commands') },
      ],
      { now: () => Date.now(), onSlow, slowAfterMs: 10_000 }
    );
    await vi.advanceTimersByTimeAsync(10_000);
    // Named while it still runs; nothing after it has started.
    const reportedWhileRunning = [...onSlow.mock.calls];
    const ranWhileSlow = [...ran];

    await vi.advanceTimersByTimeAsync(5000);
    await expect(running).resolves.toEqual({
      steps: [
        { elapsedMs: 15_000, outcome: 'succeeded', step: 'renderers' },
        { elapsedMs: 0, outcome: 'succeeded', step: 'file-system' },
        { elapsedMs: 0, outcome: 'succeeded', step: 'git-commands' },
      ],
    });
    expect(ran).toEqual(['file-system', 'git-commands']);
    expect(reportedWhileRunning).toEqual([[{ elapsedMs: 10_000, step: 'renderers' }]]);
    expect(ranWhileSlow).toEqual([]);
    expect(onSlow).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disarms the slow report of a step that settles first, failed or not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const onSlow = vi.fn();
    const running = runShutdownSequence(
      [
        { name: 'a', run: () => new Promise<void>((resolve) => setTimeout(resolve, 999)) },
        { name: 'b', run: () => Promise.reject(new Error('b failed')) },
      ],
      { onSlow, slowAfterMs: 1000 }
    );
    await vi.advanceTimersByTimeAsync(999);
    await running;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('rejects with a throwing slow report once its step settles, and runs no later step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const broken = new Error('slow report threw');
    const later = vi.fn();
    const running = runShutdownSequence(
      [
        { name: 'a', run: () => new Promise<void>((resolve) => setTimeout(resolve, 20)) },
        { name: 'b', run: later },
      ],
      {
        onSlow: () => {
          throw broken;
        },
        slowAfterMs: 10,
      }
    );
    const rejected = expect(running).rejects.toBe(broken);
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(later).not.toHaveBeenCalled();
  });

  it('rejects invalid options without running a step', async () => {
    const run = vi.fn();
    const onSlow = (): void => undefined;

    await expect(
      runShutdownSequence([{ name: 'a', run }], { onSlow, slowAfterMs: 0 })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      runShutdownSequence([{ name: 'a', run }], { onSlow, slowAfterMs: Number.NaN })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(runShutdownSequence([{ name: 'a', run }], { onSlow })).rejects.toThrow(
      /onSlow and slowAfterMs together/
    );
    await expect(runShutdownSequence([{ name: 'a', run }], { slowAfterMs: 10 })).rejects.toThrow(
      /onSlow and slowAfterMs together/
    );
    await expect(
      runShutdownSequence([
        { name: 'a', run },
        { name: 'a', run },
      ])
    ).rejects.toThrow(/non-empty and unique; got "a"/);
    await expect(runShutdownSequence([{ name: ' ', run }])).rejects.toBeInstanceOf(TypeError);
    expect(run).not.toHaveBeenCalled();
  });
});
