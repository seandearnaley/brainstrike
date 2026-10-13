// @vitest-environment node

import { OwnedHostStartError } from '@brainstrike/host-lease';
// Profile admission and the agent host's lifecycle under the native index
// activation: replacement starts, failed and lost hosts, reset resume and
// terminal retirement. Moved from native-index-activation.test.ts unchanged.
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import {
  emptyCollection,
  fixture,
  mocks,
  resetActivationFixture,
  saveSettingsChange,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

it.each(['cancelled', 'startup-failed', 'cleanup-failed'] as const)(
  'joins replacement host startup on quit and preserves %s outcomes',
  async (outcome) => {
    const { activation } = fixture();
    const quit = new AbortController();
    const starting = Promise.withResolvers<void>();
    const physicalExit = Promise.withResolvers<void>();
    const unrelated = new Error('Independent host startup failure');
    const cleanupFailure = new Error('Physical host close failed');
    mocks.acquireProfile.mockReturnValueOnce(starting.promise);
    mocks.closeProfile.mockImplementationOnce(async (reason: unknown) => {
      starting.reject(outcome === 'startup-failed' ? unrelated : reason);
      await physicalExit.promise;
      if (outcome === 'cleanup-failed') {
        throw cleanupFailure;
      }
    });
    let settled = false;
    const resuming = activation.resume(quit.signal);
    const result = resuming.then(
      () => {
        settled = true;
        return;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    onTestFinished(async () => {
      quit.abort(new Error('Test cleanup'));
      physicalExit.resolve();
      starting.reject(quit.signal.reason);
      await result;
    });
    await vi.waitFor(() => expect(mocks.acquireProfile).toHaveBeenCalledOnce());
    quit.abort(new Error('Terminal quit'));
    await vi.waitFor(() => expect(mocks.closeProfile).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    physicalExit.resolve();
    const failure = await result;
    if (outcome === 'cleanup-failed') {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([quit.signal.reason, cleanupFailure]);
    } else {
      expect(failure).toBe(outcome === 'startup-failed' ? unrelated : quit.signal.reason);
    }
    expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
    await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
  }
);

it('refuses reset resume before profile admission when quit is already terminal', async () => {
  const { activation } = fixture();
  const quit = new AbortController();
  quit.abort(new Error('Terminal quit'));
  await expect(activation.resume(quit.signal)).rejects.toBe(quit.signal.reason);
  expect(mocks.createProfileOwner).not.toHaveBeenCalled();
});

it('retains the assistant profile through index settings replacement and rebuild until terminal close', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, storage } = fixture();
  try {
    await activation.acquireProfile();
    await activation.acquire();
    await saveSettingsChange(storage, { indexingPolicyPreset: 'full-root' });
    await activation.reconfigure();
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    await activation.rebuild();
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    await activation.acquireProfile();
  } finally {
    await activation.close();
  }
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
});

it('closes only the native owner for a root-data deletion and resumes on the same profile', async () => {
  // BST-2001: the profile's attachment is the agent host, so a deletion that
  // retired it replaced the host and interrupted its runs.
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation } = fixture();
  try {
    await activation.acquireProfile();
    await activation.acquire();
    await activation.closeNativeOwner();
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    await activation.resume();
    await activation.acquire();
    expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
    expect(mocks.closeProfile).not.toHaveBeenCalled();
  } finally {
    await activation.close();
  }
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
});

it('retries a failed host start once that host has released Root; Main retirement stays terminal', async () => {
  const { activation } = fixture();
  try {
    // The failed start's rollback closes its platform, which releases Root capabilities.
    mocks.acquireProfile.mockImplementationOnce(async () => {
      await activation.closeRootCapabilities();
      throw new OwnedHostStartError({ reason: 'deadline' }, new Error('Host startup timed out'));
    });
    await expect(activation.acquireProfile()).resolves.toBeUndefined();
    expect(mocks.createProfileOwner).toHaveBeenCalledTimes(2);
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
  } finally {
    await activation.close();
  }
  await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
});

it('relaunches a ready host that was lost once its Root release has run (BST-2004)', async () => {
  const { activation } = fixture();
  try {
    await activation.acquireProfile();
    // The host exits unasked; its platform closes, which releases Root capabilities.
    mocks.loseHost();
    await activation.closeRootCapabilities();
    await expect(activation.acquireProfile()).resolves.toBeUndefined();
    expect(mocks.createProfileOwner).toHaveBeenCalledTimes(2);
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
  } finally {
    await activation.close();
  }
  await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
});

it('joins the lost host Root release before relaunching when a client asks first (BST-2004)', async () => {
  const { activation } = fixture();
  try {
    await activation.acquireProfile();
    mocks.loseHost();
    // A client reconnects before the lost host's platform has closed: retiring
    // that owner closes its platform, which releases Root, before the next host.
    mocks.closeProfile.mockImplementationOnce(async () => {
      await activation.closeRootCapabilities();
    });
    await expect(activation.acquireProfile()).resolves.toBeUndefined();
    expect(mocks.createProfileOwner).toHaveBeenCalledTimes(2);
    expect(mocks.closeProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createProfileOwner.mock.invocationCallOrder[1] ?? 0
    );
  } finally {
    await activation.close();
  }
});

it('keeps Main retirement terminal when a starting host fails and releases Root under it', async () => {
  const { activation } = fixture();
  const starting = Promise.withResolvers<void>();
  const failing = Promise.withResolvers<void>();
  mocks.acquireProfile.mockImplementationOnce(async () => {
    starting.resolve();
    await failing.promise;
    // The failed start's rollback closes its platform, which releases Root capabilities.
    await activation.closeRootCapabilities();
    throw new Error('MCP is unavailable: the agent host is not running.');
  });
  const connecting = activation.acquireProfile();
  await starting.promise;
  // App shutdown begins while the host is still starting.
  const closing = activation.close();
  failing.resolve();
  await expect(connecting).rejects.toThrow('MCP is unavailable');
  await closing;
  expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
});

it('keeps the second owned startup failure sticky on later passive admission', async () => {
  const { activation } = fixture();
  const first = new OwnedHostStartError(
    { reason: 'deadline' },
    new Error('First startup deadline')
  );
  const second = new OwnedHostStartError(
    { exitCode: 1, reason: 'exit' },
    new Error('Replacement exited before ready')
  );
  try {
    mocks.acquireProfile.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    await expect(activation.acquireProfile()).rejects.toBe(second);
    await expect(activation.acquireProfile()).rejects.toBe(second);
    expect(mocks.createProfileOwner).toHaveBeenCalledTimes(2);
  } finally {
    await activation.close();
  }
});

it('rearms a failed host only through explicit reconnect and refuses reconnect after terminal close', async () => {
  const { activation } = fixture();
  await activation.acquireProfile();
  mocks.loseHost();
  await activation.closeRootCapabilities();
  await activation.acquireProfile();
  mocks.loseHost();
  await activation.closeRootCapabilities();
  await expect(activation.acquireProfile()).rejects.toMatchObject({ code: 'process.lost' });
  await expect(activation.acquireProfile({ reconnect: true })).resolves.toBeUndefined();
  expect(mocks.createProfileOwner).toHaveBeenCalledTimes(3);
  await activation.close();
  await expect(activation.acquireProfile({ reconnect: true })).rejects.toMatchObject({
    code: 'native-index-closed',
  });
  expect(mocks.createProfileOwner).toHaveBeenCalledTimes(3);
});
