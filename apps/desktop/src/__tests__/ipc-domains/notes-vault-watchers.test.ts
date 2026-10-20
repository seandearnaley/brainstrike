/**
 * BST-2244: Main's Notes Vault watcher owner joins every native subscribe and
 * unsubscribe before its shutdown dispose resolves, and admits no watch after
 * it. A @parcel/watcher operation still on the libuv pool when Electron frees
 * Main's Node environment aborts Main.
 */

import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  disposeAllNotesVaultWatchers,
  liveNotesVaultWatcherCountForTest,
  NOTES_VAULT_WATCH_OWNER_DESTROYED,
  NOTES_VAULT_WATCHERS_SHUT_DOWN,
  reopenNotesVaultWatchAdmission,
  type StartNotesVaultNativeWatch,
  startNotesVaultWatch,
  unwatchNotesVaultWatcher,
} from '../../notes-vault-watchers';

/** A minimal WebContents stand-in with the one lifecycle event the owner uses. */
class FakeOwner {
  private destroyed = false;
  private readonly destroyedListeners: (() => void)[] = [];

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: string, listener: () => void): void {
    if (event === 'destroyed') {
      this.destroyedListeners.push(listener);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const listener of this.destroyedListeners.splice(0)) {
      listener();
    }
  }
}

function asWebContents(owner: FakeOwner): WebContents {
  return owner as unknown as WebContents;
}

/** A native disposer whose unsubscribe settles only when the test says so. */
function heldStop(): { readonly release: () => void; readonly stop: () => Promise<void> } {
  const unsubscribe = Promise.withResolvers<void>();
  return { release: () => unsubscribe.resolve(), stop: vi.fn(() => unsubscribe.promise) };
}

/**
 * A native disposer whose next `failures` unsubscribes reject with `failure`.
 * `released` counts the unsubscribes that succeeded.
 */
function flakyNativeStop(
  failure: Error,
  failures: number
): {
  readonly released: () => number;
  readonly stop: Mock<() => Promise<void>>;
  readonly succeedFromNowOn: () => void;
} {
  let remainingFailures = failures;
  let released = 0;
  return {
    released: () => released,
    stop: vi.fn(() => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return Promise.reject(failure);
      }
      released += 1;
      return Promise.resolve();
    }),
    succeedFromNowOn: () => {
      remainingFailures = 0;
    },
  };
}

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Observes whether `promise` has settled, without consuming its rejection. */
function trackSettlement(promise: Promise<void>): {
  readonly promise: Promise<void>;
  readonly settled: () => boolean;
} {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  return { promise, settled: () => settled };
}

afterEach(async () => {
  await disposeAllNotesVaultWatchers();
  reopenNotesVaultWatchAdmission();
});

describe('Notes Vault watcher owner shutdown (BST-2244)', () => {
  it('resolves the dispose only after every native watcher has been unsubscribed', async () => {
    const held = heldStop();
    const owner = new FakeOwner(1);
    await expect(
      startNotesVaultWatch(asWebContents(owner), 'w1', () => Promise.resolve(held.stop))
    ).resolves.toEqual({ status: 'started' });

    const disposing = trackSettlement(disposeAllNotesVaultWatchers());
    await vi.waitFor(() => expect(held.stop).toHaveBeenCalledOnce());
    await flushMacrotask();
    expect(disposing.settled()).toBe(false);

    held.release();
    await disposing.promise;
    expect(liveNotesVaultWatcherCountForTest()).toBe(0);
  });

  it('joins a watch whose native subscription is still starting, then retires it', async () => {
    const acquisition = Promise.withResolvers<() => Promise<void>>();
    const held = heldStop();
    const owner = new FakeOwner(2);
    const started = startNotesVaultWatch(asWebContents(owner), 'w2', () => acquisition.promise);

    const disposing = trackSettlement(disposeAllNotesVaultWatchers());
    await flushMacrotask();
    expect(disposing.settled()).toBe(false);

    acquisition.resolve(held.stop);
    await vi.waitFor(() => expect(held.stop).toHaveBeenCalledOnce());
    await flushMacrotask();
    expect(disposing.settled()).toBe(false);

    held.release();
    await disposing.promise;
    await expect(started).resolves.toEqual({
      error: NOTES_VAULT_WATCHERS_SHUT_DOWN,
      status: 'refused',
    });
  });

  it('joins a renderer reaper retirement that is still in flight', async () => {
    const held = heldStop();
    const owner = new FakeOwner(3);
    await startNotesVaultWatch(asWebContents(owner), 'w3', () => Promise.resolve(held.stop));

    owner.destroy();
    await vi.waitFor(() => expect(held.stop).toHaveBeenCalledOnce());
    expect(liveNotesVaultWatcherCountForTest()).toBe(0);
    const disposing = trackSettlement(disposeAllNotesVaultWatchers());
    await flushMacrotask();
    expect(disposing.settled()).toBe(false);

    held.release();
    await disposing.promise;
  });

  it('joins an unwatch retirement that is still in flight', async () => {
    const held = heldStop();
    const owner = new FakeOwner(4);
    await startNotesVaultWatch(asWebContents(owner), 'w4', () => Promise.resolve(held.stop));

    expect(unwatchNotesVaultWatcher('w4', owner.id)).toBe(true);
    await vi.waitFor(() => expect(held.stop).toHaveBeenCalledOnce());
    const disposing = trackSettlement(disposeAllNotesVaultWatchers());
    await flushMacrotask();
    expect(disposing.settled()).toBe(false);

    held.release();
    await disposing.promise;
  });

  it('admits no watch after the terminal dispose has begun', async () => {
    const start = vi.fn<StartNotesVaultNativeWatch>(() => Promise.resolve(() => Promise.resolve()));
    const disposing = disposeAllNotesVaultWatchers();

    await expect(
      startNotesVaultWatch(asWebContents(new FakeOwner(5)), 'w5', start)
    ).resolves.toEqual({ error: NOTES_VAULT_WATCHERS_SHUT_DOWN, status: 'refused' });
    expect(start).not.toHaveBeenCalled();
    expect(liveNotesVaultWatcherCountForTest()).toBe(0);
    await disposing;
  });

  it('starts nothing for an owner already destroyed', async () => {
    const owner = new FakeOwner(6);
    owner.destroy();
    const start = vi.fn<StartNotesVaultNativeWatch>();

    await expect(startNotesVaultWatch(asWebContents(owner), 'w6', start)).resolves.toEqual({
      error: NOTES_VAULT_WATCH_OWNER_DESTROYED,
      status: 'refused',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('retires the native subscription a ParcelWatchRetirementError still owns', async () => {
    const retire = vi.fn(() => Promise.resolve());
    const failure = new ParcelWatchRetirementError(
      [new Error('subscribe timed out'), new Error('late unsubscribe failed')],
      retire
    );
    const started = await startNotesVaultWatch(asWebContents(new FakeOwner(7)), 'w7', () =>
      Promise.reject(failure)
    );

    expect(started).toEqual({ error: failure, status: 'failed' });
    await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
    expect(liveNotesVaultWatcherCountForTest()).toBe(0);
  });

  it('rejects the dispose with a failed native unsubscribe after every other retirement settles', async () => {
    const failure = new Error('native unsubscribe failed');
    const failing = flakyNativeStop(failure, 1);
    const held = heldStop();
    const owner = asWebContents(new FakeOwner(8));
    await startNotesVaultWatch(owner, 'w8a', () => Promise.resolve(failing.stop));
    await startNotesVaultWatch(owner, 'w8b', () => Promise.resolve(held.stop));

    const disposing = trackSettlement(disposeAllNotesVaultWatchers());
    await vi.waitFor(() => expect(held.stop).toHaveBeenCalledOnce());
    await flushMacrotask();
    expect(disposing.settled()).toBe(false);

    held.release();
    await expect(disposing.promise).rejects.toMatchObject({ errors: [failure] });
  });
});

describe('Notes Vault watcher owner keeps a failed retirement until its unsubscribe succeeds (BST-2248)', () => {
  const failure = new Error('native unsubscribe failed');

  it.each([
    [
      'an unwatch',
      (owner: FakeOwner) => expect(unwatchNotesVaultWatcher('w9', owner.id)).toBe(true),
    ],
    ['a renderer reaper', (owner: FakeOwner) => owner.destroy()],
  ])('retries %s retirement that failed in the terminal dispose', async (_remover, remove) => {
    const native = flakyNativeStop(failure, 1);
    const owner = new FakeOwner(9);
    await startNotesVaultWatch(asWebContents(owner), 'w9', () => Promise.resolve(native.stop));

    remove(owner);
    await vi.waitFor(() => expect(native.stop).toHaveBeenCalledOnce());
    await flushMacrotask();
    await disposeAllNotesVaultWatchers();

    expect(native.stop).toHaveBeenCalledTimes(2);
    expect(native.released()).toBe(1);
  });

  it('retries a terminal dispose whose unsubscribe failed in the next terminal dispose', async () => {
    const native = flakyNativeStop(failure, 1);
    await startNotesVaultWatch(asWebContents(new FakeOwner(10)), 'w10', () =>
      Promise.resolve(native.stop)
    );

    await expect(disposeAllNotesVaultWatchers()).rejects.toMatchObject({ errors: [failure] });
    await disposeAllNotesVaultWatchers();
    await disposeAllNotesVaultWatchers();

    expect(native.stop).toHaveBeenCalledTimes(2);
    expect(native.released()).toBe(1);
  });

  it('rejects the terminal dispose with a retirement that fails on every attempt, and keeps owning it', async () => {
    const native = flakyNativeStop(failure, Number.POSITIVE_INFINITY);
    const owner = new FakeOwner(11);
    await startNotesVaultWatch(asWebContents(owner), 'w11', () => Promise.resolve(native.stop));
    expect(unwatchNotesVaultWatcher('w11', owner.id)).toBe(true);
    await vi.waitFor(() => expect(native.stop).toHaveBeenCalledOnce());
    await flushMacrotask();

    // One retry per terminal dispose, never a loop.
    await expect(disposeAllNotesVaultWatchers()).rejects.toMatchObject({ errors: [failure] });
    expect(native.stop).toHaveBeenCalledTimes(2);
    await expect(disposeAllNotesVaultWatchers()).rejects.toMatchObject({ errors: [failure] });
    expect(native.stop).toHaveBeenCalledTimes(3);
    expect(native.released()).toBe(0);

    native.succeedFromNowOn();
    await disposeAllNotesVaultWatchers();
    expect(native.released()).toBe(1);
  });
});
