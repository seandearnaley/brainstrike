// @vitest-environment node

// Only explicit owners start Main's index: boot, reset resume and host-loss
// recovery. A read finding it idle refuses at once and starts nothing, so run
// admission's index-status read never waits on an open (BST-2277).
import { NativeAuthorityTransitionError } from '@brainstrike/assistant-service/node-native-text-services';
import { beforeEach, expect, it, vi } from 'vitest';
import type { NativeIndexActivationDependencies } from '../native-index-graph';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import { unreadableSettings } from './helpers/native-index-settings';
import { restoredRoots } from './helpers/restored-roots';
import { fixture, mocks, resetActivationFixture, unused } from './native-index-activation-fixture';

/** The host's mounted folders and their watchers, which the index borrows. */
type HostFolders = NativeIndexActivationDependencies['application'];

beforeEach(resetActivationFixture);

/** The activation with each open's root restore held while `hold` is set. */
function heldOpens() {
  const held = { entered: false, hold: false, release: Promise.withResolvers<void>() };
  const application = {
    roots: restoredRoots({
      restoreRoots: async () => {
        if (held.hold) {
          held.entered = true;
          await held.release.promise;
        }
        return [];
      },
    }),
    watches: {},
  } as unknown as HostFolders;
  const f = fixture(application);
  const status = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  }).status;
  return { ...f, held, status };
}

/** The lifecycle's current observation. */
async function lifecycleOf(activation: ReturnType<typeof fixture>['activation']) {
  const stop = new AbortController();
  const current = Promise.withResolvers<unknown>();
  activation.observeLifecycle(current.resolve, stop.signal).catch(() => undefined);
  try {
    return await current.promise;
  } finally {
    stop.abort();
  }
}

/** Lets an open that was started reach its root restore: the fixture's ports answer at once. */
async function drainTurns(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

it('a host borrow does not start an index it did not resume (BST-1977)', async () => {
  const f = heldOpens();
  f.held.hold = true;
  try {
    await f.activation.acquireProfile();
    await drainTurns();
    expect(f.held.entered).toBe(false);
    expect(await lifecycleOf(f.activation)).toMatchObject({ generation: 0, kind: 'preparing' });
  } finally {
    f.held.release.resolve();
    await f.activation.close();
  }
});

it('a read of an idle index refuses as preparing at once and starts no open', async () => {
  const f = heldOpens();
  f.held.hold = true;
  let observed: unknown;
  const reading = f.status().then((value) => {
    observed = value;
  });
  const reads = f.activation.withRead(unused).catch((error: unknown) => error);
  try {
    await vi.waitFor(() =>
      expect(observed).toMatchObject({
        cause: { kind: 'transitioning' },
        kind: 'unavailable',
        phase: 'preparing',
      })
    );
    expect(await reads).toBeInstanceOf(NativeAuthorityTransitionError);
    expect(f.held.entered).toBe(false);
    expect(mocks.acquire).not.toHaveBeenCalled();
  } finally {
    f.held.release.resolve();
    await reading;
    await f.activation.close();
  }
});

it('resume opens the index from its saved settings', async () => {
  const f = heldOpens();
  try {
    await f.activation.acquireProfile();
    await f.activation.acquire();
    await f.activation.closeNativeOwner();
    await f.activation.resume();
    await vi.waitFor(async () =>
      expect(await lifecycleOf(f.activation)).toMatchObject({ kind: 'ready' })
    );
    expect(await f.status()).toMatchObject({ kind: 'ready' });
    expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
  } finally {
    await f.activation.close();
  }
});

it('resume returns without waiting for the open it starts, so quit never joins it', async () => {
  // A content clear keeps live settings: its resumed open starts the indexer, which quit's
  // cancellation of the reset must not wait for.
  const f = heldOpens();
  const quit = new AbortController();
  try {
    await f.activation.acquireProfile();
    await f.activation.acquire();
    await f.activation.closeNativeOwner();
    f.held.hold = true;
    let resumed = false;
    const resuming = f.activation.resume(quit.signal).then(() => {
      resumed = true;
    });
    await vi.waitFor(() => expect(f.held.entered).toBe(true));
    await vi.waitFor(() => expect(resumed).toBe(true));
    quit.abort(new Error('Terminal quit'));
    await resuming;
  } finally {
    f.held.release.resolve();
    await f.activation.close();
  }
});

it('quit after a content clear settles without waiting for the held reopen', async () => {
  // A content clear keeps live settings, so its resumed open starts the indexer, which
  // cannot be cancelled. Quit joins the accepted deletion but cancels replacement startup.
  const f = heldOpens();
  const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
  const reset = createDesktopFactoryResetHandler({
    clearRetainedContent: async () => {
      await f.activation.destroyNativeOwner();
      f.held.hold = true;
      return { deletedChunks: 0, deletedFiles: 0 };
    },
    completeSuccessfulReset: async () => undefined,
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    prepareDatabaseProfileReset: unused,
    resetLocalDatabase: unused,
    resetPersistentStorageAfterDataDeletion: unused,
    resumeAfterReset: async (outcome, signal) => {
      if (outcome === 'succeeded') {
        await f.activation.resume(signal);
      }
    },
    runtimes: [],
    sessionDataPath: '/owned/session-data',
    userDataPath: '/owned/user-data',
  });
  try {
    await f.activation.acquireProfile();
    await f.activation.acquire();
    const clearing = reset.clearContent();
    await vi.waitFor(() => expect(f.held.entered).toBe(true));
    let closed = false;
    const quitting = reset.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(closed).toBe(true));
    await quitting;
    await expect(clearing).resolves.toMatchObject({ success: true });
  } finally {
    f.held.release.resolve();
    await f.activation.close();
  }
});

it('acquire after resume joins the open that resume started', async () => {
  // Root-data deletion resumes, then acquires: the index must serve again, not refuse.
  const f = heldOpens();
  try {
    await f.activation.acquireProfile();
    await f.activation.acquire();
    await f.activation.closeNativeOwner();
    f.held.hold = true;
    await f.activation.resume();
    await vi.waitFor(() => expect(f.held.entered).toBe(true));
    const acquiring = f.activation.acquire();
    acquiring.catch(() => undefined);
    f.held.release.resolve();
    await expect(acquiring).resolves.toBeDefined();
    expect(await lifecycleOf(f.activation)).toMatchObject({ kind: 'ready' });
  } finally {
    f.held.release.resolve();
    await f.activation.close();
  }
});

it('resume resolves with the index refused when the saved settings cannot be read', async () => {
  const f = heldOpens();
  try {
    await f.activation.acquireProfile();
    await f.activation.acquire();
    await f.activation.closeNativeOwner();
    const unreadable = unreadableSettings();
    f.settings.mockRejectedValue(unreadable);
    await f.activation.resume();
    await vi.waitFor(async () =>
      expect(await lifecycleOf(f.activation)).toMatchObject({
        cause: { kind: 'settings-invalid' },
        kind: 'refused',
      })
    );
    await vi.waitFor(() => expect(f.onError).toHaveBeenCalledWith('open after resume', unreadable));
  } finally {
    await f.activation.close();
  }
});

it('reopens the index once a lost host relaunches, without holding the host borrow (BST-2004)', async () => {
  const f = heldOpens();
  try {
    await f.activation.acquireProfile();
    await f.activation.acquire();
    // The host exits unasked; its platform closes, which releases Root capabilities.
    mocks.loseHost();
    await f.activation.closeRootCapabilities();
    f.held.hold = true;
    let relaunched = false;
    const relaunch = f.activation.acquireProfile().then(() => {
      relaunched = true;
    });
    await vi.waitFor(() => expect(f.held.entered).toBe(true));
    await vi.waitFor(() => expect(relaunched).toBe(true));
    expect(await f.status()).toMatchObject({ kind: 'unavailable', phase: 'preparing' });
    f.held.release.resolve();
    await relaunch;
    await vi.waitFor(async () =>
      expect(await lifecycleOf(f.activation)).toMatchObject({ kind: 'ready' })
    );
    expect(await f.status()).toMatchObject({ kind: 'ready' });
    expect(mocks.createProfileOwner).toHaveBeenCalledTimes(2);
  } finally {
    f.held.release.resolve();
    await f.activation.close();
  }
});
