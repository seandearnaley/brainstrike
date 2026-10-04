// @vitest-environment node
import type {
  CanonicalScanReceipt,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import type { NativeCanonicalCatalogRecord } from '../native-canonical-catalog';
import { createNativeIndexActivation } from '../native-index-activation';
import { createNativeScopedSearchCapability } from '../native-scoped-search';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
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
  const transport = {
    documentEmbeddings: vi.fn<EmbeddingHostManager['documentEmbeddings']>(unused),
  };
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
  mocks.closeProfile.mockResolvedValue(undefined);
  mocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  mocks.manager.start.mockResolvedValue(writer());
});

function catalogRows(count: number): NativeCanonicalCatalogRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    chunksProcessed: true,
    content: null,
    contentHash: 'c'.repeat(64),
    embeddingSetId: 'selected',
    fileId: `retained-${index}`,
    fileName: `retained-${index}.txt`,
    path: null,
    rootId: null,
    stat: { mtimeMs: 1, size: 1 },
  }));
}
function useCatalogRows(read: () => readonly NativeCanonicalCatalogRecord[]): void {
  mocks.database.query.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('FROM embedding_sets')) {
      return { rows: [{ id: 'selected' }] };
    }
    if (sql.includes('FROM roots')) {
      return { rows: [] };
    }
    const ids = params[0];
    return { rows: Array.isArray(ids) ? read().filter((row) => ids.includes(row.fileId)) : read() };
  });
}
function emptyCollection(
  dependencies: CanonicalCollectionDependencies,
  close = async (): Promise<void> => {}
) {
  return {
    close,
    scan: async (requestId: string) => {
      const ticket = await dependencies.publication.beginScan({
        requestId,
        scope: dependencies.scope,
      });
      return dependencies.publication.finishScan({
        ...{ aborted: false, errors: [], files: [], full: true, truncatedDirectories: [] },
        ticket,
      });
    },
  };
}

async function savePause(
  storage: ReturnType<typeof fixture>['storage'],
  paused: boolean
): Promise<void> {
  const saved = JSON.parse(await storage.getItem()) as { state: Record<string, unknown> };
  saved.state['paused'] = paused;
  storage.getItem.mockResolvedValue(JSON.stringify(saved));
}

it('boots cold paused status, coverage and grep with actual authority and no canonical source admission', async () => {
  const native = {
    ...writer(),
    coverageScope: vi.fn<ScopedIndexerPort['coverageScope']>(async () => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      counts: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
      profile: null,
      profileHash: null,
      scope,
      storeId,
      vectorCoverageComplete: false,
    })),
  };
  mocks.readyPort.mockReturnValue(native);
  const { activation, storage, transport, onReceipt } = fixture();
  await savePause(storage, true);
  const grep = vi.fn(async () => ({
    columns: [
      'id',
      'root_id',
      'file_record_id',
      'path',
      'content',
      'content_hash',
      'start_line',
      'end_line',
      'chunk_index',
      'chunk_size',
      'chunk_type',
      'start_offset',
      'end_offset',
      'token_count',
      'embedding_set_id',
      'source_path',
    ],
    identity: { embedding: { indexMode: 'text-only' as const }, storeId },
    matchedChunks: 0,
    rows: [],
    truncated: false,
  }));
  const search = createNativeScopedSearchCapability({
    openQuery: async () => ({ close: async () => {}, grep }),
    rebuild: activation.rebuild,
    withRead: activation.withRead,
  });
  expect(await search.status()).toMatchObject({
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
    kind: 'ready',
    storeId,
  });
  expect(await search.coverage({ collectionId: 'selected', rootIds: [] })).toMatchObject({
    totals: { chunks: 0, indexedFiles: 0, vectors: 0 },
    vectorCoverageComplete: false,
  });
  expect(
    await search.grep({
      caseSensitive: false,
      collectionId: 'selected',
      isRegex: false,
      limit: 100,
      pattern: '',
      rootIds: [],
    })
  ).toMatchObject({ hits: [], scanLimited: true });
  expect(grep).toHaveBeenCalledOnce();
  expect(mocks.manager.attachCanonicalCollection).not.toHaveBeenCalled();
  expect(mocks.manager.attachCanonicalWorkspace).not.toHaveBeenCalled();
  expect(transport.documentEmbeddings).not.toHaveBeenCalled();
  expect(onReceipt).not.toHaveBeenCalled();
  await activation.close();
});

it('retains a completed native reader and original cleanup authority through pause then resumes actual sources', async () => {
  const close = vi.fn(async () => {});
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies, close)
  );
  const { activation, storage } = fixture();
  const native = await activation.acquire();
  const captured = activation.captureAcknowledgedAuthority();
  const before = await activation.getSearchAuthority();
  const readerCloses = mocks.closeReaders.mock.calls.length;
  await savePause(storage, true);
  await activation.reconfigure();
  expect(await activation.acquireRead()).toBe(native);
  expect(await activation.getSearchAuthority()).toEqual(before);
  expect(captured.readAuthority()).toEqual(
    activation.captureAcknowledgedAuthority().readAuthority()
  );
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.closeReaders).toHaveBeenCalledTimes(readerCloses);
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  expect(mocks.acquire).toHaveBeenCalledOnce();
  await savePause(storage, false);
  await activation.reconfigure();
  expect(mocks.manager.attachCanonicalCollection).toHaveBeenCalledTimes(2);
  expect(mocks.acquire).toHaveBeenCalledOnce();
  expect((await activation.getSearchAuthority()).readiness).toContainEqual({
    scanComplete: true,
    scope,
  });
  await activation.close();
});

it('joins an admitted physical scan before pause acknowledges and retains the reader afterward', async () => {
  const scan = Promise.withResolvers<CanonicalScanReceipt>();
  const physical = Promise.withResolvers<void>();
  const close = vi.fn(async () => {
    await physical.promise;
    scan.reject(new Error('Owned pause cancellation.'));
  });
  mocks.manager.attachCanonicalCollection.mockResolvedValue({ close, scan: () => scan.promise });
  const { activation, storage } = fixture();
  const starting = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalCollection).toHaveBeenCalledOnce());
  const native = await activation.acquireRead();
  await savePause(storage, true);
  let settled = false;
  const pausing = activation.reconfigure().then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(mocks.close).not.toHaveBeenCalled();
  physical.resolve();
  await pausing;
  expect(await starting).toBeInstanceOf(Error);
  expect(await activation.acquireRead()).toBe(native);
  expect((await activation.getSearchAuthority()).readiness).toContainEqual({
    scanComplete: false,
    scope,
  });
  await activation.close();
});

it('invalidates changed catalog proof and replaces trusted bindings while paused without scheduling ingestion', async () => {
  let records = catalogRows(0);
  useCatalogRows(() => records);
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const replaceFileBindings = vi.fn<ScopedIndexerPort['replaceFileBindings']>(async () => {});
  mocks.readyPort.mockReturnValue({ ...writer(), replaceFileBindings });
  const { activation, storage } = fixture();
  await activation.acquire();
  await savePause(storage, true);
  await activation.reconfigure();
  records = catalogRows(1);
  await activation.acquireRead();
  expect((await activation.getSearchAuthority()).readiness).toContainEqual({
    scanComplete: false,
    scope,
  });
  expect(replaceFileBindings).toHaveBeenLastCalledWith([
    expect.objectContaining({ fileId: 'retained-0' }),
  ]);
  expect(mocks.manager.attachCanonicalCollection).toHaveBeenCalledOnce();
  await savePause(storage, false);
  await activation.reconfigure();
  expect(mocks.manager.attachCanonicalCollection).toHaveBeenCalledTimes(2);
  await activation.close();
});

it('retains failed pause cleanup for explicit retry and keeps reset behind that physical owner', async () => {
  const cause = new Error('Pause attachment still physically owned.');
  const close = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies, close)
  );
  const { activation, storage } = fixture();
  await activation.acquire();
  await savePause(storage, true);
  await expect(activation.reconfigure()).rejects.toMatchObject({ errors: [cause] });
  await expect(activation.acquireRead()).rejects.toThrow();
  expect(mocks.close).not.toHaveBeenCalled();
  await activation.reconfigure();
  expect(close).toHaveBeenCalledTimes(2);
  await activation.acquireRead();
  expect(mocks.acquire).toHaveBeenCalledOnce();
  await activation.destroyAndRetireProfile();
  expect(mocks.destroy).toHaveBeenCalledOnce();
});

function vectorPauseFixture() {
  const f = fixture();
  const profile = {
    dimensions: 384,
    distance: 'cosine',
    dtype: 'q8',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    provider: 'transformers',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    tokenCap: 512,
  } as const;
  mocks.database.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM embedding_sets')
      ? [
          {
            dimensions: profile.dimensions,
            distance: profile.distance,
            id: 'selected',
            modelId: profile.modelId,
            modelKey: `transformers::${profile.modelId}`,
          },
        ]
      : [],
  }));
  f.storage.getItem.mockResolvedValue(
    JSON.stringify({
      state: {
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'selected',
        nativeIndexMode: 'VECTOR',
        nativeLocalSelection: {
          device: 'wasm',
          dimensions: profile.dimensions,
          dtype: profile.dtype,
          modelId: profile.modelId,
          revision: profile.revision,
        },
        paused: true,
        worktreeRootIndexingOptInById: {},
      },
    })
  );
  return { ...f, profile };
}

it('opens cold paused VECTOR authority with the exact saved query plan and zero document inference', async () => {
  const { activation, transport, profile } = vectorPauseFixture();
  await activation.acquireRead();
  expect(await activation.getSearchAuthority()).toMatchObject({
    profile,
    queryPlan: {
      inferencePlan: {
        device: 'wasm',
        dimensions: profile.dimensions,
        dtype: profile.dtype,
        modelId: profile.modelId,
        revision: profile.revision,
      },
      modelKey: `transformers::${profile.modelId}`,
    },
    readiness: [{ scanComplete: false, scope }],
  });
  expect(mocks.manager.attachCanonicalCollection).not.toHaveBeenCalled();
  expect(transport.documentEmbeddings).not.toHaveBeenCalled();
  await activation.close();
});

it('joins actual document adapter cancellation before Pause acknowledges and keeps VECTOR read authority', async () => {
  const { activation, storage, transport, profile } = vectorPauseFixture();
  await savePause(storage, false);
  const physical = Promise.withResolvers<void>();
  let inferenceSignal: AbortSignal | undefined;
  transport.documentEmbeddings.mockImplementation(async (_payload, options) => {
    inferenceSignal = options?.signal;
    await physical.promise;
    throw options?.signal?.reason;
  });
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      if (dependencies.mode !== 'VECTOR') {
        throw new Error('Expected explicit VECTOR source.');
      }
      return {
        close: async () => {},
        scan: async () => {
          await dependencies.inference.generate({
            chunks: [{ chunkId: 'chunk', content: 'actual canonical text' }],
            profile,
            requestId: 'held-documents',
          });
          throw new Error('Unexpected completed inference.');
        },
      };
    }
  );
  const starting = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(transport.documentEmbeddings).toHaveBeenCalledOnce());
  await savePause(storage, true);
  let paused = false;
  const pausing = activation.reconfigure().then(() => {
    paused = true;
  });
  await vi.waitFor(() => expect(inferenceSignal?.aborted).toBe(true));
  expect(paused).toBe(false);
  expect(mocks.close).not.toHaveBeenCalled();
  physical.resolve();
  await pausing;
  expect(await starting).toBeInstanceOf(Error);
  await activation.acquire();
  expect(await activation.getSearchAuthority()).toMatchObject({
    profile,
    readiness: [{ scanComplete: false, scope }],
  });
  expect(mocks.acquire).toHaveBeenCalledOnce();
  await activation.close();
});

it('retires source borrows on Pause while the original mounted read-authority borrow remains live', async () => {
  const leases: CanonicalWorkspaceLease[] = [];
  let notifyWorkspace: (() => void) | undefined;
  let collectionScans = 0;
  const application = {
    roots: {
      borrowSourceRoot: async () => {
        const controller = new AbortController();
        const lease: CanonicalWorkspaceLease = {
          canonicalPath: '/actual/root',
          generation: `borrow-${leases.length}`,
          listDir: vi.fn(unused),
          readFile: vi.fn(unused),
          retire: vi.fn(async () => {
            controller.abort(new Error('Original borrow retired.'));
          }),
          rootId: 'root',
          signal: controller.signal,
          subscribe: vi.fn(unused),
        };
        leases.push(lease);
        return lease;
      },
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  mocks.database.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM embedding_sets')
      ? [{ id: 'selected' }]
      : sql.includes('FROM roots')
        ? [{ id: 'root', kind: 'path' }]
        : [],
  }));
  const native = {
    ...writer(),
    verifyScopedManifest: vi.fn<ScopedIndexerPort['verifyScopedManifest']>(
      async ({ scope: requested }) => ({
        authorityEpoch: 'b'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: requested,
        storeId,
        unexpected: [],
      })
    ),
  };
  mocks.readyPort.mockReturnValue(native);
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      const ticket = await dependencies.publication.beginScan({
        requestId: 'workspace',
        scope: { kind: 'workspace', rootId: 'root' },
      });
      const receipt = await dependencies.publication.finishScan({
        aborted: false,
        errors: [],
        files: [],
        full: true,
        ticket,
        truncatedDirectories: [],
      });
      dependencies.onReceipt(receipt);
      notifyWorkspace = () => dependencies.onReceipt(receipt);
      return { close: async () => {}, trigger: unused };
    }
  );
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      const collection = emptyCollection(dependencies);
      return {
        ...collection,
        scan: async (requestId: string) => {
          collectionScans += 1;
          return collection.scan(requestId);
        },
      };
    }
  );
  const { activation, storage } = fixture(application);
  await savePause(storage, true);
  await activation.acquireRead();
  expect(leases).toHaveLength(1);
  expect(leases[0]?.subscribe).not.toHaveBeenCalled();
  await savePause(storage, false);
  await activation.reconfigure();
  expect(leases).toHaveLength(2);
  if (!notifyWorkspace) {
    throw new Error('Workspace receipt callback was not acquired.');
  }
  notifyWorkspace();
  await vi.waitFor(() => expect(collectionScans).toBe(2));
  await vi.waitFor(() =>
    expect(activation.getReadiness().every(({ scanComplete }) => scanComplete)).toBe(true)
  );
  await savePause(storage, true);
  await activation.reconfigure();
  notifyWorkspace();
  expect(collectionScans).toBe(2);
  expect(leases[0]?.signal.aborted).toBe(false);
  expect(leases[1]?.signal.aborted).toBe(true);
  await activation.acquireRead();
  expect((await activation.getSearchAuthority()).rootIds).toEqual(['root']);
  await activation.close();
  expect(leases[0]?.signal.aborted).toBe(true);
});

it('joins a held Pause with terminal retirement without reopening the original native owner', async () => {
  const physical = Promise.withResolvers<void>();
  const close = vi.fn(() => physical.promise);
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies, close)
  );
  const { activation, storage } = fixture();
  await activation.acquire();
  await savePause(storage, true);
  const pausing = activation.reconfigure().catch((error: unknown) => error);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  let retired = false;
  const terminal = activation.close().then(() => {
    retired = true;
  });
  await Promise.resolve();
  expect(retired).toBe(false);
  physical.resolve();
  await terminal;
  expect(await pausing).toBeInstanceOf(Error);
  expect(mocks.acquire).toHaveBeenCalledOnce();
  await expect(activation.acquireRead()).rejects.toThrow('closed');
});

it('revokes old read authority when new saved execution choices are invalid', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, storage } = fixture();
  await activation.acquire();
  const saved = JSON.parse(await storage.getItem()) as { state: Record<string, unknown> };
  saved.state['nativeIndexMode'] = 'VECTOR';
  storage.getItem.mockResolvedValue(JSON.stringify(saved));
  await expect(activation.reconfigure()).rejects.toThrow(
    'explicitly selected local execution plan'
  );
  await expect(activation.acquireRead()).rejects.toThrow();
  expect(mocks.acquire).toHaveBeenCalledOnce();
  await activation.close();
});

it('fences reads and joins a held settings read before terminal retirement acknowledges', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, storage } = fixture();
  await activation.acquire();
  const saved = await storage.getItem();
  const reading = Promise.withResolvers<string>();
  storage.getItem.mockReturnValueOnce(reading.promise);
  const reconfiguring = activation.reconfigure().catch((error: unknown) => error);
  await expect(activation.acquireRead()).rejects.toThrow('being revalidated');
  let retired = false;
  const terminal = activation.close().then(() => {
    retired = true;
  });
  await Promise.resolve();
  expect(retired).toBe(false);
  reading.resolve(saved);
  await terminal;
  expect(await reconfiguring).toBeInstanceOf(Error);
  expect(mocks.acquire).toHaveBeenCalledOnce();
  await expect(activation.acquireRead()).rejects.toThrow('closed');
});

it('refuses reused read ownership when source retirement left the actual manager terminally closed', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, storage } = fixture();
  await activation.acquire();
  await savePause(storage, true);
  const cause = new Error('Actual indexer owner is terminally closed.');
  mocks.manager.start.mockRejectedValueOnce(cause);
  await expect(activation.reconfigure()).rejects.toBe(cause);
  await expect(activation.acquireRead()).rejects.toThrow('Canonical native scan failed');
  await expect(activation.acquire()).rejects.toThrow('Canonical native scan failed');
  await activation.reconfigure();
  await activation.acquireRead();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  await activation.close();
});
