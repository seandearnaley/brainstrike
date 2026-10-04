// @vitest-environment node
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeIndexActivation } from '../native-index-activation';
import { createNativeScopedSearchCapability } from '../native-scoped-search';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  closeCoverage: vi.fn(),
  closeProfile: vi.fn(),
  closeReaders: vi.fn(),
  database: { query: vi.fn(), transaction: vi.fn() },
  destroy: vi.fn(),
  manager: {
    attachCanonicalCollection: vi.fn(),
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
    start: vi.fn(),
  },
  readyPort: vi.fn(),
}));
vi.mock('../db-main', () => ({ getDatabase: async () => mocks.database }));
vi.mock('../desktop-database-location', () => ({
  resolveDesktopDatabaseProfileDirectory: () => '/owned/profile',
}));
vi.mock('../host-lease-manager', () => ({
  createDesktopHostLease: () => ({ acquire: async () => {}, close: mocks.closeProfile }),
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
    embedding: transport,
    onError: vi.fn(),
    onReceipt,
    storage,
  });
  return { activation, onReceipt, storage, transport };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.database.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM embedding_sets') ? [{ id: 'selected' }] : [],
  }));
  mocks.acquire.mockResolvedValue(writer());
  mocks.readyPort.mockReturnValue(writer());
  mocks.close.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.closeReaders.mockResolvedValue(undefined);
  mocks.closeCoverage.mockResolvedValue(undefined);
  mocks.closeProfile.mockResolvedValue(undefined);
  mocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  mocks.manager.start.mockResolvedValue(writer());
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
    const originalQuery = mocks.database.query.getMockImplementation();
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
    mocks.database.query.mockImplementation(async (...args: unknown[]) => {
      if (armed && phase === 'authority' && !heldAuthority) {
        heldAuthority = true;
        entered.resolve();
        await release.promise;
      }
      return originalQuery?.(...args);
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
        await expect(f.activation.acquireRead()).rejects.toThrow('closed');
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
