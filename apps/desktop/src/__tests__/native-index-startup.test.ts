import { createActivationCatalogFixture, forkNoUtility } from './native-activation-catalog-fixture';
// @vitest-environment node

import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import { createIndexerConnection, type IndexerConnection } from '@brainstrike/indexer/transport';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import { createNativeIndexActivation } from '../native-index-activation';
import type { NativeIndexActivationDependencies } from '../native-index-graph';
import type { NativeIndexSettings } from '../native-index-settings';
import { textSettings } from './helpers/native-index-settings';
import { restoredRoots } from './helpers/restored-roots';

/** The host's mounted folders and their watchers, which the index borrows. */
type HostFolders = NativeIndexActivationDependencies['application'];

const catalogFixture = createActivationCatalogFixture();

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  closeProfile: vi.fn(),
  closeReaders: vi.fn(),
  destroy: vi.fn(),
  manager: {
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
    start: vi.fn(),
  },
  readyPort: vi.fn(),
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
const workspace = { kind: 'workspace', rootId: 'root' } as const;
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
      scopes: [workspace],
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
function fixture(applicationOverride?: HostFolders) {
  /** Main's config owner; a test saves a change by resolving the next read with it. */
  const settings = vi.fn<() => Promise<NativeIndexSettings>>(async () => textSettings());
  const application = {
    roots: restoredRoots({ restoreRoots: async () => [] }),
    watches: {},
  } as unknown as HostFolders;
  const transport = { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) };
  const onReceipt = vi.fn();
  const onError = vi.fn();
  const activation = createNativeIndexActivation({
    application: applicationOverride ?? application,
    catalog: catalogFixture.catalog,
    databasePath: '/owned/profile/index.sqlite',
    embedding: transport,
    forkLentUtility: forkNoUtility,
    hostedEmbeddings: unused,
    modelCatalog: catalogFixture.modelCatalog,
    onError,
    onReceipt,
    profile: createDesktopProfileRuntime(() => createDesktopHostLease({ root: '/owned/profile' })),
    settings,
  });
  return { activation, onError, onReceipt, settings, transport };
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

/** Main's application domain with the one granted folder `root` mounted. */
function mountedRoot(): HostFolders {
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
  } as unknown as HostFolders;
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
        expect(result).toBeInstanceOf(NativeIndexRefusalError);
        expect((result as NativeIndexRefusalError).cause).toBe(failure);
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

// Lifecycle redesign PR D: neither a slow populated startup nor a slow request retires the utility.
it.each(['validated', 'slow-startup', 'slow-request'] as const)(
  'keeps populated startup separate from interactive requests: %s',
  async (scenario) => {
    vi.useFakeTimers();
    let message: ((frame: unknown) => void) | undefined;
    let exited: ((code: number | null) => void) | undefined;
    let connection: IndexerConnection | undefined;
    const sent: unknown[] = [];
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
        send: (frame) => {
          sent.push(frame);
        },
      });
      await connection.ready;
      return mocks.manager;
    });
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
      if (scenario === 'slow-startup') {
        // Past the former 60 s startup deadline: still waiting, never killed.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(kill).not.toHaveBeenCalled();
        expect(settled).toBe(false);
      }
      if (!message) {
        throw new Error('Expected the owned utility transport.');
      }
      const info = await writer().info();
      message({ kind: 'ready', value: info });
      await vi.advanceTimersByTimeAsync(0);
      expect(await read).toHaveProperty('info');
      expect(kill).not.toHaveBeenCalled();
      if (scenario === 'slow-request') {
        if (!connection) {
          throw new Error('Expected the owned connection.');
        }
        const nativePort = await connection.ready;
        const request = nativePort.info();
        request.catch(() => undefined);
        // Past the former 5 s request deadline: answered, never killed.
        await vi.advanceTimersByTimeAsync(7000);
        expect(kill).not.toHaveBeenCalled();
        const { id } = sent.at(-1) as { readonly id: number };
        message({ id, kind: 'response', ok: true, value: info });
        await expect(request).resolves.toEqual(info);
      }
    } finally {
      exited?.(0);
      await vi.advanceTimersByTimeAsync(0);
      await read;
      await activation.close();
      if (connection && !connection.exited) {
        await connection.close();
      }
    }
    expect(kill).not.toHaveBeenCalled();
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
    // The folder's close joins its running first scan, which ends only once `joined` resolves.
    const closeSource = vi.fn(async () => {
      canceled.resolve();
      await joined.promise;
      if (fail) {
        throw failure;
      }
    });
    mocks.manager.attachCanonicalWorkspace.mockImplementation(async () => {
      entered.resolve();
      return { close: closeSource, trigger: unused };
    });
    catalogFixture.setRoot();
    const { activation, settings } = fixture(mountedRoot());
    settings.mockResolvedValue(textSettings({ paused: true }));
    await activation.acquire();
    settings.mockResolvedValue(textSettings());
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
