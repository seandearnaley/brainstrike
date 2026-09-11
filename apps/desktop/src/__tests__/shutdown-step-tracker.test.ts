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
});
