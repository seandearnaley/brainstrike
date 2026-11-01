import { createActivationCatalogFixture } from './native-activation-catalog-fixture';
// @vitest-environment node

import {
  createNativeScopedSearchCapability,
  NativeIndexRefusalError,
} from '@brainstrike/assistant-service/node-native-text-services';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import { beforeEach, expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { registerIndexSearchIpcHandlers } from '../ipc-index-search';
import { createNativeIndexActivation } from '../native-index-activation';
import type { NativeIndexSettings } from '../native-index-settings';
import { createNativeRootDataDeletion } from '../native-root-data-deletion';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { invokeDesktopIpc } from './helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain, resetElectronMainTestHarness } from './helpers/electron-main-test-harness';
import { textSettings, unreadableSettings } from './helpers/native-index-settings';
import { restoredRoots } from './helpers/restored-roots';

const catalogFixture = createActivationCatalogFixture();

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  acquireProfile: vi.fn(),
  close: vi.fn(),
  closeCoverage: vi.fn(),
  closeProfile: vi.fn(),
  closeReaders: vi.fn(),
  destroy: vi.fn(),
  /** Main's hosted document embedder; a TEXT index never calls it. */
  hostedEmbeddings: vi.fn(),
  manager: {
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
    start: vi.fn(),
  },
  readyPort: vi.fn(),
}));
vi.mock('../hosted-embeddings', async (original) => ({
  ...(await original<typeof import('../hosted-embeddings')>()),
  generateHostedEmbeddings: mocks.hostedEmbeddings,
}));
vi.mock('../desktop-database-location', () => ({
  resolveDesktopDatabaseProfileDirectory: () => '/owned/profile',
}));
vi.mock('../host-lease-manager', () => ({
  createDesktopHostLease: () => ({ acquire: mocks.acquireProfile, close: mocks.closeProfile }),
}));
vi.mock('../indexer-runtime', () => ({
  acquireIndexerHost: mocks.acquire,
  closeIndexerRuntime: mocks.close,
  destroyIndexerRuntime: mocks.destroy,
  fenceIndexerCanonicalSources: vi.fn(),
  getReadyIndexerHost: () => mocks.manager,
  getReadyScopedIndexerPort: mocks.readyPort,
}));
vi.mock('../sqlite-query-host-manager', () => ({
  closeAllIndexQueries: mocks.closeReaders,
  installIndexQueryTarget: vi.fn(),
  openIndexCoverage: async () => {
    const port: ScopedIndexerPort = mocks.readyPort();
    return {
      close: mocks.closeCoverage,
      nativeCoverage: async (requests: readonly unknown[]) =>
        Promise.all(requests.map((request) => port.coverageScope(request))),
    };
  },
}));

const storeId = 'a'.repeat(64);
const workspace = { kind: 'workspace', rootId: 'root' } as const;
const unused = async (): Promise<never> => {
  throw new Error('Unexpected legacy or inference operation.');
};
function writer(): IndexerPort & ScopedIndexerPort & CoverageAuthorityPort {
  return {
    close: unused,
    commitScopedFile: unused,
    commitScopedTextFiles: unused,
    commitTextFile: unused,
    coverage: unused,
    coverageAuthority: async () => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      dbPath: '/owned/profile/index.sqlite',
      fileBindings: [],
      rootIds: [],
      scopes: [workspace],
      storeId,
    }),
    coverageBatch: unused,
    coverageScope: unused,
    destroy: unused,
    info: async () => ({
      dbPath: '/owned/profile/index.sqlite',
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    }),
    prepareFile: unused,
    prepareScopedFile: unused,
    readScopedFileChunkBounds: unused,
    readScopedFilePage: unused,
    removeFile: unused,
    removeScopedFile: unused,
    removeScopedFiles: unused,
    replaceFileBindings: async () => {},
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest: async ({ scope }) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope,
      storeId,
      unexpected: [],
    }),
  };
}
/** Main's application domain with the one granted folder `root` mounted. */
function mountedRoot(): ApplicationIpcDomain {
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: '/actual/root',
    generation: 'actual-generation',
    listDir: unused,
    readFile: unused,
    retire: async () => {},
    rootId: workspace.rootId,
    signal: new AbortController().signal,
    subscribe: unused,
  };
  return {
    roots: restoredRoots({
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: workspace.rootId }],
    }),
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
}
function fixture(applicationOverride?: ApplicationIpcDomain) {
  /** Main's config owner; a test saves a change by resolving the next read with it. */
  const settings = vi.fn<() => Promise<NativeIndexSettings>>(async () => textSettings());
  const application = {
    roots: restoredRoots({ restoreRoots: async () => [] }),
    watches: {},
  } as unknown as ApplicationIpcDomain;
  const onReceipt = vi.fn();
  const activation = createNativeIndexActivation({
    application: applicationOverride ?? application,
    catalog: catalogFixture.catalog,
    onError: vi.fn(),
    onReceipt,
    profile: createDesktopProfileRuntime(() => createDesktopHostLease({ root: '/owned/profile' })),
    settings,
  });
  return { activation, hostedEmbeddings: mocks.hostedEmbeddings, onReceipt, settings };
}
beforeEach(() => {
  vi.resetAllMocks();
  catalogFixture.reset();

  mocks.hostedEmbeddings.mockImplementation(unused);
  mocks.acquire.mockResolvedValue(writer());
  mocks.acquireProfile.mockResolvedValue(undefined);
  mocks.readyPort.mockReturnValue(writer());
  mocks.close.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.closeReaders.mockResolvedValue(undefined);
  mocks.closeCoverage.mockResolvedValue(undefined);
  mocks.closeProfile.mockResolvedValue(undefined);
  mocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  mocks.manager.start.mockResolvedValue(writer());
});

it.each(['reconfigure', 'rebuild', 'resume'] as const)(
  'recovers a failed settings startup through %s without fatal status observations',
  async (operation) => {
    const f = fixture();
    const unreadable = unreadableSettings();
    f.settings.mockRejectedValue(unreadable);
    const capability = createNativeScopedSearchCapability({
      openQuery: unused,
      rebuild: f.activation.rebuild,
      withRead: f.activation.withRead,
    });
    await expect(f.activation.acquire()).rejects.toBe(unreadable);
    expect(mocks.acquire).not.toHaveBeenCalled();
    f.settings.mockResolvedValue(textSettings({ paused: true, policy: 'full-root' }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mocks.acquireProfile.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    if (operation === 'resume') {
      await f.activation.close();
    }
    const replacing =
      operation === 'resume'
        ? f.activation.resume().then(() => f.activation.acquire())
        : f.activation[operation]();
    try {
      await entered.promise;
      const observation = await capability.status().catch((error: unknown) => error);
      await expect(f.activation.acquireRead()).rejects.toMatchObject({
        refusal: { kind: 'transitioning' },
      });
      expect(mocks.acquire).not.toHaveBeenCalled();
      release.resolve();
      await replacing;
      expect(await capability.status()).toMatchObject({
        embedding: { indexMode: 'text-only' },
        kind: 'ready',
      });
      expect(mocks.acquire).toHaveBeenCalledOnce();
      expect(f.hostedEmbeddings).not.toHaveBeenCalled();
      expect(observation).toMatchObject({ kind: 'unavailable' });
    } finally {
      release.resolve();
      await replacing.catch(() => undefined);
      await f.activation.close();
    }
  }
);

it('keeps IPC status connected while a saved TEXT change recovers activation through the serialized transition', async () => {
  resetElectronMainTestHarness();
  const f = fixture();
  const unreadable = unreadableSettings();
  f.settings.mockRejectedValue(unreadable);
  const transitions = createNativeRootDataDeletion({
    acquire: f.activation.acquire,
    captureOwner: unused,
    closeOwner: f.activation.close,
    reserveRootData: unused,
    resume: f.activation.resume,
    stopSources: f.activation.stopSources,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  mocks.closeReaders.mockImplementation(async () => {
    events.push('readers-joined');
  });
  mocks.acquireProfile.mockImplementation(async () => {
    events.push('profile-acquire');
    entered.resolve();
    await release.promise;
  });
  const capability = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  });
  const unregisterSearch = registerIndexSearchIpcHandlers(
    capability,
    {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    },
    { read: unused, reset: unused, update: unused }
  );
  let changing: Promise<void> | undefined;
  try {
    await expect(f.activation.acquire()).rejects.toBe(unreadable);
    // Main's config owner saves the change, then applies it through the serialized transition.
    f.settings.mockResolvedValue(textSettings({ paused: true, policy: 'full-root' }));
    changing = transitions.transition(f.activation.reconfigure);
    changing.catch(() => undefined);
    await entered.promise;
    expect(events.indexOf('readers-joined')).toBeLessThan(events.indexOf('profile-acquire'));
    expect(mocks.acquire).not.toHaveBeenCalled();
    const observation = await invokeDesktopIpc(
      mockIpcMain,
      DESKTOP_IPC_CHANNELS.indexSearch.status
    );
    release.resolve();
    await changing;
    expect(await capability.status()).toMatchObject({
      embedding: { indexMode: 'text-only' },
      kind: 'ready',
    });
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(f.hostedEmbeddings).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ ok: true, value: { kind: 'unavailable' } });
  } finally {
    release.resolve();
    await changing?.catch(() => undefined);
    await f.activation.close();
    unregisterSearch();
  }
});

it('joins the previous writer and profile on terminal close and reports held resumed acquisition as unavailable', async () => {
  const f = fixture();
  f.settings.mockResolvedValue(textSettings({ paused: true, policy: 'full-root' }));
  const capability = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  });
  await f.activation.acquire();
  await f.activation.close();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  mocks.acquireProfile.mockImplementation(async () => {
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
    entered.resolve();
    await release.promise;
  });
  const replacing = f.activation.resume().then(() => f.activation.acquire());
  try {
    await entered.promise;
    await expect(capability.status()).resolves.toMatchObject({ kind: 'unavailable' });
    await expect(f.activation.acquireRead()).rejects.toMatchObject({
      refusal: { kind: 'transitioning' },
    });
    expect(mocks.acquire).toHaveBeenCalledOnce();
    release.resolve();
    await replacing;
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(await capability.status()).toMatchObject({ kind: 'ready' });
  } finally {
    release.resolve();
    await replacing.catch(() => undefined);
    await f.activation.close();
  }
});

it.each(['reconfigure', 'rebuild'] as const)(
  'retains the shared profile lease through %s and retires it only on terminal close',
  async (operation) => {
    const f = fixture();
    f.settings.mockResolvedValue(textSettings({ paused: true }));
    await f.activation.acquire();
    try {
      f.settings.mockResolvedValue(textSettings({ paused: true, policy: 'full-root' }));
      await f.activation[operation]();
      expect(mocks.acquire).toHaveBeenCalledTimes(2);
      expect(mocks.acquireProfile).toHaveBeenCalledOnce();
      expect(mocks.closeProfile).not.toHaveBeenCalled();
    } finally {
      await f.activation.close();
    }
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
  }
);

it('retains an independent terminal profile cleanup failure and admits no replacement until that original owner joins', async () => {
  const f = fixture();
  f.settings.mockResolvedValue(textSettings({ paused: true, policy: 'full-root' }));
  await f.activation.acquire();
  const cause = new Error('Original profile cleanup has not joined.');
  mocks.closeProfile.mockRejectedValueOnce(cause).mockResolvedValue(undefined);
  try {
    await expect(f.activation.close()).rejects.toBe(cause);
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.acquireProfile).toHaveBeenCalledOnce();
    await expect(f.activation.resume()).rejects.toMatchObject({ cause: { kind: 'closed' } });
    await expect(f.activation.acquireRead()).rejects.toThrow('closed');
    expect(mocks.acquire).toHaveBeenCalledOnce();
    await f.activation.close();
    expect(mocks.closeProfile).toHaveBeenCalledTimes(2);
    await f.activation.resume();
    await f.activation.acquire();
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
  } finally {
    await f.activation.close();
  }
});

it('preserves a new profile acquisition failure during settings recovery without admitting a writer', async () => {
  const f = fixture();
  const unreadable = unreadableSettings();
  f.settings.mockRejectedValue(unreadable);
  await expect(f.activation.acquire()).rejects.toBe(unreadable);
  f.settings.mockResolvedValue(textSettings({ paused: true, policy: 'full-root' }));
  const cause = new Error('Replacement profile acquisition failed.');
  mocks.acquireProfile.mockRejectedValue(cause);
  const capability = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  });
  try {
    await expect(f.activation.reconfigure()).rejects.toBe(cause);
    expect(mocks.acquire).not.toHaveBeenCalled();
    // Index work borrows the host through profile admission, the one retry policy
    // (lifecycle S7): it joined the failed owner's release, then started one
    // replacement, which failed the same way.
    expect(mocks.acquireProfile).toHaveBeenCalledTimes(2);
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
    await expect(capability.status()).resolves.toMatchObject({
      cause: { kind: 'source-failure', message: cause.message },
      phase: 'blocked',
    });
    await expect(f.activation.acquireRead()).rejects.toMatchObject({ cause });
  } finally {
    await f.activation.close();
  }
  // Close joins the release of the replacement that failed.
  expect(mocks.closeProfile).toHaveBeenCalledTimes(2);
});

it('retains an unreadable saved config in blocked status and preserves its original strict-read failure', async () => {
  const f = fixture();
  const unreadable = unreadableSettings();
  f.settings.mockRejectedValue(unreadable);
  const capability = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  });
  try {
    // Boot's reader starts the index; a status read never does (BST-2277).
    const failure = await f.activation.acquireRead().catch((error: unknown) => error);
    const observation = await capability.status();
    expect(failure).toBeInstanceOf(NativeIndexRefusalError);
    if (!(failure instanceof NativeIndexRefusalError)) {
      throw new Error('Original settings failure was not retained.');
    }
    expect(failure.cause).toBe(unreadable);
    expect(observation).toMatchObject({
      cause: { kind: 'settings-invalid' },
      kind: 'unavailable',
      phase: 'blocked',
      reason: failure.message,
    });
    await expect(f.activation.acquire()).rejects.toMatchObject({ cause: failure.cause });
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.acquireProfile).not.toHaveBeenCalled();
  } finally {
    await f.activation.close();
  }
});

it.each([
  { method: 'status', phase: 'authority' },
  { method: 'status', phase: 'capture' },
  { method: 'status', phase: 'final' },
  { method: 'coverageBatch', phase: 'authority' },
  { method: 'coverageBatch', phase: 'capture' },
  { method: 'coverageBatch', phase: 'native' },
  { method: 'coverageBatch', phase: 'disposal' },
  { method: 'coverageBatch', phase: 'final' },
] as const)(
  'projects real reconfiguration as $method data during $phase',
  async ({ method, phase }) => {
    catalogFixture.setRoot();
    const f = fixture(mountedRoot());
    const native = writer();
    f.settings.mockResolvedValue(textSettings({ paused: true }));
    native.coverageScope = async ({ scope }) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      counts: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
      profile: null,
      profileHash: null,
      scope,
      storeId,
      vectorCoverageComplete: false,
    });
    mocks.readyPort.mockReturnValue(native);
    const capability = createNativeScopedSearchCapability({
      openQuery: unused,
      rebuild: f.activation.rebuild,
      withRead: f.activation.withRead,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalInfo = native.info;
    const originalCoverage = native.coverageScope;
    const originalRead = catalogFixture.catalog.sourceCatalog.getMockImplementation();
    if (!originalRead) {
      throw new Error('Expected configured catalog fixture');
    }
    let armed = false;
    let heldAuthority = false;
    let infoCalls = 0;
    native.info = async () => {
      if (
        armed &&
        ((phase === 'capture' && ++infoCalls === 1) || (phase === 'final' && ++infoCalls === 2))
      ) {
        entered.resolve();
        await release.promise;
      }
      return originalInfo();
    };
    native.coverageScope = async (request) => {
      if (armed && phase === 'native') {
        entered.resolve();
        await release.promise;
      }
      return originalCoverage(request);
    };
    catalogFixture.catalog.sourceCatalog.mockImplementation(async (request) => {
      if (armed && phase === 'authority' && !heldAuthority) {
        heldAuthority = true;
        entered.resolve();
        await release.promise;
      }
      return originalRead(request);
    });
    mocks.closeCoverage.mockImplementation(async () => {
      if (armed && phase === 'disposal') {
        entered.resolve();
        await release.promise;
      }
    });
    await f.activation.acquireRead();
    armed = true;
    const result = (
      method === 'status' ? capability.status() : capability.coverageBatch([{ rootIds: ['root'] }])
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    let changing: Promise<void> | undefined;
    try {
      await entered.promise;
      f.settings.mockResolvedValue(textSettings({ paused: true, policy: 'full-root' }));
      changing = f.activation.reconfigure();
      const changed = changing.catch((error: unknown) => error);
      if (phase === 'authority') {
        await changed;
        expect(mocks.close).toHaveBeenCalledOnce();
      } else {
        await vi.waitFor(() =>
          expect(() => f.activation.captureAcknowledgedAuthority()).toThrow(
            'Native source authority changed'
          )
        );
        await expect(f.activation.acquireRead()).rejects.toMatchObject({
          refusal: { kind: 'transitioning' },
        });
        await expect(capability.status()).resolves.toMatchObject({ kind: 'unavailable' });
        await expect(capability.coverageBatch([{ rootIds: ['root'] }])).resolves.toMatchObject({
          kind: 'invalidated',
        });
        await expect(capability.coverage({ rootIds: ['root'] })).rejects.toThrow();
        expect(mocks.close).not.toHaveBeenCalled();
      }
      release.resolve();
      expect(await result).toMatchObject({
        value:
          method === 'status'
            ? { kind: 'unavailable' }
            : { code: 'native-coverage-observation-invalidated', kind: 'invalidated' },
      });
      await changed;
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(await capability.status()).toMatchObject({ kind: 'ready', publicationProgress: [] });
    } finally {
      release.resolve();
      await result;
      await changing?.catch(() => undefined);
      await f.activation.close();
    }
  }
);
