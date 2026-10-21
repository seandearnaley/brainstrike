// @vitest-environment node

import { beforeEach, expect, it } from 'vitest';
import { productionDesktopCapabilities } from '../agent-host-platform/production-desktop-capabilities';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import { admissionCatalogFixture } from './fixtures/admission-catalog';
import {
  emptyCollection,
  fixture,
  mocks,
  resetActivationFixture,
  unused,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

/** Settle every queued task, then report whether `pending` settled without the open's release. */
async function settledWithoutRelease(pending: Promise<unknown>): Promise<boolean> {
  const unsettled = Symbol('unsettled');
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return (await Promise.race([pending, Promise.resolve(unsettled)])) !== unsettled;
}

it('the admission’s index status read answers preparing during the first open, never waiting for it', async () => {
  // ADR 0026: a run's admission reads this status; the first open after launch is held here.
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { activation } = fixture({
    roots: {
      restoreRoots: async () => {
        entered.resolve();
        await release.promise;
        return [];
      },
    },
    watches: {},
  } as unknown as ApplicationIpcDomain);
  const admission = productionDesktopCapabilities({
    ...admissionCatalogFixture(() => []).services,
    nativeIndexSearch: createNativeScopedSearchCapability({
      openQuery: unused,
      rebuild: activation.rebuild,
      withRead: activation.withRead,
    }),
    resolveForgeService: () => null,
    resolveWorktreeService: () => null,
  }).admission;
  // Boot order: Main starts the first open before the agent host exists (main.ts acquireRead).
  const boot = activation.acquireRead();
  try {
    await entered.promise;
    const status = admission.indexStatus(new AbortController().signal);
    expect(await settledWithoutRelease(status)).toBe(true);
    await expect(status).resolves.toMatchObject({ kind: 'unavailable', phase: 'preparing' });
  } finally {
    release.resolve();
    await boot;
    await activation.close();
  }
});
