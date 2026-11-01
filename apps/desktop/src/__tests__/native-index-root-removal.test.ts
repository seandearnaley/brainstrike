// @vitest-environment node
/**
 * A folder removed while the index opens: the open lists the folders, reads the catalog and
 * borrows each folder, then its sources borrow each again, and a removal can arrive between any
 * of those steps. The agent host's registry removes the folder first; Main's index handles then
 * follow the host's mounts (D1). The index ends serving the folders left once Main re-reads
 * them, and nothing untyped crosses meanwhile.
 */

import {
  createNativeScopedSearchCapability,
  NativeAuthorityTransitionError,
} from '@brainstrike/assistant-service/node-native-text-services';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { CanonicalRemoteWorkspaceDependencies } from '../canonical-utility-parent';
import { canonicalError, canonicalFault } from '../canonical-utility-protocol';
import { IndexSourceRoots } from '../ipc-domains/index-source-roots';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeRootDataDeletion } from '../native-root-data-deletion';
import { createNativeRootRegistration } from '../native-root-registration';
import {
  createRegistry,
  createRegistryCatalogRequest,
  rootHandle,
  secureRoot,
} from './ipc-domains/workspace-root-registry-test-helpers';
import {
  emptyWorkspace,
  fixture,
  mocks,
  resetActivationFixture,
  unused,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

/** A held step: `entered` resolves once the work reaches it, `release` lets it go on. */
function gate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    pass: async () => {
      entered.resolve();
      await released.promise;
    },
    release: () => released.resolve(),
  };
}

async function twoFolders() {
  const catalog = createRegistryCatalogRequest();
  // The host's root registry writes the folders; Main's index handles follow its mounts.
  const registry = createRegistry({}, catalog);
  const roots = new IndexSourceRoots({
    createSecureRoot: async (rootPath) => secureRoot(rootPath),
    readMountedRoots: async () => registry.mountedRoots(),
  });
  /** The host removes the folder, then tells Main, whose handles follow (D1). */
  const remove = async (rootId: string): Promise<void> => {
    await registry.removeRoot(rootId);
    await roots.followHost();
  };
  const alpha = await registry.addRoot(rootHandle('/work/alpha'));
  const bravo = await registry.addRoot(rootHandle('/work/bravo'));
  const holds: {
    listing?: ReturnType<typeof gate> | undefined;
    scan?: { readonly rootId: string; scanning?: CanonicalRemoteWorkspaceDependencies } | undefined;
  } = {};
  // The index reads the same catalog the registry writes.
  mocks.catalog.workspaceRoots.mockImplementation(async (request) => {
    const listing = request.operation === 'list' ? holds.listing : undefined;
    if (listing) {
      holds.listing = undefined;
      await listing.pass();
    }
    return catalog(request);
  });
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
      if (holds.scan?.rootId !== dependencies.source.lease.rootId) {
        return emptyWorkspace(dependencies);
      }
      // The utility attached this folder and is still scanning it.
      holds.scan.scanning = dependencies;
      return { close: async () => {}, trigger: unused };
    }
  );
  const f = fixture({
    roots,
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain);
  const transitions = createNativeRootDataDeletion({
    acquire: unused,
    captureOwner: unused,
    closeOwner: unused,
    deleteRootData: unused,
    resume: unused,
    stopSources: unused,
  });
  const reported: unknown[] = [];
  const registration = createNativeRootRegistration({
    isShuttingDown: () => false,
    reconfigureRoots: () => f.activation.reconfigureRoots(),
    reportError: (_message, error) => reported.push(error),
    transition: transitions.transition,
  });
  const search = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  });
  onTestFinished(async () => {
    await f.activation.close();
    await roots.close();
    await registry.dispose();
  });
  return {
    activation: f.activation,
    alpha,
    bravo,
    /** Hold the index's next catalog listing. */
    holdListing: () => {
      holds.listing = gate();
      return holds.listing;
    },
    /** Leave `rootId`'s next scan running; returns what the utility reports to while it runs. */
    holdScan: (rootId: string) => {
      const held: NonNullable<typeof holds.scan> = { rootId };
      holds.scan = held;
      return held;
    },
    onError: f.onError,
    registration,
    registry,
    remove,
    reported,
    roots,
    /** The folders the index serves, as the Search panel's status reads them. */
    served: async () => {
      const status = await search.status();
      return status.kind === 'ready'
        ? status.rootReadiness.map((root) => root.rootId).sort()
        : status;
    },
  };
}

/** What a failure reported to the person's log says: a replaced generation, never untyped. */
const replacedGeneration = { refusal: { kind: 'transitioning' } };

it('a folder removed while an open reads the catalog is removed after its borrows, failing nothing', async () => {
  const folders = await twoFolders();
  await folders.registration.rootsRegistered();
  expect(await folders.served()).toEqual([folders.alpha.rootId, folders.bravo.rootId].sort());

  const listing = folders.holdListing();
  const registered = folders.registration.rootsRegistered().catch((error: unknown) => error);
  await listing.entered;
  const removed = folders.remove(folders.bravo.rootId);
  listing.release();
  await removed;
  await registered;
  // Main re-reads the committed folders after a removal, as it does after an addition.
  await folders.registration.rootsRegistered();

  expect(await folders.served()).toEqual([folders.alpha.rootId]);
  for (const error of folders.reported) {
    expect(error).toMatchObject(replacedGeneration);
  }
});

it('quit during an open closes the folder registry cleanly, the open answering its retirement', async () => {
  const folders = await twoFolders();
  const listing = folders.holdListing();
  const registered = folders.registration.rootsRegistered().catch((error: unknown) => error);
  await listing.entered;
  // Quit fences native work, then closes the index's folder handles behind the open's borrows.
  folders.activation.fenceTerminal();
  const prepared = folders.roots.close();
  listing.release();
  await expect(prepared).resolves.toBeUndefined();
  await registered;
});

it('a folder removed while its sources borrow it answers with its retirement', async () => {
  const folders = await twoFolders();
  const borrow = folders.roots.borrowSourceRoot.bind(folders.roots);
  let removed: Promise<void> | undefined;
  // The open's own borrows are in; its sources borrow each folder again. The host removes the
  // second folder between the two source borrows, and Main's handles follow before it is asked.
  folders.roots.borrowSourceRoot = async (rootId, subscribe) => {
    const lease = await borrow(rootId, subscribe);
    if (rootId === folders.alpha.rootId && !removed) {
      removed = folders.remove(folders.bravo.rootId);
      await removed;
    }
    return lease;
  };
  const registered = folders.registration.rootsRegistered().catch((error: unknown) => error);
  await registered;
  await removed;

  await folders.registration.rootsRegistered();
  expect(await folders.served()).toEqual([folders.alpha.rootId]);
  expect(folders.reported).not.toEqual([]);
  for (const error of folders.reported) {
    expect(error).toMatchObject(replacedGeneration);
  }
});

it('a folder removed during its scan answers with its retirement, though the utility reports it untyped', async () => {
  const folders = await twoFolders();
  const scan = folders.holdScan(folders.bravo.rootId);
  const registered = folders.registration.rootsRegistered().catch((error: unknown) => error);
  await vi.waitFor(() => expect(scan.scanning).toBeDefined());
  await folders.remove(folders.bravo.rootId);
  // The utility's reads of the retired folder fail; the failure crosses back by name only.
  scan.scanning?.onError(
    'sync',
    canonicalError(
      canonicalFault(new NativeAuthorityTransitionError('Mounted source lease was retired.'))
    )
  );
  await registered;

  await folders.registration.rootsRegistered();
  expect(await folders.served()).toEqual([folders.alpha.rootId]);
  const failures = [...folders.reported, ...folders.onError.mock.calls.map(([, error]) => error)];
  expect(failures).not.toEqual([]);
  for (const error of failures) {
    expect(error).toMatchObject(replacedGeneration);
  }
});

it('a folder removed during a scan that reports nothing more ends its wait, so the reopen runs', async () => {
  const folders = await twoFolders();
  const scan = folders.holdScan(folders.bravo.rootId);
  const registered = folders.registration.rootsRegistered().catch((error: unknown) => error);
  await vi.waitFor(() => expect(scan.scanning).toBeDefined());
  await folders.remove(folders.bravo.rootId);
  // Main's re-read of the folders queues behind the registration that joined this scan.
  const reopened = folders.registration.rootsRegistered();

  await expect(registered).resolves.toMatchObject(replacedGeneration);
  await reopened;
  expect(await folders.served()).toEqual([folders.alpha.rootId]);
});
