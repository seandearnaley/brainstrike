import { createDatabaseIntegrityWatcher } from '@brainstrike/db';
import type { DatabaseIntegritySnapshot } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  composeClaimPermit,
  composeIntegrityHold,
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
  it('reaches the bypass bound when the wall clock moves backward', () => {
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      let elapsedNow = 0;
      const tracker = createForegroundDbPressureStarvationTracker({
        elapsedNow: () => elapsedNow,
        log: vi.fn(),
        starvationMs: 100,
      });

      tracker.observePolicy({ reason: 'foreground-db-pressure' } as never);
      elapsedNow = 100;
      wallClock.mockReturnValue(0);

      expect(tracker.isBypassing()).toBe(true);
    } finally {
      wallClock.mockRestore();
    }
  });

  it('only bypasses after the bound and resets on any non-pressure policy', () => {
    let now = 0;
    const log = vi.fn();
    const tracker = createForegroundDbPressureStarvationTracker({
      elapsedNow: () => now,
      log,
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

const CONTAINED_STATE = {
  context: 'db:query',
  kind: 'contained',
  signal: { message: 'index "idx" contains unexpected zero page', sqlstate: 'XX002' },
  since: '2026-09-29T12:00:00.000Z',
} as const;
const HOLD_WARNING = 'Embedding claims paused: database integrity containment is active';
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function createIntegrityHarness(initial: DatabaseIntegritySnapshot) {
  let listener: (snapshot: DatabaseIntegritySnapshot) => void = () => undefined;
  const watcher = createDatabaseIntegrityWatcher({
    getState: async () => initial,
    onChanged: (callback) => {
      listener = callback;
      return () => undefined;
    },
  });
  return { push: (snapshot: DatabaseIntegritySnapshot) => listener(snapshot), watcher };
}

describe('composeIntegrityHold', () => {
  it('calls the base permit once with the same options while the database is healthy', async () => {
    const { watcher } = createIntegrityHarness({ revision: 0, state: { kind: 'healthy' } });
    const base = vi.fn(async () => {});
    const log = vi.fn();

    await composeIntegrityHold(base, watcher, log)({ label: 'embedding claim' });

    expect(base).toHaveBeenCalledExactlyOnceWith({ label: 'embedding claim' });
    expect(log).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('parks claims without calling the base, warning once per revision, until healthy', async () => {
    const { push, watcher } = createIntegrityHarness({ revision: 1, state: CONTAINED_STATE });
    const base = vi.fn(async () => {});
    const log = vi.fn();
    const permit = composeIntegrityHold(base, watcher, log);

    const parked = [permit({ label: 'embedding claim' }), permit({ label: 'embedding claim' })];
    await tick();
    expect(base).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(HOLD_WARNING, {
      revision: 1,
      state: CONTAINED_STATE,
    });

    push({ revision: 2, state: { kind: 'healthy' } });
    await Promise.all(parked);
    expect(base).toHaveBeenCalledTimes(2);

    push({ revision: 3, state: CONTAINED_STATE });
    const later = permit({ label: 'embedding claim' });
    await tick();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(HOLD_WARNING, expect.objectContaining({ revision: 3 }));
    watcher.dispose();
    await expect(later).rejects.toThrow('Database integrity watcher was disposed.');
  });

  it('re-parks a claim whose containment began while the base permit was waiting', async () => {
    const { push, watcher } = createIntegrityHarness({ revision: 0, state: { kind: 'healthy' } });
    let releaseBase: () => void = () => undefined;
    const base = vi
      .fn<(options: { readonly label: string }) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseBase = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const log = vi.fn();
    let settled = false;

    const claim = composeIntegrityHold(
      base,
      watcher,
      log
    )({ label: 'embedding claim' }).then(() => {
      settled = true;
    });
    await tick();
    expect(base).toHaveBeenCalledTimes(1);

    // Containment lands while the pressure gate still holds the claim.
    push({ revision: 1, state: CONTAINED_STATE });
    releaseBase();
    await tick();
    expect(settled).toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith(HOLD_WARNING, {
      revision: 1,
      state: CONTAINED_STATE,
    });

    // Once healthy again the claim re-runs every gate before it is admitted.
    push({ revision: 2, state: { kind: 'healthy' } });
    await claim;
    expect(base).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it('rejects when the integrity state cannot be read instead of admitting the claim', async () => {
    const watcher = createDatabaseIntegrityWatcher({
      getState: () => Promise.reject(new Error('ipc unavailable')),
      onChanged: () => () => undefined,
    });
    const base = vi.fn(async () => {});

    await expect(
      composeIntegrityHold(base, watcher, vi.fn())({ label: 'embedding claim' })
    ).rejects.toThrow('ipc unavailable');
    expect(base).not.toHaveBeenCalled();
    watcher.dispose();
  });
});
