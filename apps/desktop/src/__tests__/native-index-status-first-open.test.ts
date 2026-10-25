// @vitest-environment node

import { beforeEach, expect, it } from 'vitest';
import type { NativeIndexActivationDependencies } from '../native-index-graph';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import { restoredRoots } from './helpers/restored-roots';
import { fixture, resetActivationFixture, unused } from './native-index-activation-fixture';

/** The host's mounted folders and their watchers, which the index borrows. */
type HostFolders = NativeIndexActivationDependencies['application'];

beforeEach(resetActivationFixture);

/** Settle every queued task, then report whether `pending` settled without the open's release. */
async function settledWithoutRelease(pending: Promise<unknown>): Promise<boolean> {
  const unsettled = Symbol('unsettled');
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return (await Promise.race([pending, Promise.resolve(unsettled)])) !== unsettled;
}

it('the host’s index status read answers preparing during the first open, never waiting for it', async () => {
  // ADR 0026: a run's admission reads this status (the host's own, ADR-0029 stage 4); the
  // first open after launch is held here.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { activation } = fixture({
    roots: restoredRoots({
      restoreRoots: async () => {
        entered.resolve();
        await release.promise;
        return [];
      },
    }),
    watches: {},
  } as unknown as HostFolders);
  const search = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: activation.rebuild,
    withRead: activation.withRead,
  });
  // Boot order: the host starts the first open before any run is admitted.
  const boot = activation.acquireRead();
  try {
    await entered.promise;
    const status = search.status();
    expect(await settledWithoutRelease(status)).toBe(true);
    await expect(status).resolves.toMatchObject({ kind: 'unavailable', phase: 'preparing' });
  } finally {
    release.resolve();
    await boot;
    await activation.close();
  }
});
