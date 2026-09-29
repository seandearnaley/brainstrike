import type { DatabaseIntegritySnapshot, DatabaseIntegrityState } from '@brainstrike/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseIntegrityWatcher,
  type DesktopDatabaseIntegrityBridge,
  getDesktopDatabaseIntegrityBridge,
  isBackgroundDatabaseWorkAdmitted,
} from '../src/database-integrity';

const contained: DatabaseIntegrityState = {
  context: 'db:query',
  kind: 'contained',
  signal: { message: 'index "idx" contains unexpected zero page', sqlstate: 'XX002' },
  since: '2026-09-29T12:00:00.000Z',
};
const healthy = (revision: number): DatabaseIntegritySnapshot => ({
  revision,
  state: { kind: 'healthy' },
});
const containedAt = (revision: number): DatabaseIntegritySnapshot => ({
  revision,
  state: contained,
});
const DISPOSED = 'Database integrity watcher was disposed.';

describe('isBackgroundDatabaseWorkAdmitted', () => {
  it('admits background database work only while the database is healthy', () => {
    expect(isBackgroundDatabaseWorkAdmitted({ kind: 'healthy' })).toBe(true);
    expect(isBackgroundDatabaseWorkAdmitted(contained)).toBe(false);
  });
});

function createHarness(read: () => Promise<DatabaseIntegritySnapshot> = async () => healthy(0)) {
  const calls: string[] = [];
  const unsubscribe = vi.fn();
  let listener: (snapshot: DatabaseIntegritySnapshot) => void = () => undefined;
  const bridge: DesktopDatabaseIntegrityBridge = {
    getState: () => {
      calls.push('getState');
      return read();
    },
    onChanged: (callback) => {
      calls.push('onChanged');
      listener = callback;
      return unsubscribe;
    },
  };
  return {
    bridge,
    calls,
    push: (snapshot: DatabaseIntegritySnapshot) => listener(snapshot),
    unsubscribe,
  };
}

function deferredRead() {
  let finish: (snapshot: DatabaseIntegritySnapshot) => void = () => undefined;
  const read = () =>
    new Promise<DatabaseIntegritySnapshot>((resolve) => {
      finish = resolve;
    });
  return { finish: (snapshot: DatabaseIntegritySnapshot) => finish(snapshot), read };
}

/** A flag that flips once `promise` settles either way. */
function settlement(promise: Promise<unknown>): { readonly done: boolean } {
  const flag = { done: false };
  const mark = (): void => {
    flag.done = true;
  };
  promise.then(mark, mark);
  return flag;
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('createDatabaseIntegrityWatcher', () => {
  it('subscribes to changes before it reads the state', async () => {
    const harness = createHarness();
    const watcher = createDatabaseIntegrityWatcher(harness.bridge);

    await watcher.current();

    expect(harness.calls).toEqual(['onChanged', 'getState']);
    watcher.dispose();
  });

  it('keeps a change pushed while the first read is in flight over the older read', async () => {
    const deferred = deferredRead();
    const harness = createHarness(deferred.read);
    const watcher = createDatabaseIntegrityWatcher(harness.bridge);

    const current = watcher.current();
    harness.push(containedAt(2));
    deferred.finish(healthy(1));

    await expect(current).resolves.toEqual(containedAt(2));
    watcher.dispose();
  });

  it('keeps and announces only snapshots newer than the one it holds', async () => {
    const harness = createHarness(async () => containedAt(3));
    const watcher = createDatabaseIntegrityWatcher(harness.bridge);
    const listener = vi.fn();
    const unsubscribe = watcher.subscribe(listener);
    await watcher.current();

    harness.push(healthy(2));
    harness.push(healthy(3));
    harness.push(healthy(4));
    unsubscribe();
    harness.push(containedAt(5));

    expect(listener.mock.calls).toEqual([[containedAt(3)], [healthy(4)]]);
    await expect(watcher.current()).resolves.toEqual(containedAt(5));
    watcher.dispose();
  });

  it('rejects current() when the read fails and reads again on the next call', async () => {
    const read = vi
      .fn<() => Promise<DatabaseIntegritySnapshot>>()
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValueOnce(healthy(4));
    const watcher = createDatabaseIntegrityWatcher(createHarness(read).bridge);

    await expect(watcher.current()).rejects.toThrow('ipc unavailable');
    await expect(watcher.current()).resolves.toEqual(healthy(4));
    watcher.dispose();
  });

  describe('waitUntilBackgroundAdmitted', () => {
    it('resolves immediately while the database is healthy', async () => {
      const watcher = createDatabaseIntegrityWatcher(createHarness().bridge);

      await expect(watcher.waitUntilBackgroundAdmitted()).resolves.toBeUndefined();
      watcher.dispose();
    });

    it('stays pending while contained and resolves when a healthy snapshot arrives', async () => {
      const harness = createHarness(async () => containedAt(1));
      const watcher = createDatabaseIntegrityWatcher(harness.bridge);
      await watcher.current();

      const wait = watcher.waitUntilBackgroundAdmitted();
      const settled = settlement(wait);
      await tick();
      expect(settled.done).toBe(false);

      harness.push(healthy(2));
      await expect(wait).resolves.toBeUndefined();
      watcher.dispose();
    });

    it('hands out one shared promise per non-admitted episode and a new one for the next', async () => {
      const harness = createHarness(async () => containedAt(1));
      const watcher = createDatabaseIntegrityWatcher(harness.bridge);
      await watcher.current();

      const first = watcher.waitUntilBackgroundAdmitted();
      expect(watcher.waitUntilBackgroundAdmitted()).toBe(first);
      harness.push(healthy(2));
      await first;
      harness.push(containedAt(3));

      const next = watcher.waitUntilBackgroundAdmitted();
      expect(next).not.toBe(first);
      expect(watcher.waitUntilBackgroundAdmitted()).toBe(next);
      watcher.dispose();
      await expect(next).rejects.toThrow(DISPOSED);
    });
  });

  describe('dispose', () => {
    it('unsubscribes from the bridge and rejects a pending wait', async () => {
      const harness = createHarness(async () => containedAt(1));
      const watcher = createDatabaseIntegrityWatcher(harness.bridge);
      await watcher.current();
      const wait = watcher.waitUntilBackgroundAdmitted();

      watcher.dispose();

      await expect(wait).rejects.toThrow(DISPOSED);
      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('rejects reads and waits made after it was disposed', async () => {
      const watcher = createDatabaseIntegrityWatcher(createHarness().bridge);
      watcher.dispose();

      await expect(watcher.current()).rejects.toThrow(DISPOSED);
      await expect(watcher.waitUntilBackgroundAdmitted()).rejects.toThrow(DISPOSED);
    });
  });
});

describe('getDesktopDatabaseIntegrityBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null without a window or when the preload did not expose the capability', () => {
    expect(getDesktopDatabaseIntegrityBridge()).toBeNull();
    vi.stubGlobal('window', {});
    expect(getDesktopDatabaseIntegrityBridge()).toBeNull();
  });

  it('returns the bridge the preload exposed', () => {
    const { bridge } = createHarness();
    vi.stubGlobal('window', { databaseIntegrity: bridge });

    expect(getDesktopDatabaseIntegrityBridge()).toBe(bridge);
  });
});
