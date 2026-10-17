import { projectModelCatalog } from '@brainstrike/assistant-contract';
import type {
  CanonicalSourceScope,
  NativeCanonicalCatalogRecord,
} from '@brainstrike/canonical-ingestion';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import type {
  CollectionPort,
  SourceCatalogPort,
  WorkspaceRootPort,
} from '@brainstrike/state-store';
import type { SourceFileRecord } from '@brainstrike/types';
import { vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeIndexActivation } from '../native-index-activation';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  acquireProfile: vi.fn(),
  catalog: {
    collections: vi.fn<CollectionPort['collections']>(),
    sourceCatalog: vi.fn<SourceCatalogPort['sourceCatalog']>(),
    workspaceRoots: vi.fn<WorkspaceRootPort['workspaceRoots']>(),
  },
  close: vi.fn(),
  closeProfile: vi.fn(),
  closeReaders: vi.fn(),
  createProfileOwner: vi.fn(),
  destroy: vi.fn(),
  /** The current profile owner's `lost`: its ready host exited without Main asking. */
  loseHost: vi.fn(),
  manager: {
    attachCanonicalCollection: vi.fn(),
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
    start: vi.fn(),
  },
  modelCatalog: { read: vi.fn() },
  readyPort: vi.fn(),
}));

export { mocks };

/** Load the product constructor through the module that owns these hoisted mocks. */
export function createActivation(
  options: Omit<
    Parameters<typeof createNativeIndexActivation>[0],
    'profile' | 'catalog' | 'modelCatalog'
  >
): ReturnType<typeof createNativeIndexActivation> {
  return createNativeIndexActivation({
    ...options,
    catalog: mocks.catalog,
    modelCatalog: mocks.modelCatalog,
    profile: createDesktopProfileRuntime((lost) => {
      mocks.loseHost.mockImplementation(lost);
      return createDesktopHostLease({ root: '/owned/profile' });
    }),
  });
}
vi.mock('../desktop-database-location', () => ({
  resolveDesktopDatabaseProfileDirectory: () => '/owned/profile',
}));
vi.mock('../host-lease-manager', () => ({
  createDesktopHostLease: () => {
    mocks.createProfileOwner();
    return { acquire: () => mocks.acquireProfile(), close: mocks.closeProfile };
  },
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
      close: async () => undefined,
      nativeCoverage: async (requests: readonly unknown[]) =>
        Promise.all(requests.map((request) => port.coverageScope(request))),
    };
  },
}));

export const storeId = 'a'.repeat(64);
export const scope = { embeddingSetId: 'selected', kind: 'collection' } as const;
export const unused = async (): Promise<never> => {
  throw new Error('Unexpected legacy or inference operation.');
};
export function requestedScope(input: unknown): CanonicalSourceScope {
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
export function writer(): IndexerPort & ScopedIndexerPort & CoverageAuthorityPort {
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
    readScopedFileChunkBounds: unused,
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
/** A genuine settings change: the next settings read returns the saved state with `changes`. */
export async function saveSettingsChange(
  storage: ReturnType<typeof fixture>['storage'],
  changes: Record<string, unknown>
): Promise<void> {
  const saved = JSON.parse(await storage.getItem()) as { state: Record<string, unknown> };
  storage.getItem.mockResolvedValue(
    JSON.stringify({ ...saved, state: { ...saved.state, ...changes } })
  );
}

export function fixture(applicationOverride?: ApplicationIpcDomain) {
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
  const transport = { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) };
  const onReceipt = vi.fn();
  const onError = vi.fn();
  const activation = createNativeIndexActivation({
    application: applicationOverride ?? application,
    catalog: mocks.catalog,
    embedding: transport,
    modelCatalog: mocks.modelCatalog,
    onError,
    onReceipt,
    profile: createDesktopProfileRuntime((lost) => {
      mocks.loseHost.mockImplementation(lost);
      return createDesktopHostLease({ root: '/owned/profile' });
    }),
    storage,
  });
  return { activation, onError, onReceipt, storage, transport };
}
export function resetActivationFixture(): void {
  vi.resetAllMocks();
  mocks.catalog.collections.mockResolvedValue({
    collections: [
      {
        createdAt: '2026-10-13T00:00:00.000Z',
        dimensions: 384,
        distance: 'cosine',
        id: 'selected',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'transformers::Xenova/all-MiniLM-L6-v2',
      },
    ],
  });
  mocks.catalog.workspaceRoots.mockResolvedValue({ roots: [] });
  mocks.modelCatalog.read.mockResolvedValue(projectModelCatalog({ models: [], providers: [] }));
  setCatalogRecords(() => []);
  mocks.acquire.mockResolvedValue(writer());
  mocks.acquireProfile.mockResolvedValue(undefined);
  mocks.readyPort.mockReturnValue(writer());
  mocks.close.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.closeReaders.mockResolvedValue(undefined);
  mocks.closeProfile.mockResolvedValue(undefined);
  mocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  mocks.manager.start.mockResolvedValue(writer());
}

export function emptyCollection(
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

/** Current source-catalog wire records, retaining the scenario's canonical identities. */
export function sourceRecord(record: NativeCanonicalCatalogRecord): SourceFileRecord {
  if (record.contentHash === null) {
    throw new Error('Current source records require their content hash.');
  }
  return {
    ...record,
    chunksCount: null,
    contentHash: record.contentHash,
    createdAt: '2026-10-13T00:00:00.000Z',
    path: record.path ?? record.fileName,
    updatedAt: '2026-10-13T00:00:00.000Z',
  };
}
export function setCatalogRecords(read: () => readonly NativeCanonicalCatalogRecord[]): void {
  mocks.catalog.sourceCatalog.mockImplementation(async (request) => {
    const records = read().map(sourceRecord);
    if (request.operation === 'inventory') {
      return {
        files: records.filter((record) => record.embeddingSetId === request.embeddingSetId),
      };
    }
    if (request.operation === 'read') {
      return { files: records.filter((record) => request.fileIds.includes(record.fileId)) };
    }
    throw new Error(`Unexpected catalog mutation ${request.operation}`);
  });
}
export function setCatalogRoot(id = 'root'): void {
  mocks.catalog.workspaceRoots.mockResolvedValue({
    roots: [
      {
        createdAt: 1,
        displayName: 'root',
        id,
        kind: 'path',
        lastVerifiedAt: 1,
        path: '/actual/root',
        status: 'live',
      },
    ],
  });
}
