import { describe, expect, it, vi } from 'vitest';
import {
  composeClaimPermit,
  createForegroundDbPressureStarvationTracker,
} from '../embedding-worker-config';

function createTestStarvationTracker(starvationMs: number) {
  return createForegroundDbPressureStarvationTracker({ log: vi.fn(), starvationMs });
}

describe('composeClaimPermit', () => {
  it('passes through non-claim labels without consulting the gate', async () => {
    const gate = { waitUntilInactive: vi.fn(async () => {}) };
    const base = vi.fn(async () => {});
    const permit = composeClaimPermit(base, gate as never, createTestStarvationTracker(5000));
    await permit({ label: 'embedding completion' });
    expect(base).toHaveBeenCalledTimes(1);
    expect(gate.waitUntilInactive).not.toHaveBeenCalled();
  });

  it('awaits the gate after the base permit for the claim label', async () => {
    const order: string[] = [];
    const gate = {
      waitUntilInactive: vi.fn(async () => {
        order.push('gate');
      }),
    };
    const base = vi.fn(async () => {
      order.push('base');
    });
    const permit = composeClaimPermit(base, gate as never, createTestStarvationTracker(5000));
    await permit({ label: 'embedding claim' });
    expect(order).toEqual(['base', 'gate']);
  });

  it('is a no-op wrapper when no gate is provided', async () => {
    const base = vi.fn(async () => {});
    const permit = composeClaimPermit(base, undefined, createTestStarvationTracker(5000));
    await permit({ label: 'embedding claim' });
    expect(base).toHaveBeenCalledTimes(1);
  });

  // Regression: the DB-pressure permit polls until pressure clears with NO
  // maximum. A main window that keeps issuing foreground queries (every renderer
  // query defaults to foreground priority) parked the claim loop forever, so the
  // embedding worker never claimed and anything waiting on queue drain deadlocked
  // against the only consumer that could free capacity.
  it('stops waiting on the base permit once the starvation bound elapses', async () => {
    const starvation = createTestStarvationTracker(20);
    const base = vi.fn(
      (options: { readonly label: string; readonly signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new Error('Background database permit aborted'));
          });
        })
    );
    const gate = { waitUntilInactive: vi.fn(async () => {}) };

    const permit = composeClaimPermit(base, gate as never, starvation);
    await expect(permit({ label: 'embedding claim' })).resolves.toBeUndefined();
    expect(gate.waitUntilInactive).toHaveBeenCalledTimes(1);
  });

  it('rethrows a base permit failure that is not the starvation bound', async () => {
    const base = vi.fn(async () => {
      throw new Error('snapshot read failed');
    });

    const permit = composeClaimPermit(base, undefined, createTestStarvationTracker(5000));
    await expect(permit({ label: 'embedding claim' })).rejects.toThrow('snapshot read failed');
  });
});

describe('createForegroundDbPressureStarvationTracker', () => {
  it('only bypasses after the bound and resets on any non-pressure policy', () => {
    let now = 0;
    const log = vi.fn();
    const tracker = createForegroundDbPressureStarvationTracker({
      log,
      now: () => now,
      starvationMs: 100,
    });

    tracker.observePolicy({ reason: 'foreground-db-pressure' } as never);
    expect(tracker.isBypassing()).toBe(false);

    now = 100;
    tracker.observePolicy({ reason: 'foreground-db-pressure' } as never);
    expect(tracker.isBypassing()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);

    // A second pressure observation must not re-log the same episode.
    tracker.observePolicy({ reason: 'foreground-db-pressure' } as never);
    expect(log).toHaveBeenCalledTimes(1);

    // Any other reason — including a full foreground-query yield — clears it.
    tracker.observePolicy({ reason: 'balanced' } as never);
    expect(tracker.isBypassing()).toBe(false);
  });
});
