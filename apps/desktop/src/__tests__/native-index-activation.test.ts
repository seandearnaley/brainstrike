// @vitest-environment node
import type {
  CanonicalIngestionDependencies,
  CanonicalScanReceipt,
} from '@brainstrike/canonical-ingestion';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeIndexActivation } from '../native-index-activation';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  closeProfile: vi.fn(),
  closeReaders: vi.fn(),
  database: { query: vi.fn(), transaction: vi.fn() },
  destroy: vi.fn(),
  manager: { attachCanonicalCollection: vi.fn(), attachCanonicalWorkspace: vi.fn() },
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
}));

const storeId = 'a'.repeat(64);
const scope = { embeddingSetId: 'selected', kind: 'collection' } as const;
const unused = async (): Promise<never> => {
  throw new Error('Unexpected legacy or inference operation.');
};
function writer(): IndexerPort & ScopedIndexerPort {
  return {
    close: unused,
    commitFile: unused,
    commitScopedFile: unused,
    commitScopedTextFile: unused,
    commitTextFile: unused,
    configureVectorProfile: unused,
    coverage: unused,
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
function fixture() {
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
    application,
    embedding: transport,
    onError: vi.fn(),
    onReceipt,
    storage,
  });
  return { activation, onReceipt, storage, transport };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.database.query.mockResolvedValue({ rows: [] });
  mocks.acquire.mockResolvedValue(writer());
  mocks.readyPort.mockReturnValue(writer());
  mocks.close.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.closeReaders.mockResolvedValue(undefined);
  mocks.closeProfile.mockResolvedValue(undefined);
});

it('closes an admitted initial collection scan before joining startup, and joins physical retirement', async () => {
  const scan = Promise.withResolvers<CanonicalScanReceipt>();
  const physical = Promise.withResolvers<void>();
  const close = vi.fn(async () => {
    await physical.promise;
    scan.reject(new Error('Owned scan retired.'));
  });
  mocks.manager.attachCanonicalCollection.mockResolvedValue({ close, scan: () => scan.promise });
  const { activation } = fixture();
  const initial = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalCollection).toHaveBeenCalledOnce());
  let settled = false;
  const retiring = activation.destroyAndRetireProfile().then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(mocks.destroy).not.toHaveBeenCalled();
  await expect(activation.acquire()).rejects.toThrow('closed');
  physical.resolve();
  await retiring;
  expect(await initial).toBeInstanceOf(Error);
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
});

it('rebuilds only the derived writer with the saved collection and no inference or application deletion', async () => {
  const close = vi.fn(async () => {});
  const modes: CanonicalIngestionDependencies['mode'][] = [];
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalIngestionDependencies) => {
      modes.push(dependencies.mode);
      return {
        close,
        scan: async (requestId: string) => {
          const ticket = await dependencies.publication.beginScan({ requestId, scope });
          return dependencies.publication.finishScan({
            aborted: false,
            errors: [],
            files: [],
            full: true,
            ticket,
            truncatedDirectories: [],
          });
        },
      };
    }
  );
  const { activation, storage, transport, onReceipt } = fixture();
  await activation.acquire();
  await activation.rebuild();
  expect(modes).toEqual(['TEXT', 'TEXT']);
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  expect(transport.documentEmbeddings).not.toHaveBeenCalled();
  expect(storage.getItem).toHaveBeenCalledTimes(2);
  expect(
    mocks.database.query.mock.calls.every(
      ([sql]) => typeof sql === 'string' && sql.trim().startsWith('SELECT')
    )
  ).toBe(true);
  expect(onReceipt).toHaveBeenCalledTimes(2);
  await activation.close();
});

it('retains a failed source close and refuses derived deletion until explicit retirement retry', async () => {
  const cause = new Error('Source remains physically owned.');
  const close = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalIngestionDependencies) => ({
      close,
      scan: async (requestId: string) => {
        const ticket = await dependencies.publication.beginScan({ requestId, scope });
        return dependencies.publication.finishScan({
          aborted: false,
          errors: [],
          files: [],
          full: true,
          ticket,
          truncatedDirectories: [],
        });
      },
    })
  );
  const { activation } = fixture();
  await activation.acquire();
  await expect(activation.destroyAndRetireProfile()).rejects.toMatchObject({ errors: [cause] });
  expect(mocks.destroy).not.toHaveBeenCalled();
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  await expect(activation.acquire()).rejects.toThrow('closed');
  await activation.destroyAndRetireProfile();
  expect(close).toHaveBeenCalledTimes(2);
  expect(mocks.destroy).toHaveBeenCalledOnce();
});

it('exposes actual native progress while the initial owned collection scan is still running', async () => {
  const held = Promise.withResolvers<CanonicalScanReceipt>();
  mocks.manager.attachCanonicalCollection.mockResolvedValue({
    close: async () => {
      held.reject(new Error('Owned scan closed.'));
    },
    scan: () => held.promise,
  });
  const { activation } = fixture();
  const initial = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalCollection).toHaveBeenCalledOnce());
  expect((await activation.acquireRead()).info).toBeTypeOf('function');
  expect(await activation.getSearchAuthority()).toMatchObject({
    collectionId: 'selected',
    readiness: [{ scanComplete: false, scope }],
    rootIds: [],
  });
  await activation.close();
  expect(await initial).toBeInstanceOf(Error);
});
