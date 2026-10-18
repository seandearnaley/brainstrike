import { createActivationCatalogFixture } from './native-activation-catalog-fixture';
// @vitest-environment node

import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import { createIndexerConnection, type IndexerConnection } from '@brainstrike/indexer/transport';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeIndexActivation } from '../native-index-activation';

const catalogFixture = createActivationCatalogFixture();

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
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
  const transport = { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) };
  const onReceipt = vi.fn();
  const onError = vi.fn();
  const activation = createNativeIndexActivation({
    application: applicationOverride ?? application,
    catalog: catalogFixture.catalog,
    embedding: transport,
    modelCatalog: catalogFixture.modelCatalog,
    onError,
    onReceipt,
    profile: createDesktopProfileRuntime(() => createDesktopHostLease({ root: '/owned/profile' })),
    storage,
  });
  return { activation, onError, onReceipt, storage, transport };
}
beforeEach(() => {
  vi.resetAllMocks();
  catalogFixture.reset();

  mocks.acquire.mockResolvedValue(writer());
  mocks.readyPort.mockReturnValue(writer());
  mocks.close.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.closeReaders.mockResolvedValue(undefined);
  mocks.closeProfile.mockResolvedValue(undefined);
  mocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  mocks.manager.start.mockResolvedValue(writer());
});

afterEach(() => {
  vi.useRealTimers();
});

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

it.each(['startup', 'cleanup'] as const)(
  'retains the original owner failure across read polls: %s',
  async (scenario) => {
    const startupError = new Error('Indexer readiness deadline exceeded.');
    const failure =
      scenario === 'cleanup'
        ? new AggregateError(
            [startupError, new Error('Indexer exit join failed.')],
            'Startup cleanup failed.'
          )
        : startupError;
    mocks.acquire.mockRejectedValue(failure);
    const { activation, onError } = fixture();
    const reportStartupError = vi.fn();
    const initialStartup = activation.acquire().catch(reportStartupError);
    try {
      for (let poll = 0; poll < 3; poll += 1) {
        const result = await activation.acquireRead().then(
          () => undefined,
          (error: unknown) => error
        );
        if (scenario === 'cleanup') {
          expect(result).toBe(failure);
        } else {
          expect(result).toBeInstanceOf(NativeIndexRefusalError);
          expect((result as NativeIndexRefusalError).cause).toBe(failure);
        }
      }
      expect(mocks.acquire).toHaveBeenCalledOnce();
      await initialStartup;
      expect(reportStartupError).toHaveBeenCalledOnce();
      expect(reportStartupError).toHaveBeenCalledWith(failure);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await activation.close();
    }
  }
);

it.each(['validated', 'deadline', 'request'] as const)(
  'keeps populated startup separate from interactive requests: %s',
  async (scenario) => {
    vi.useFakeTimers();
    let message: ((frame: unknown) => void) | undefined;
    let exited: (() => void) | undefined;
    let connection: IndexerConnection | undefined;
    const kill = vi.fn(() => true);
    mocks.acquire.mockImplementation(async (options: unknown, deadlines: unknown) => {
      connection = createIndexerConnection(options, deadlines, {
        kill,
        onError: () => () => {},
        onExit: (listener) => {
          exited = listener;
          return () => {};
        },
        onMessage: (listener) => {
          message = listener;
          return () => {};
        },
        send: () => {},
      });
      await connection.ready;
      return mocks.manager;
    });
    mocks.manager.attachCanonicalCollection.mockImplementation(emptyCollection);
    const { activation } = fixture();
    let settled = false;
    const read = activation.acquireRead().then(
      (port) => {
        settled = true;
        return port;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.acquire).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    try {
      expect(settled).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      if (scenario === 'deadline') {
        await vi.advanceTimersByTimeAsync(29_999);
        expect(kill).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(kill).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
      } else {
        if (!message) {
          throw new Error('Expected the owned utility transport.');
        }
        message({ kind: 'ready', value: await writer().info() });
        await vi.advanceTimersByTimeAsync(0);
        expect(await read).toHaveProperty('info');
        expect(kill).not.toHaveBeenCalled();
        if (scenario === 'request') {
          if (!connection) {
            throw new Error('Expected the owned connection.');
          }
          const nativePort = await connection.ready;
          const request = nativePort.info().catch((error: unknown) => error);
          await vi.advanceTimersByTimeAsync(4999);
          expect(kill).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(2);
          expect(kill).toHaveBeenCalledOnce();
          exited?.();
          await expect(request).resolves.toMatchObject({ code: 'indexer-request-timeout' });
        }
      }
    } finally {
      exited?.();
      await vi.advanceTimersByTimeAsync(0);
      await read;
      await activation.close();
      if (connection && !connection.exited) {
        await connection.close();
      }
    }
    if (scenario === 'deadline') {
      const failure = await read;
      expect(failure).toBeInstanceOf(NativeIndexRefusalError);
      expect((failure as NativeIndexRefusalError).cause).toMatchObject({
        code: 'indexer-startup-timeout',
      });
    }
  }
);

it('fences late profile acquisition before physical retirement while window startup joins', async () => {
  const { activation } = fixture();
  await activation.acquireProfile();
  await activation.fenceTerminal();
  await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  await activation.close();
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'fences admission synchronously during blocked source reconfiguration and retains cleanup failure=%s',
  async (fail) => {
    const entered = Promise.withResolvers<void>();
    const canceled = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const failure = new Error('Independent source retirement failure');
    const closeSource = vi.fn(async () => {
      canceled.resolve();
      if (fail) {
        throw failure;
      }
    });
    mocks.manager.attachCanonicalCollection.mockImplementation(
      (dependencies: CanonicalCollectionDependencies) => {
        const collection = emptyCollection(dependencies, closeSource);
        return {
          ...collection,
          scan: async (requestId: string) => {
            entered.resolve();
            await canceled.promise;
            await joined.promise;
            return collection.scan(requestId);
          },
        };
      }
    );
    const { activation, storage } = fixture();
    const settings = JSON.parse(await storage.getItem()) as { state: { paused: boolean } };
    settings.state.paused = true;
    storage.getItem.mockResolvedValue(JSON.stringify(settings));
    await activation.acquire();
    settings.state.paused = false;
    storage.getItem.mockResolvedValue(JSON.stringify(settings));
    const reconfiguration = activation.reconfigure().catch((error: unknown) => error);
    onTestFinished(async () => {
      canceled.resolve();
      joined.resolve();
      await reconfiguration;
      closeSource.mockResolvedValue(undefined);
      await activation.close();
    });
    await entered.promise;
    let fenced = false;
    const fence = Promise.resolve(activation.fenceTerminal()).then(() => {
      fenced = true;
    });
    await Promise.resolve();
    expect(fenced).toBe(true);
    await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
    expect(closeSource).not.toHaveBeenCalled();
    let retired = false;
    const retirement = activation.close().then(
      () => {
        retired = true;
        return;
      },
      (error: unknown) => {
        retired = true;
        return error;
      }
    );
    await canceled.promise;
    expect(closeSource).toHaveBeenCalledOnce();
    expect(retired).toBe(false);
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    joined.resolve();
    const outcome = await retirement;
    if (fail) {
      expect(outcome).toMatchObject({ errors: [failure] });
      expect(mocks.closeProfile).not.toHaveBeenCalled();
    } else {
      expect(outcome).toBeUndefined();
      expect(mocks.closeProfile).toHaveBeenCalledOnce();
    }
    await fence;
    expect(await reconfiguration).toBeInstanceOf(Error);
  }
);
