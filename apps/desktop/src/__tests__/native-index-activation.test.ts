// @vitest-environment node
import type {
  CanonicalIngestionDependencies,
  CanonicalScanReceipt,
  CanonicalSourceScope,
  CanonicalVectorPublicationPort,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import {
  type IndexerPort,
  type ScopedFilePlan,
  type ScopedIndexerPort,
  vectorProfileHash,
} from '@brainstrike/indexer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import type { NativeCanonicalCatalogRecord } from '../native-canonical-catalog';
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
function requestedScope(input: unknown): CanonicalSourceScope {
  if (!input || typeof input !== 'object') {
    throw new Error('Expected a native scope request.');
  }
  const selected: unknown = Reflect.get(input, 'scope');
  if (!selected || typeof selected !== 'object') {
    throw new Error('Expected explicit native scope.');
  }
  const kind: unknown = Reflect.get(selected, 'kind');
  const rootId: unknown = Reflect.get(selected, 'rootId');
  const embeddingSetId: unknown = Reflect.get(selected, 'embeddingSetId');
  if (kind === 'workspace' && typeof rootId === 'string') {
    return { kind, rootId };
  }
  if (kind === 'collection' && typeof embeddingSetId === 'string') {
    return { embeddingSetId, kind };
  }
  throw new Error('Expected an authorized native scope.');
}
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

it.each(['close', 'destroyAndRetireProfile'] as const)(
  'fences and joins held reconfiguration before %s acknowledges terminal retirement',
  async (operation) => {
    mocks.manager.attachCanonicalCollection.mockImplementation(
      async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
    );
    const { activation } = fixture();
    await activation.acquire();
    const profileExit = Promise.withResolvers<void>();
    mocks.closeProfile.mockReturnValueOnce(profileExit.promise);
    const changing = activation.reconfigure().catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.closeProfile).toHaveBeenCalledOnce());
    let terminalSettled = false;
    const terminal = activation[operation]().then(() => {
      terminalSettled = true;
    });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);
    profileExit.resolve();
    await Promise.all([changing, terminal]);
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    await expect(activation.acquireRead()).rejects.toThrow('closed');
  }
);

it('refuses a nonexistent saved TEXT collection before opening a writer or completing a receipt', async () => {
  mocks.database.query.mockResolvedValue({ rows: [] });
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, onReceipt } = fixture();
  await expect(activation.acquire()).rejects.toThrow('saved native collection is missing');
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(onReceipt).not.toHaveBeenCalled();
  expect(mocks.manager.attachCanonicalCollection).not.toHaveBeenCalled();
  await activation.close();
});

it.each([251, 1501])(
  'loads the entire %i-file inventory through bounded actual catalog batches',
  async (count) => {
    const records = catalogRows(count);
    useCatalogRows(() => records);
    let inventory: readonly { readonly fileId: string }[] = [];
    mocks.manager.attachCanonicalCollection.mockImplementation(
      async (dependencies: CanonicalCollectionDependencies) => {
        const host = emptyCollection(dependencies);
        return {
          ...host,
          scan: async (requestId: string) => {
            inventory = await dependencies.source.inventory.loadFiles(dependencies.scope, {
              requestId,
              signal: new AbortController().signal,
            });
            return host.scan(requestId);
          },
        };
      }
    );
    const { activation } = fixture();
    await activation.acquire();
    expect(inventory.map((file) => file.fileId)).toEqual(records.map((record) => record.fileId));
    const batches = mocks.database.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('ANY($1::text[])')
    );
    expect(batches).toHaveLength(2 * Math.ceil(count / 250));
    expect(
      batches.every(([, params]) => Array.isArray(params?.[0]) && params[0].length <= 250)
    ).toBe(true);
    await activation.close();
  }
);

it('invalidates actual read-path readiness and starts canonical refresh without waiting for its full scan', async () => {
  let records = catalogRows(0);
  useCatalogRows(() => records);
  const refresh = Promise.withResolvers<void>();
  let scans = 0;
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      const host = emptyCollection(dependencies);
      return {
        ...host,
        scan: async (requestId: string) => {
          scans += 1;
          if (scans > 1) {
            await refresh.promise;
          }
          return host.scan(requestId);
        },
      };
    }
  );
  const { activation } = fixture();
  await activation.acquire();
  records = catalogRows(1);
  await activation.acquireRead();
  expect((await activation.getSearchAuthority()).readiness).toContainEqual({
    scanComplete: false,
    scope,
  });
  await vi.waitFor(() => expect(scans).toBe(2));
  refresh.resolve();
  await activation.acquire();
  expect(mocks.readyPort().verifyScopedManifest).toBeTypeOf('function');
  expect((await activation.getSearchAuthority()).readiness).toContainEqual({
    scanComplete: true,
    scope,
  });
  await activation.close();
});

it('keeps captured cleanup authority through expected source abort and refuses it after writer retirement', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation } = fixture();
  await activation.acquire();
  const captured = activation.captureAcknowledgedAuthority();
  const authority = captured.readAuthority();
  await activation.stopSources();
  expect(captured.readAuthority()).toEqual(authority);
  expect(captured.port).toBe(mocks.readyPort());
  await activation.close();
  expect(() => captured.readAuthority()).toThrow();
});

it('joins outgoing rooted collection removal before replacing the main writer', async () => {
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: '/actual/root',
    generation: 'actual-generation',
    listDir: unused,
    readFile: unused,
    retire: vi.fn(async () => {}),
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: unused,
  };
  const application = {
    roots: {
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  const records = catalogRows(2).map((record, index) =>
    index === 0 ? { ...record, path: 'file.txt', rootId: 'root' } : record
  );
  mocks.database.query.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('FROM roots')) {
      return { rows: [{ id: 'root', kind: 'path' }] };
    }
    if (sql.includes('FROM embedding_sets')) {
      return { rows: [{ id: params[0] }] };
    }
    return { rows: params[0] === 'selected' ? records : [] };
  });
  const removal = Promise.withResolvers<boolean>();
  const native = {
    ...writer(),
    removeScopedFile: vi.fn(() => removal.promise),
    verifyScopedManifest: vi.fn(
      async (request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]) => ({
        authorityEpoch: 'b'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: requestedScope(request),
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
      dependencies.onReceipt(
        await dependencies.publication.finishScan({
          aborted: false,
          errors: [],
          files: [],
          full: true,
          ticket,
          truncatedDirectories: [],
        })
      );
      return { close: async () => {}, trigger: unused };
    }
  );
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, storage } = fixture(application);
  await activation.acquire();
  const saved = JSON.parse(await storage.getItem()) as { state: Record<string, unknown> };
  saved.state['managedCollectionId'] = 'next';
  storage.getItem.mockResolvedValue(JSON.stringify(saved));
  const changing = activation.reconfigure();
  await vi.waitFor(() => expect(native.removeScopedFile).toHaveBeenCalledOnce());
  expect(native.removeScopedFile).toHaveBeenCalledWith({
    fileId: 'retained-0',
    scope: { kind: 'workspace', rootId: 'root' },
  });
  expect(lease.retire).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.acquire).toHaveBeenCalledOnce();
  removal.resolve(true);
  await changing;
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  expect((await activation.getSearchAuthority()).collectionId).toBe('next');
  await activation.close();
});

it('finishes root plus collection VECTOR startup with reverified receipts and no missing-vector inference', async () => {
  const profile = {
    dimensions: 384,
    distance: 'cosine',
    dtype: 'q8',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    provider: 'transformers',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    tokenCap: 512,
  } as const;
  const record = {
    ...catalogRows(1)[0],
    chunksProcessed: true,
    content: null,
    contentHash: 'c'.repeat(64),
    embeddingSetId: 'selected',
    fileId: 'rooted-file',
    fileName: 'file.txt',
    path: 'file.txt',
    rootId: 'root',
    stat: { mtimeMs: 1, size: 9 },
  };
  mocks.database.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM roots')
      ? [{ id: 'root', kind: 'path' }]
      : sql.includes('FROM embedding_sets')
        ? [
            {
              dimensions: 384,
              distance: 'cosine',
              id: 'selected',
              modelId: profile.modelId,
              modelKey: `transformers::${profile.modelId}`,
            },
          ]
        : [record],
  }));
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: '/actual/root',
    generation: 'actual-generation',
    listDir: unused,
    readFile: unused,
    retire: async () => {},
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: unused,
  };
  const identity = {
    embeddingSetId: 'selected',
    fileId: 'rooted-file',
    fileName: 'file.txt',
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const providedChunks = [
    {
      chunkIndex: 0,
      chunkSize: 384,
      chunkType: 'text',
      content: 'canonical',
      contentHash: 'c'.repeat(64),
      endLine: 1,
      endOffset: 9,
      startLine: 1,
      startOffset: 0,
      tokenCount: 2,
    },
  ] as const;
  const plan: ScopedFilePlan = {
    authorityEpoch: 'b'.repeat(64),
    authorityRevision: 1,
    chunks: [
      {
        ...providedChunks[0],
        chunkId: 'd'.repeat(64),
        contentHash: 'c'.repeat(64),
        embeddingHash: 'e'.repeat(64),
      },
    ],
    contentHash: record.contentHash,
    embeddingChunkIds: [],
    previousSnapshotHash: null,
    profile,
    profileHash: vectorProfileHash(profile),
    snapshot: { ...identity, content: 'canonical', providedChunks },
    storeId,
  };
  const native = {
    ...writer(),
    commitScopedFile: vi.fn(async () => ({
      reusedEmbeddings: 1,
      syntaxStatus: 'retained' as const,
      unchanged: true,
      writtenChunks: 0,
      writtenRefs: 0,
      writtenSymbols: 0,
    })),
    coverageScope: vi.fn(async (input: Parameters<ScopedIndexerPort['coverageScope']>[0]) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      counts: { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 },
      profile,
      profileHash: vectorProfileHash(profile),
      scope: requestedScope(input),
      storeId,
      vectorCoverageComplete: true,
    })),
    prepareScopedFile: vi.fn(async () => plan),
    verifyScopedManifest: vi.fn(
      async (input: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]) => ({
        authorityEpoch: 'b'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: requestedScope(input),
        storeId,
        unexpected: [],
      })
    ),
  };
  mocks.readyPort.mockReturnValue(native);
  const publish = async (
    publication: CanonicalVectorPublicationPort,
    target: CanonicalSourceScope
  ): Promise<CanonicalScanReceipt> => {
    const ticket = await publication.beginScan({
      requestId: JSON.stringify(target),
      scope: target,
    });
    const prepared = await publication.prepareVectorFile({
      file: identity,
      payload: { content: 'canonical', fileId: identity.fileId, providedChunks },
      profile,
      ticket,
    });
    await publication.commitVectorFile({
      embeddings: [],
      file: identity,
      plan: prepared,
      profile,
      ticket,
    });
    return publication.finishScan({
      aborted: false,
      errors: [],
      files: [{ ...identity, contentHash: record.contentHash }],
      full: true,
      ticket,
      truncatedDirectories: [],
    });
  };
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      if (dependencies.mode !== 'VECTOR') {
        throw new Error('Expected explicit VECTOR workspace.');
      }
      dependencies.onReceipt(
        await publish(dependencies.publication, { kind: 'workspace', rootId: 'root' })
      );
      return { close: async () => {}, trigger: unused };
    }
  );
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      if (dependencies.mode !== 'VECTOR') {
        throw new Error('Expected explicit VECTOR collection.');
      }
      return { close: async () => {}, scan: async () => publish(dependencies.publication, scope) };
    }
  );
  const application = {
    roots: {
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  const documentEmbeddings = vi.fn(unused);
  const activation = createNativeIndexActivation({
    application,
    embedding: { documentEmbeddings },
    onError: vi.fn(),
    storage: {
      getItem: async () =>
        JSON.stringify({
          state: {
            enabled: true,
            indexingPolicyPreset: 'balanced',
            managedCollectionId: 'selected',
            nativeIndexMode: 'VECTOR',
            nativeLocalSelection: {
              device: 'wasm',
              dimensions: 384,
              dtype: 'q8',
              modelId: profile.modelId,
              revision: profile.revision,
            },
            paused: false,
            worktreeRootIndexingOptInById: {},
          },
        }),
    },
  });
  await activation.acquire();
  expect(activation.getReadiness()).toEqual([
    { scanComplete: true, scope: { kind: 'workspace', rootId: 'root' } },
    { scanComplete: true, scope },
  ]);
  expect(documentEmbeddings).not.toHaveBeenCalled();
  expect(native.commitScopedFile).toHaveBeenCalledTimes(2);
  expect(native.verifyScopedManifest).toHaveBeenCalledTimes(3);
  expect(native.coverageScope).toHaveBeenCalledTimes(1);
  await activation.close();
});
