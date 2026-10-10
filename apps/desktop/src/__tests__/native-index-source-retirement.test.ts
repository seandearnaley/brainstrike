// @vitest-environment node
import type {
  CanonicalSourceScope,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import { beforeEach, expect, it, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalCollectionDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import { decodeCanonicalFrame } from '../canonical-utility-protocol';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import type { NativeCanonicalInference } from '../native-canonical-profile';
import { createNativeIndexActivation } from '../native-index-activation';
import {
  type NativeIndexSources,
  retireNativeIndexSources,
} from '../native-index-source-retirement';

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
  openIndexCoverage: async () => {
    const port: ScopedIndexerPort = mocks.readyPort();
    return {
      close: async () => undefined,
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
    profile: createDesktopProfileRuntime(() => createDesktopHostLease({ root: '/owned/profile' })),
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

it.each([
  { failedWatch: false, failure: undefined, name: 'owned cancellation' },
  {
    failedWatch: false,
    failure: new Error('Native ingestion paused.'),
    name: 'independent pause text',
  },
  {
    failedWatch: false,
    failure: new Error('independent permission failure'),
    name: 'independent permission fault',
  },
  { failedWatch: true, failure: undefined, name: 'failed watch unsubscribe' },
])(
  'joins active collection and queued workspace retirement with $name',
  async ({ failure, failedWatch }) => {
    const collectionEntered = Promise.withResolvers<void>();
    const collectionRelease = Promise.withResolvers<void>();
    const workspaceQueued = Promise.withResolvers<void>();
    const watchEntered = Promise.withResolvers<void>();
    const watchRelease = Promise.withResolvers<void>();
    const replies: object[] = [];
    const parent = new CanonicalUtilityParent((frame) => {
      replies.push(structuredClone(frame));
      queueMicrotask(() => child.receive(structuredClone(frame)));
    }, vi.fn());
    const child = new CanonicalUtilityChild((frame) =>
      queueMicrotask(() => parent.receive(structuredClone(frame)))
    );
    let workspace!: Awaited<ReturnType<CanonicalUtilityParent['attachWorkspace']>>;
    let collectionActive = false;
    let queuedId: number | undefined;
    let queuedOwner: string | undefined;
    const originalReceive = parent.receive.bind(parent);
    vi.spyOn(parent, 'receive').mockImplementation((input) => {
      const frame = decodeCanonicalFrame(input);
      if (
        collectionActive &&
        queuedId === undefined &&
        frame.kind === 'call' &&
        frame.op === 'load-files' &&
        frame.payload !== null &&
        typeof frame.payload === 'object' &&
        Reflect.get(frame.payload, 'kind') === 'workspace'
      ) {
        queuedId = frame.id;
        queuedOwner = frame.owner;
        originalReceive(input);
        workspaceQueued.resolve();
        return;
      }
      originalReceive(input);
    });
    mocks.manager.attachCanonicalWorkspace.mockImplementation(
      async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
        const inventory = dependencies.source.inventory;
        workspace = await parent.attachWorkspace({
          ...dependencies,
          source: {
            ...dependencies.source,
            inventory: {
              ...inventory,
              loadFiles: async (requested, context) => {
                try {
                  return await inventory.loadFiles(requested, context);
                } catch (error) {
                  if (failure && collectionActive) {
                    throw failure;
                  }
                  throw error;
                }
              },
            },
          },
        });
        return workspace;
      }
    );
    mocks.manager.attachCanonicalCollection.mockImplementation(
      async (dependencies: CanonicalCollectionDependencies) => {
        const inventory = dependencies.source.inventory;
        return parent.attachCollection({
          ...dependencies,
          source: {
            ...dependencies.source,
            inventory: {
              ...inventory,
              loadFiles: async (requested, context) => {
                collectionActive = true;
                collectionEntered.resolve();
                await collectionRelease.promise;
                context.signal.throwIfAborted();
                return inventory.loadFiles(requested, context);
              },
            },
          },
        });
      }
    );
    mocks.manager.retireCanonicalSources.mockImplementation(() => parent.retireAttachments());
    mocks.database.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM roots')
        ? [{ id: 'root', kind: 'path' }]
        : sql.includes('FROM embedding_sets')
          ? [{ id: 'selected' }]
          : [],
    }));
    let unsubscribeFailed = false;
    const unsubscribe = vi.fn(async () => {
      watchEntered.resolve();
      await watchRelease.promise;
      if (failedWatch && !unsubscribeFailed) {
        unsubscribeFailed = true;
        throw new Error('independent watch unsubscribe failure');
      }
    });
    const retire = vi.fn(async () => {});
    const application = {
      roots: {
        borrowSourceRoot: async (): Promise<CanonicalWorkspaceLease> => ({
          canonicalPath: '/actual/root',
          generation: 'generation',
          listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
          readFile: unused,
          retire,
          rootId: 'root',
          signal: new AbortController().signal,
          subscribe: async () => ({ close: unsubscribe }),
        }),
        restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
      },
      watches: { subscribe: unused },
    } as unknown as ApplicationIpcDomain;
    const native = writer();
    const verify = vi.fn(
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
    );
    native.verifyScopedManifest = verify;
    mocks.readyPort.mockReturnValue(native);
    const { activation, onReceipt } = fixture(application);
    const startup = activation.acquire().catch((error: unknown) => error);
    await collectionEntered.promise;
    expect(onReceipt).toHaveBeenCalledOnce();
    const verificationCalls = verify.mock.calls.length;
    await workspace.trigger();
    await workspaceQueued.promise;
    const retired = activation.close();
    const settled = retired.then(
      () => ({ ok: true }),
      (error: unknown) => ({ error, ok: false })
    );
    await watchEntered.promise;
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    watchRelease.resolve();
    await Promise.resolve();
    expect(mocks.close).not.toHaveBeenCalled();
    collectionRelease.resolve();
    const outcome = await settled;
    await startup;
    const reply = replies
      .map(decodeCanonicalFrame)
      .find(
        (frame) => frame.kind === 'result' && frame.id === queuedId && frame.owner === queuedOwner
      );
    if (failure || failedWatch) {
      expect(outcome).toMatchObject({ ok: false });
      if (failure) {
        expect(reply).toMatchObject({
          error: { message: failure.message },
          kind: 'result',
          ok: false,
        });
        expect(reply).not.toHaveProperty('cancelled', true);
      } else {
        expect(reply).toMatchObject({ cancelled: true, kind: 'result', ok: false });
      }
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.closeProfile).not.toHaveBeenCalled();
      await activation.close();
    } else {
      expect({ outcome, reply }).toEqual({
        outcome: { ok: true },
        reply: expect.objectContaining({ cancelled: true, kind: 'result', ok: false }),
      });
    }
    expect(onReceipt).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(verificationCalls);
    expect(unsubscribe).toHaveBeenCalled();
    expect(retire).toHaveBeenCalled();
    expect(child.channel.pendingCount).toBe(0);
    expect(parent.channel.pendingCount).toBe(0);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
    await parent.close();
  }
);

it('joins capabilities after a synchronous parent retirement fault and retains failed inference for retry', async () => {
  const controller = new AbortController();
  const joined = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const failure = new DOMException('independent inference retirement failure', 'AbortError');
  const parentFailure = new Error('independent parent retirement failure');
  const closeInference = vi.fn(async (): Promise<void> => {
    entered.resolve();
    await joined.promise;
    throw failure;
  });
  const inference = { close: closeInference } as unknown as NativeCanonicalInference;
  const sources: NativeIndexSources = {
    attachments: new Set(),
    controller,
    inference: new Set([inference]),
    leases: new Map(),
    workspaceTriggers: new Map(),
  };
  const retire = vi.fn((): Promise<void> => {
    expect(controller.signal.aborted).toBe(false);
    throw parentFailure;
  });
  const retirement = retireNativeIndexSources(sources, retire);
  const outcome = retirement.catch((error: unknown) => error);
  await entered.promise;
  expect(controller.signal.aborted).toBe(true);
  expect(sources.inference.has(inference)).toBe(true);
  joined.resolve();
  expect(await outcome).toMatchObject({ errors: [failure, parentFailure] });
  expect(sources.inference.has(inference)).toBe(true);
  closeInference.mockResolvedValue(undefined);
  await retireNativeIndexSources(sources, async () => {});
  expect(sources.inference.size).toBe(0);
});
