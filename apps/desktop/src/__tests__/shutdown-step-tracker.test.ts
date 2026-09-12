import { describe, expect, it } from 'vitest';
import { createShutdownStepTracker } from '../shutdown-step-tracker';

describe('createShutdownStepTracker', () => {
  it('reports the in-flight step and its elapsed time while a step is running', async () => {
    let now = 1000;
    const tracker = createShutdownStepTracker(() => now);
    const gate = Promise.withResolvers<void>();

    const running = tracker.run('embedding-host', () => gate.promise);
    now = 4250;

    expect(tracker.describeInFlight()).toEqual({ elapsedMs: 3250, step: 'embedding-host' });
    gate.resolve();
    expect(await running).toBeNull();
    expect(tracker.describeInFlight()).toBeNull();
  });

  it('serializes a rejected step under its name and clears the in-flight record', async () => {
    const tracker = createShutdownStepTracker(() => 0);

    const failure = await tracker.run('database', async () => {
      throw new Error('close failed');
    });

    expect(failure).toMatchObject({ message: 'close failed', step: 'database' });
    expect(tracker.describeInFlight()).toBeNull();
  });

  it('records every completed step with its duration and outcome, in order', async () => {
    let now = 0;
    const tracker = createShutdownStepTracker(() => now);

    await tracker.run('assistant-server', async () => {
      now += 12;
    });
    await tracker.run('embedding-host', async () => {
      now += 2600;
      throw new Error('stop timed out');
    });

    expect(tracker.completed()).toEqual([
      { elapsedMs: 12, failed: false, step: 'assistant-server' },
      { elapsedMs: 2600, failed: true, step: 'embedding-host' },
    ]);
  });
});
