import { createActivationCatalogFixture } from './native-activation-catalog-fixture';
// @vitest-environment node

import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { CanonicalRemoteWorkspaceDependencies } from '../canonical-utility-parent';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeIndexActivation } from '../native-index-activation';
import type { NativeIndexSettings } from '../native-index-settings';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import { textSettings, unreadableSettings, vectorSettings } from './helpers/native-index-settings';
import { restoredRoots } from './helpers/restored-roots';

const catalogFixture = createActivationCatalogFixture();

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  closeProfile: vi.fn(),
  closeReaders: vi.fn(),
  destroy: vi.fn(),
  /** Main's hosted document embedder (`generateHostedEmbeddings`). */
  hostedEmbeddings: vi.fn(),
  manager: {
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
    start: vi.fn(),
  },
  readyHost: vi.fn(),
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
  createDesktopHostLease: () => ({ acquire: async () => {}, close: mocks.closeProfile }),
}));
vi.mock('../indexer-runtime', () => ({
  acquireIndexerHost: mocks.acquire,
  closeIndexerRuntime: mocks.close,
  destroyIndexerRuntime: mocks.destroy,
  fenceIndexerCanonicalSources: vi.fn(),
  getReadyIndexerHost: mocks.readyHost,
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
    commitScopedFile: unused,
    commitScopedTextFile: unused,
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
  mocks.readyHost.mockReturnValue(mocks.manager);
  mocks.readyPort.mockReturnValue(writer());
  mocks.close.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.closeReaders.mockResolvedValue(undefined);
  mocks.closeProfile.mockResolvedValue(undefined);
  mocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  mocks.manager.start.mockResolvedValue(writer());
});

/** A folder attachment whose first scan finds no files and completes. */
async function emptyWorkspace(
  dependencies: CanonicalRemoteWorkspaceDependencies,
  close = async (): Promise<void> => {}
) {
  const ticket = await dependencies.publication.beginScan({
    requestId: 'folder-scan',
    scope: workspace,
  });
  dependencies.onReceipt(
    await dependencies.publication.finishScan({
      ...{ aborted: false, errors: [], files: [], full: true, truncatedDirectories: [] },
      ticket,
    })
  );
  return { close, trigger: unused };
}

/** Saves Pause or Resume over the current saved settings. */
async function savePause(
  settings: ReturnType<typeof fixture>['settings'],
  paused: boolean
): Promise<void> {
  settings.mockResolvedValue({ ...(await settings()), paused });
}

it('boots cold paused status, coverage and grep with actual authority and no canonical source admission', async () => {
  const native = {
    ...writer(),
    coverageScope: vi.fn<ScopedIndexerPort['coverageScope']>(async ({ scope }) => ({
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
  native.coverageBatch = async (input) =>
    Promise.all((input as readonly unknown[]).map((request) => native.coverageScope(request)));
  mocks.readyPort.mockReturnValue(native);
  catalogFixture.setRoot();
  const { activation, settings, hostedEmbeddings, onReceipt } = fixture(mountedRoot());
  await savePause(settings, true);
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
    identity: { storeId },
    matchedChunks: 0,
    rows: [],
    truncated: false,
  }));
  const search = createNativeScopedSearchCapability({
    openQuery: async () => ({ close: async () => {}, grep }),
    rebuild: activation.rebuild,
    withRead: activation.withRead,
  });
  // Boot's reader starts the index; reads never do (BST-2277).
  await activation.acquireRead();
  expect(await search.status()).toMatchObject({
    kind: 'ready',
    rootReadiness: [{ rootId: 'root', scanComplete: false }],
    storeId,
  });
  expect(await search.coverage({ rootIds: ['root'] })).toMatchObject({
    totals: { chunks: 0, indexedFiles: 0, vectors: 0 },
    vectorCoverageComplete: false,
  });
  expect(
    await search.grep({
      caseSensitive: false,
      isRegex: false,
      limit: 100,
      pattern: '',
      rootIds: ['root'],
    })
  ).toMatchObject({ hits: [], scanLimited: true });
  expect(grep).toHaveBeenCalledOnce();
  expect(mocks.manager.attachCanonicalWorkspace).not.toHaveBeenCalled();
  expect(hostedEmbeddings).not.toHaveBeenCalled();
  expect(onReceipt).not.toHaveBeenCalled();
  await activation.close();
});

it('retains a completed native reader and original cleanup authority through pause then resumes actual sources', async () => {
  const close = vi.fn(async () => {});
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    (dependencies: CanonicalRemoteWorkspaceDependencies) => emptyWorkspace(dependencies, close)
  );
  catalogFixture.setRoot();
  const { activation, settings } = fixture(mountedRoot());
  const native = await activation.acquire();
  const captured = activation.captureAcknowledgedAuthority();
  const before = await activation.getSearchAuthority();
  const readerCloses = mocks.closeReaders.mock.calls.length;
  await savePause(settings, true);
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
  await savePause(settings, false);
  await activation.reconfigure();
  expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledTimes(2);
  expect(mocks.acquire).toHaveBeenCalledOnce();
  expect((await activation.getSearchAuthority()).readiness).toContainEqual(
    expect.objectContaining({
      scanComplete: true,
      scope: workspace,
    })
  );
  await activation.close();
});

it('joins an admitted physical scan before pause acknowledges and retains the reader afterward', async () => {
  const physical = Promise.withResolvers<void>();
  const close = vi.fn(() => physical.promise);
  // The folder's first scan never reports: only its close ends it.
  mocks.manager.attachCanonicalWorkspace.mockResolvedValue({ close, trigger: unused });
  catalogFixture.setRoot();
  const { activation, settings } = fixture(mountedRoot());
  const starting = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledOnce());
  const native = await activation.acquireRead();
  await savePause(settings, true);
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
  expect((await activation.getSearchAuthority()).readiness).toContainEqual(
    expect.objectContaining({
      scanComplete: false,
      scope: workspace,
    })
  );
  await activation.close();
});

it('retains failed pause cleanup for explicit retry and keeps reset behind that physical owner', async () => {
  const cause = new Error('Pause attachment still physically owned.');
  const close = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    (dependencies: CanonicalRemoteWorkspaceDependencies) => emptyWorkspace(dependencies, close)
  );
  catalogFixture.setRoot();
  const { activation, settings } = fixture(mountedRoot());
  await activation.acquire();
  await savePause(settings, true);
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
  catalogFixture.setRoot();
  const f = fixture(mountedRoot());
  const profile = {
    dimensions: 1536,
    distance: 'cosine',
    modelId: 'text-embedding-3-small',
    provider: 'openai',
  } as const;
  // Collection and model metadata come from the current canonical catalog fixture.
  f.settings.mockResolvedValue(
    vectorSettings(
      {
        model: {
          dimensions: profile.dimensions,
          modelKey: `${profile.provider}::${profile.modelId}`,
        },
        paused: true,
      },
      'selected'
    )
  );
  return { ...f, profile };
}

it('opens cold paused VECTOR authority with the exact saved query model and zero document inference', async () => {
  const { activation, hostedEmbeddings, profile } = vectorPauseFixture();
  await activation.acquireRead();
  const authority = await activation.getSearchAuthority();
  expect(authority.profile).toEqual(profile);
  expect(authority).toMatchObject({
    profile,
    queryPlan: { modelKey: `${profile.provider}::${profile.modelId}` },
    readiness: [expect.objectContaining({ scanComplete: false, scope: workspace })],
  });
  expect(mocks.manager.attachCanonicalWorkspace).not.toHaveBeenCalled();
  expect(hostedEmbeddings).not.toHaveBeenCalled();
  await activation.close();
});

it('joins actual document adapter cancellation before Pause acknowledges and keeps VECTOR read authority', async () => {
  const { activation, settings, hostedEmbeddings, profile } = vectorPauseFixture();
  await savePause(settings, false);
  const physical = Promise.withResolvers<void>();
  let inferenceSignal: AbortSignal | undefined;
  hostedEmbeddings.mockImplementation(async (input: { readonly signal: AbortSignal }) => {
    inferenceSignal = input.signal;
    await physical.promise;
    throw input.signal.reason;
  });
  // The folder's first scan embeds its documents; only the actual cancellation ends it.
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
      if (dependencies.mode !== 'VECTOR') {
        throw new Error('Expected explicit VECTOR source.');
      }
      await dependencies.inference.generate({
        chunks: [{ chunkId: 'chunk', content: 'actual canonical text' }],
        profile,
        requestId: 'held-documents',
      });
      throw new Error('Unexpected completed inference.');
    }
  );
  const starting = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(hostedEmbeddings).toHaveBeenCalledOnce());
  await savePause(settings, true);
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
    readiness: [expect.objectContaining({ scanComplete: false, scope: workspace })],
  });
  expect(mocks.acquire).toHaveBeenCalledOnce();
  await activation.close();
});

it('starts exact document cancellation before waiting for an admitted native read on close', async () => {
  const { activation, settings, hostedEmbeddings, profile } = vectorPauseFixture();
  await savePause(settings, false);
  const physical = Promise.withResolvers<void>();
  let inferenceSignal: AbortSignal | undefined;
  hostedEmbeddings.mockImplementation(async (input: { readonly signal: AbortSignal }) => {
    inferenceSignal = input.signal;
    await physical.promise;
    throw input.signal.reason;
  });
  // The folder's first scan embeds its documents; only the actual cancellation ends it.
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
      if (dependencies.mode !== 'VECTOR') {
        throw new Error('Expected explicit VECTOR source.');
      }
      await dependencies.inference.generate({
        chunks: [{ chunkId: 'chunk', content: 'actual canonical text' }],
        profile,
        requestId: 'held-documents',
      });
      throw new Error('Unexpected completed inference.');
    }
  );
  const starting = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(hostedEmbeddings).toHaveBeenCalledOnce());
  const read = Promise.withResolvers<void>();
  const readEntered = Promise.withResolvers<void>();
  const reading = activation.withRead(async () => {
    readEntered.resolve();
    await read.promise;
  });
  await readEntered.promise;
  let paused = false;
  const pausing = activation.close().then(() => {
    paused = true;
  });
  onTestFinished(async () => {
    read.resolve();
    physical.resolve();
    await Promise.allSettled([reading, pausing, starting]);
  });
  await vi.waitFor(() => expect(inferenceSignal?.aborted).toBe(true));
  expect(paused).toBe(false);
  expect(mocks.close).not.toHaveBeenCalled();
  physical.resolve();
  expect(paused).toBe(false);
  read.resolve();
  await reading;
  await pausing;
  expect(await starting).toBeInstanceOf(Error);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('retires source borrows on Pause while the original mounted read-authority borrow remains live', async () => {
  const leases: CanonicalWorkspaceLease[] = [];
  const application = {
    roots: restoredRoots({
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
    }),
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  catalogFixture.setRoot();
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
  mocks.manager.attachCanonicalWorkspace.mockImplementation(emptyWorkspace);
  const { activation, settings } = fixture(application);
  await savePause(settings, true);
  await activation.acquireRead();
  expect(leases).toHaveLength(1);
  expect(leases[0]?.subscribe).not.toHaveBeenCalled();
  await savePause(settings, false);
  await activation.reconfigure();
  expect(leases).toHaveLength(2);
  await vi.waitFor(() =>
    expect(activation.getReadiness().every(({ scanComplete }) => scanComplete)).toBe(true)
  );
  await savePause(settings, true);
  await activation.reconfigure();
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
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    (dependencies: CanonicalRemoteWorkspaceDependencies) => emptyWorkspace(dependencies, close)
  );
  catalogFixture.setRoot();
  const { activation, settings } = fixture(mountedRoot());
  await activation.acquire();
  await savePause(settings, true);
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

it('revokes old read authority when the newly saved settings are refused', async () => {
  const { activation, settings } = fixture();
  await activation.acquire();
  const refused = unreadableSettings();
  settings.mockRejectedValue(refused);
  await expect(activation.reconfigure()).rejects.toBe(refused);
  await expect(activation.acquireRead()).rejects.toMatchObject({
    cause: refused,
    refusal: { kind: 'settings-invalid' },
  });
  expect(mocks.acquire).toHaveBeenCalledOnce();
  await activation.close();
});

it('fences reads and joins a held settings read before terminal retirement acknowledges', async () => {
  const { activation, settings } = fixture();
  await activation.acquire();
  const saved = await settings();
  const reading = Promise.withResolvers<NativeIndexSettings>();
  settings.mockReturnValueOnce(reading.promise);
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
  const { activation, settings } = fixture();
  await activation.acquire();
  await savePause(settings, true);
  const cause = new Error('Actual indexer owner is terminally closed.');
  mocks.manager.start.mockRejectedValueOnce(cause);
  await expect(activation.reconfigure()).rejects.toBe(cause);
  await expect(activation.acquireRead()).rejects.toMatchObject({
    cause,
    code: 'native-index-source-failure',
    name: NativeIndexRefusalError.name,
  });
  await expect(activation.acquire()).rejects.toMatchObject({
    cause,
    refusal: { kind: 'source-failure' },
  });
  await activation.reconfigure();
  await activation.acquireRead();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  await activation.close();
});
