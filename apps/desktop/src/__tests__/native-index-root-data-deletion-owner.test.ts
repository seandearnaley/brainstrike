// @vitest-environment node
import { beforeEach, expect, it } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import {
  emptyCollection,
  fixture,
  mocks,
  resetActivationFixture,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

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
    expect(mocks.close).toHaveBeenCalledOnce();
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

it('destroys retained native content while preserving the profile for its catalog clear', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation } = fixture();
  try {
    await activation.acquire();
    await activation.destroyNativeOwner();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    await expect(activation.acquire()).rejects.toMatchObject({ code: 'native-index-closed' });
    expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
  } finally {
    await activation.close();
  }
});
