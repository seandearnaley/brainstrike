// @vitest-environment node

// Only explicit owners start Main's index: boot, reset resume and host-loss
// recovery. A read finding it idle refuses at once and starts nothing, so run
// admission's index-status read never waits on an open (BST-2277).
import { NativeAuthorityTransitionError } from '@brainstrike/assistant-service/node-native-text-services';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { NativeIndexSetupRequiredError } from '../native-index-setup-required';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import {
  emptyCollection,
  fixture,
  mocks,
  resetActivationFixture,
  unused,
} from './native-index-activation-fixture';

beforeEach(() => {
  resetActivationFixture();
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
});

/** The activation with each open's root restore held while `hold` is set. */
function heldOpens() {
  const held = { entered: false, hold: false, release: Promise.withResolvers<void>() };
  const application = {
    roots: {
      restoreRoots: async () => {
        if (held.hold) {
          held.entered = true;
          await held.release.promise;
        }
        return [];
      },
    },
    watches: {},
  } as unknown as ApplicationIpcDomain;
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
    expect(await lifecycleOf(f.activation)).toMatchObject({ kind: 'ready' });
    expect(await f.status()).toMatchObject({ kind: 'ready' });
    expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
  } finally {
    await f.activation.close();
  }
});

it('resume after a reset cleared the settings resolves with the index refused as setup required', async () => {
  const f = heldOpens();
  try {
    await f.activation.acquireProfile();
    await f.activation.acquire();
    await f.activation.closeNativeOwner();
    f.storage.getItem.mockResolvedValue(null as unknown as string);
    await f.activation.resume();
    expect(await lifecycleOf(f.activation)).toMatchObject({
      cause: { kind: 'setup-required' },
      kind: 'refused',
    });
    expect(f.onError).toHaveBeenCalledWith(
      'open after resume',
      expect.any(NativeIndexSetupRequiredError)
    );
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
