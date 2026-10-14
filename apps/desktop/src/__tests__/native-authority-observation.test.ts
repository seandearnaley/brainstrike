import { createActivationCatalogFixture } from './native-activation-catalog-fixture';
// @vitest-environment node

import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import { registerStoragePreferencesIpcHandlers } from '../ipc-domains/storage-preferences-ipc';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { registerIndexSearchIpcHandlers } from '../ipc-index-search';
import { createNativeIndexActivation } from '../native-index-activation';
import { NATIVE_INDEX_SETTINGS_KEY } from '../native-index-settings';
import { createNativeRootDataDeletion } from '../native-root-data-deletion';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../window-role';
import { createAllowlistedSenderFrame } from './helpers/desktop-ipc-sender-frame-test-allowlist';
import {
  getRegisteredIpcMainHandler,
  resetElectronMainTestHarness,
} from './helpers/electron-main-test-harness';

const catalogFixture = createActivationCatalogFixture();

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  acquireProfile: vi.fn(),
  close: vi.fn(),
  closeCoverage: vi.fn(),
  closeProfile: vi.fn(),
  closeReaders: vi.fn(),
  destroy: vi.fn(),
  manager: {
    attachCanonicalCollection: vi.fn(),
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
    start: vi.fn(),
  },
  readyPort: vi.fn(),
}));
vi.mock('../db-main', () => ({
  getDatabase: async () => {
    throw new Error('Retired PG owner is unavailable.');
  },
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
const scope = { embeddingSetId: 'selected', kind: 'collection' } as const;
const unused = async (): Promise<never> => {
  throw new Error('Unexpected legacy or inference operation.');
};
function writer(): IndexerPort & ScopedIndexerPort & CoverageAuthorityPort {
  return {
    close: unused,
    commitFile: unused,
    commitScopedFile: unused,
    commitScopedTextFile: unused,
    commitTextFile: unused,
    configureVectorProfile: unused,
    coverage: unused,
    coverageAuthority: async () => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      dbPath: '/owned/profile/index.sqlite',
      fileBindings: [],
      rootIds: [],
      scopes: [scope],
      storeId,
    }),
    coverageBatch: unused,
    coverageScope: unused,
    destroy: unused,
    info: async () => ({
      dbPath: '/owned/profile/index.sqlite',
      embedding: { indexMode: 'text-only' },
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    }),
    prepareFile: unused,
    prepareScopedFile: unused,
    readScopedFilePage: unused,
    removeFile: unused,
    removeScopedFile: unused,
    replaceFileBindings: async () => {},
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest: async () => ({
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
function fixture(applicationOverride?: ApplicationIpcDomain) {
  const storage = {
    getItem: vi.fn(async () =>
      JSON.stringify({
        state: {
          enabled: true,
          indexingPolicyPreset: 'balanced',
          managedCollectionId: 'selected',
          nativeIndexMode: 'TEXT',
          nativeLocalSelection: null,
          paused: false,
          worktreeRootIndexingOptInById: {},
        },
      })
    ),
  };
  const application = {
    roots: { restoreRoots: async () => [] },
    watches: {},
  } as unknown as ApplicationIpcDomain;
  const transport = { documentEmbeddings: vi.fn(unused) };
  const onReceipt = vi.fn();
  const activation = createNativeIndexActivation({
    application: applicationOverride ?? application,
    catalog: catalogFixture.catalog,
    embedding: transport,
    modelCatalog: catalogFixture.modelCatalog,
    onError: vi.fn(),
    onReceipt,
    profile: createDesktopProfileRuntime(() => createDesktopHostLease({ root: '/owned/profile' })),
    storage,
  });
  return { activation, onReceipt, storage, transport };
}
beforeEach(() => {
  vi.resetAllMocks();
  catalogFixture.reset();

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
  'recovers a failed missing-mode startup through %s without fatal status observations',
  async (operation) => {
    const f = fixture();
    let saved = JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'selected',
        nativeIndexMode: null,
        nativeLocalSelection: null,
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    });
    f.storage.getItem.mockImplementation(async () => saved);
    const capability = createNativeScopedSearchCapability({
      openQuery: unused,
      rebuild: f.activation.rebuild,
      withRead: f.activation.withRead,
    });
    await expect(f.activation.acquire()).rejects.toThrow(
      'Choose a search mode in Search & Indexing settings.'
    );
    expect(mocks.acquire).not.toHaveBeenCalled();
    saved = JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'selected',
        nativeIndexMode: 'TEXT',
        nativeLocalSelection: null,
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    });
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
      expect(f.transport.documentEmbeddings).not.toHaveBeenCalled();
      expect(observation).toMatchObject({ kind: 'unavailable' });
    } finally {
      release.resolve();
      await replacing.catch(() => undefined);
      await f.activation.close();
    }
  }
);

it('keeps the real persisted TEXT write and IPC status connected through serialized activation recovery', async () => {
  resetElectronMainTestHarness();
  const f = fixture();
  let saved = JSON.stringify({
    state: {
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      nativeIndexMode: null,
      nativeLocalSelection: null,
      paused: true,
      worktreeRootIndexingOptInById: {},
    },
  });
  f.storage.getItem.mockImplementation(async () => saved);
  const storage = {
    clear: unused,
    clearExcept: unused,
    getAllKeys: unused,
    getItem: f.storage.getItem,
    removeItem: unused,
    setItem: async (_key: string, value: string): Promise<void> => {
      saved = value;
    },
  } as unknown as ElectronStorageAdapter;
  const transitions = createNativeRootDataDeletion({
    acquire: f.activation.acquire,
    captureOwner: unused,
    closeOwner: f.activation.close,
    deleteCanonicalRoot: unused,
    reserveRoot: () => {
      throw new Error('Root deletion is not part of settings recovery.');
    },
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
  const writes: Promise<void>[] = [];
  const unregisterStorage = registerStoragePreferencesIpcHandlers({
    getStore: () => null,
    onStorageChanged: (key) => {
      if (key !== NATIVE_INDEX_SETTINGS_KEY) {
        return;
      }
      const changing = transitions.transition(f.activation.reconfigure);
      changing.catch(() => undefined);
      writes.push(changing);
    },
    storage,
  });
  const capability = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  });
  const unregisterSearch = registerIndexSearchIpcHandlers(capability, {
    rootsRegistered: async () => {
      throw new Error('Unexpected root registration in read-only test');
    },
  });
  const senderId = 9498;
  assignWindowRole(
    { isDestroyed: () => false, once: vi.fn(), webContents: { id: senderId } } as never,
    'visible-ui'
  );
  const event = { sender: { id: senderId }, senderFrame: createAllowlistedSenderFrame() };
  try {
    await expect(f.activation.acquire()).rejects.toThrow(
      'Choose a search mode in Search & Indexing settings.'
    );
    const write = getRegisteredIpcMainHandler('storage:setItem');
    for (const policy of ['balanced', 'full-root']) {
      const incomplete = JSON.stringify({
        state: {
          enabled: true,
          indexingPolicyPreset: policy,
          managedCollectionId: 'selected',
          nativeIndexMode: null,
          nativeLocalSelection: null,
          paused: true,
          worktreeRootIndexingOptInById: {},
        },
      });
      await write(event, NATIVE_INDEX_SETTINGS_KEY, incomplete);
      await expect(writes.at(-1)).rejects.toThrow(
        'Choose a search mode in Search & Indexing settings.'
      );
    }
    const next = JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'selected',
        nativeIndexMode: 'TEXT',
        nativeLocalSelection: null,
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    });
    await write(event, NATIVE_INDEX_SETTINGS_KEY, next);
    expect(saved).toBe(next);
    expect(writes).toHaveLength(3);
    await entered.promise;
    expect(events.indexOf('readers-joined')).toBeLessThan(events.indexOf('profile-acquire'));
    expect(mocks.acquire).not.toHaveBeenCalled();
    const status = getRegisteredIpcMainHandler('index-search:status');
    const observation = await status(event);
    release.resolve();
    await writes.at(-1);
    expect(await capability.status()).toMatchObject({
      embedding: { indexMode: 'text-only' },
      kind: 'ready',
    });
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(f.transport.documentEmbeddings).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ ok: true, value: { kind: 'unavailable' } });
  } finally {
    release.resolve();
    await Promise.allSettled(writes);
    await f.activation.close();
    unregisterSearch();
    unregisterStorage();
    clearWindowRoleByWebContentsId(senderId);
  }
});

it('joins the previous writer and profile on terminal close and reports held resumed acquisition as unavailable', async () => {
  const f = fixture();
  f.storage.getItem.mockResolvedValue(
    JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'selected',
        nativeIndexMode: 'TEXT',
        nativeLocalSelection: null,
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    })
  );
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
    const settings = JSON.parse(await f.storage.getItem()) as { state: Record<string, unknown> };
    settings.state['paused'] = true;
    f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
    await f.activation.acquire();
    try {
      settings.state['indexingPolicyPreset'] = 'full-root';
      f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
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
  f.storage.getItem.mockResolvedValue(
    JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'selected',
        nativeIndexMode: 'TEXT',
        nativeLocalSelection: null,
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    })
  );
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

it('preserves a new profile acquisition failure during missing-mode recovery without admitting a writer', async () => {
  const f = fixture();
  f.storage.getItem.mockResolvedValue(
    JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'selected',
        nativeIndexMode: null,
        nativeLocalSelection: null,
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    })
  );
  await expect(f.activation.acquire()).rejects.toThrow(
    'Choose a search mode in Search & Indexing settings.'
  );
  f.storage.getItem.mockResolvedValue(
    JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'selected',
        nativeIndexMode: 'TEXT',
        nativeLocalSelection: null,
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    })
  );
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
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    await expect(capability.status()).resolves.toMatchObject({
      cause: { kind: 'source-failure', message: cause.message },
      phase: 'blocked',
    });
    await expect(f.activation.acquireRead()).rejects.toMatchObject({ cause });
  } finally {
    await f.activation.close();
  }
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
});

it.each([
  { expected: SyntaxError, label: 'corrupt JSON', saved: '{' },
  { expected: Error, label: 'invalid preference envelope', saved: '{}' },
])(
  'retains $label in blocked status and preserves its original strict-read failure',
  async ({ saved, expected }) => {
    const f = fixture();
    f.storage.getItem.mockResolvedValue(saved);
    const capability = createNativeScopedSearchCapability({
      openQuery: unused,
      rebuild: f.activation.rebuild,
      withRead: f.activation.withRead,
    });
    try {
      const observation = await capability.status();
      const failure = await f.activation.acquireRead().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeIndexRefusalError);
      if (!(failure instanceof NativeIndexRefusalError)) {
        throw new Error('Original settings failure was not retained.');
      }
      expect(failure.cause).toBeInstanceOf(expected);
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
  }
);

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
    const f = fixture();
    const native = writer();
    const settings = JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'selected',
        nativeIndexMode: 'TEXT',
        nativeLocalSelection: null,
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    });
    f.storage.getItem.mockResolvedValue(settings);
    native.coverageScope = async () => ({
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
      method === 'status'
        ? capability.status()
        : capability.coverageBatch([{ collectionId: 'selected', rootIds: [] }])
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    let changing: Promise<void> | undefined;
    try {
      await entered.promise;
      const changedSettings = JSON.parse(settings) as { state: { indexingPolicyPreset: string } };
      changedSettings.state.indexingPolicyPreset = 'full-root';
      f.storage.getItem.mockResolvedValue(JSON.stringify(changedSettings));
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
        await expect(
          capability.coverageBatch([{ collectionId: 'selected', rootIds: [] }])
        ).resolves.toMatchObject({ kind: 'invalidated' });
        await expect(
          capability.coverage({ collectionId: 'selected', rootIds: [] })
        ).rejects.toThrow();
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
