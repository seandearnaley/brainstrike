// @vitest-environment node

import { join } from 'node:path';
import type {
  CanonicalScanReceipt,
  CanonicalVectorPublicationPort,
  CanonicalWorkspaceRuntimeDependencies,
  NativeCanonicalCatalogRecord,
} from '@brainstrike/canonical-ingestion';
import {
  DEFAULT_MAX_FILE_SIZE,
  resetFileSizeConfig,
  setFileSizeConfig,
} from '@brainstrike/file-system';
import { readResolvedWorkspaceFile } from '@brainstrike/file-system/secure-file-read';
import {
  type ScopedFilePlan,
  type ScopedIndexerPort,
  vectorProfileHash,
} from '@brainstrike/indexer';
import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalRemoteWorkspaceDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import { decodeCanonicalFrame } from '../canonical-utility-protocol';
import type { NativeIndexActivationDependencies } from '../native-index-graph';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import { textSettings, vectorSettings } from './helpers/native-index-settings';
import { restoredRoots } from './helpers/restored-roots';
import {
  createActivation,
  emptyWorkspace,
  fixture,
  mocks,
  mountedRoot,
  requestedScope,
  resetActivationFixture,
  setCatalogRecords,
  setCatalogRoot,
  storeId,
  unused,
  workspace,
  workspaceLease,
  writer,
} from './native-index-activation-fixture';

/** The host's mounted folders and their watchers, which the index borrows. */
type HostFolders = NativeIndexActivationDependencies['application'];

beforeEach(resetActivationFixture);
afterEach(resetFileSizeConfig);

/** The profile the saved `selected` space resolves to: MiniLM run locally at its pinned revision. */
const miniLm = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  // The catalog row states MiniLM's prompts (none), so the resolved profile carries them.
  prompts: { document: '', query: '' },
  provider: 'transformers',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
} as const;
/** Semantic search saved over the `selected` space with the model its catalog row names. */
const semanticSettings = () =>
  vectorSettings(
    {
      model: {
        dimensions: miniLm.dimensions,
        local: { device: 'wasm', dtype: miniLm.dtype, revision: miniLm.revision },
        modelKey: `local::${miniLm.modelId}`,
      },
    },
    'selected'
  );

it('acquires the workspace index.sqlite with no state truth root or projection', async () => {
  const { activation } = fixture();
  try {
    await activation.acquire();
  } finally {
    await activation.close();
  }
  // The host's own state-index.sqlite owns state rows; this file must never project them too.
  expect(mocks.acquire).toHaveBeenCalledOnce();
  const [options] = mocks.acquire.mock.calls[0] ?? [];
  expect(options).toMatchObject({ dbPath: join('/owned/profile', 'index.sqlite') });
  expect(options).not.toHaveProperty('stateRoot');
  expect(options).not.toHaveProperty('stateProjection');
  expect(options).not.toHaveProperty('stateResources');
});

it.each([DEFAULT_MAX_FILE_SIZE, 4096])(
  'activates ordinary TEXT source reads with the actual configured %i-byte limit',
  async (maxFileSize) => {
    setFileSizeConfig({ maxFileSize });
    const readFile = vi.fn(async (_relativePath: string, _maxBytes: number) => ({
      content: Buffer.from('ordinary source'),
      status: 'ok' as const,
    }));
    mocks.manager.attachCanonicalWorkspace.mockImplementation(
      async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
        const content = await readResolvedWorkspaceFile(
          '/actual/root/ordinary.txt',
          {
            mounted: { root: { readFile } },
            relativePath: 'ordinary.txt',
            traversedSymlink: false,
          },
          dependencies.request.maxFileBytes
        );
        expect(content).toBe('ordinary source');
        return emptyWorkspace(dependencies);
      }
    );
    setCatalogRoot();
    const { activation, onReceipt, transport } = fixture(mountedRoot());
    try {
      await activation.acquire();
      expect(readFile).toHaveBeenCalledExactlyOnceWith('ordinary.txt', maxFileSize);
      expect(onReceipt).toHaveBeenCalledOnce();
      expect(transport.documentEmbeddings).not.toHaveBeenCalled();
    } finally {
      await activation.close();
    }
  }
);

it('joins real late source cancellation before closing the native engine and profile owner', async () => {
  const request = Promise.withResolvers<object>();
  const cancelled = Promise.withResolvers<object>();
  const parent = new CanonicalUtilityParent(
    (frame) => queueMicrotask(() => child.receive(structuredClone(frame))),
    vi.fn()
  );
  const child = new CanonicalUtilityChild((input) => {
    const frame = decodeCanonicalFrame(input);
    if (frame.kind === 'call' && frame.op === 'load-files') {
      request.resolve(structuredClone(input));
      return;
    }
    if (frame.kind === 'cancel') {
      cancelled.resolve(structuredClone(input));
      return;
    }
    queueMicrotask(() => parent.receive(structuredClone(input)));
  });
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    (dependencies: CanonicalRemoteWorkspaceDependencies) => parent.attachWorkspace(dependencies)
  );
  mocks.manager.retireCanonicalSources.mockImplementation(() => parent.retireAttachments());
  setCatalogRoot();
  const { activation } = fixture(
    mountedRoot(
      workspaceLease({
        listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
        subscribe: async () => ({ close: async () => {} }),
      })
    )
  );
  const initial = activation.acquire().catch((error: unknown) => error);
  const held = await request.promise;
  const retirement = activation.close();
  const notice = await cancelled.promise;
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  parent.receive(held);
  parent.receive(notice);
  await retirement;
  await initial;
  expect(child.channel.pendingCount).toBe(0);
  expect(parent.channel.pendingCount).toBe(0);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
  await parent.close();
});

it('closes an admitted initial folder scan before joining startup, and joins physical retirement', async () => {
  const physical = Promise.withResolvers<void>();
  const close = vi.fn(() => physical.promise);
  // The folder's first scan never reports: only its close ends it.
  mocks.manager.attachCanonicalWorkspace.mockResolvedValue({ close, trigger: unused });
  setCatalogRoot();
  const { activation } = fixture(mountedRoot());
  const initial = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledOnce());
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

it('rebuilds only the derived writer with the saved settings and no inference or application deletion', async () => {
  const close = vi.fn(async () => {});
  const modes: CanonicalRemoteWorkspaceDependencies['mode'][] = [];
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
      modes.push(dependencies.mode);
      return emptyWorkspace(dependencies, close);
    }
  );
  setCatalogRoot();
  const { activation, settings, transport, onReceipt } = fixture(mountedRoot());
  await activation.acquire();
  await activation.rebuild();
  expect(modes).toEqual(['TEXT', 'TEXT']);
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  expect(transport.documentEmbeddings).not.toHaveBeenCalled();
  expect(settings).toHaveBeenCalledTimes(2);
  expect(
    mocks.catalog.sourceCatalog.mock.calls.every(([request]) =>
      ['inventory', 'read'].includes(request.operation)
    )
  ).toBe(true);
  expect(onReceipt).toHaveBeenCalledTimes(2);
  await activation.close();
});

it('retains a failed source close and refuses derived deletion until explicit retirement retry', async () => {
  const cause = new Error('Source remains physically owned.');
  const close = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    (dependencies: CanonicalRemoteWorkspaceDependencies) => emptyWorkspace(dependencies, close)
  );
  setCatalogRoot();
  const { activation } = fixture(mountedRoot());
  await activation.acquire();
  await expect(activation.destroyAndRetireProfile()).rejects.toMatchObject({ errors: [cause] });
  expect(mocks.destroy).not.toHaveBeenCalled();
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  await expect(activation.acquire()).rejects.toThrow('closed');
  await activation.destroyAndRetireProfile();
  expect(close).toHaveBeenCalledTimes(2);
  expect(mocks.destroy).toHaveBeenCalledOnce();
});

it('exposes actual native progress while the initial folder scan is still running', async () => {
  mocks.manager.attachCanonicalWorkspace.mockResolvedValue({
    close: async () => {},
    trigger: unused,
  });
  setCatalogRoot();
  const { activation } = fixture(mountedRoot());
  const initial = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledOnce());
  const scanSettled = vi.fn();
  void initial.then(scanSettled);
  // The first read opens while the scan still runs.
  await activation.acquireRead();
  expect(scanSettled).not.toHaveBeenCalled();
  expect((await activation.acquireRead()).info).toBeTypeOf('function');
  expect(await activation.getSearchAuthority()).toMatchObject({
    readiness: [expect.objectContaining({ scanComplete: false, scope: workspace })],
    rootIds: ['root'],
  });
  await activation.close();
  expect(await initial).toBeInstanceOf(Error);
});

/** The folder's text-search source rows. */
function catalogRows(count: number): NativeCanonicalCatalogRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    chunksProcessed: true,
    content: null,
    contentHash: 'c'.repeat(64),
    embeddingSetId: null,
    fileId: `retained-${index}`,
    fileName: `retained-${index}.txt`,
    path: `retained-${index}.txt`,
    rootId: 'root',
    stat: { mtimeMs: 1, size: 1 },
  }));
}
it.each(['close', 'destroyAndRetireProfile'] as const)(
  'fences and joins held reconfiguration before %s acknowledges terminal retirement',
  async (operation) => {
    const { activation, settings } = fixture();
    await activation.acquire();
    const writerExit = Promise.withResolvers<void>();
    const destroyed = Promise.withResolvers<void>();
    if (operation === 'destroyAndRetireProfile') {
      mocks.destroy.mockReturnValueOnce(destroyed.promise);
    }
    onTestFinished(() => {
      writerExit.resolve();
      destroyed.resolve();
    });
    mocks.close.mockReturnValueOnce(writerExit.promise);
    settings.mockResolvedValue(textSettings({ policy: 'full-root' }));
    const changing = activation.reconfigure().catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    let terminalSettled = false;
    const terminal = activation[operation]().then(() => {
      terminalSettled = true;
    });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);
    writerExit.resolve();
    if (operation === 'destroyAndRetireProfile') {
      await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce());
      // The previous writer has physically closed. Clear must borrow a cold,
      // authority-free owner to remove its retained on-disk index as well.
      expect(mocks.acquire).toHaveBeenCalledTimes(2);
      expect(mocks.acquire.mock.calls[1]?.[0]).toMatchObject({
        fileBindings: [],
        rootIds: [],
        scopes: [],
      });
      expect(terminalSettled).toBe(false);
      expect(mocks.closeProfile).not.toHaveBeenCalled();
      destroyed.resolve();
    } else {
      expect(mocks.acquire).toHaveBeenCalledOnce();
      expect(mocks.destroy).not.toHaveBeenCalled();
    }
    await Promise.all([changing, terminal]);
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
    await expect(activation.acquireRead()).rejects.toThrow('closed');
  }
);

it('refuses a nonexistent saved vector space before opening a writer or completing a receipt', async () => {
  mocks.catalog.collections.mockResolvedValue({ collections: [] });
  setCatalogRoot();
  const { activation, onReceipt, settings } = fixture(mountedRoot());
  settings.mockResolvedValue(semanticSettings());
  await expect(activation.acquire()).rejects.toThrow('saved native collection is missing');
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(onReceipt).not.toHaveBeenCalled();
  expect(mocks.manager.attachCanonicalWorkspace).not.toHaveBeenCalled();
  await activation.close();
});

it.each([251, 1501])(
  'loads the entire %i-file inventory through bounded actual catalog batches',
  async (count) => {
    const records = catalogRows(count);
    setCatalogRecords(() => records);
    let inventory: readonly { readonly fileId: string }[] = [];
    mocks.manager.attachCanonicalWorkspace.mockImplementation(
      async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
        inventory = await dependencies.source.inventory.loadFiles(workspace, {
          requestId: 'inventory',
          signal: new AbortController().signal,
        });
        return emptyWorkspace(dependencies);
      }
    );
    setCatalogRoot();
    const { activation } = fixture(mountedRoot());
    await activation.acquire();
    expect(inventory.map((file) => file.fileId)).toEqual(records.map((record) => record.fileId));
    const batches = mocks.catalog.sourceCatalog.mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation === 'read');
    expect(batches).toHaveLength(2 * Math.ceil(count / 250));
    expect(batches.every((request) => request.fileIds.length <= 250)).toBe(true);
    await activation.close();
  }
);

it('keeps captured cleanup authority through expected source abort and refuses it after writer retirement', async () => {
  const { activation } = fixture();
  await activation.acquire();
  const captured = activation.captureAcknowledgedAuthority();
  const authority = captured.readAuthority();
  await activation.stopSources();
  expect(captured.readAuthority()).toEqual(authority);
  expect(captured.port.info).toBe(mocks.readyPort().info);
  expect(captured.port.coverageBatch).not.toBe(mocks.readyPort().coverageBatch);
  await activation.close();
  expect(() => captured.readAuthority()).toThrow();
});

it('joins retained rooted-row convergence before admitting the replacement writer to reads', async () => {
  const lease = workspaceLease({ retire: vi.fn(async () => {}) });
  const application = {
    roots: restoredRoots({
      borrowSourceRoot: vi
        .fn()
        .mockResolvedValueOnce(lease)
        .mockImplementation(async () => ({
          ...lease,
          generation: 'source-borrow',
          retire: async () => {},
        })),
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    }),
    watches: { subscribe: unused },
  } as unknown as HostFolders;
  // The folder's semantic-search row: once text search is saved, no binding owns it.
  const records: NativeCanonicalCatalogRecord[] = [
    {
      chunksProcessed: true,
      content: null,
      contentHash: 'c'.repeat(64),
      embeddingSetId: 'selected',
      fileId: 'retained-0',
      fileName: 'file.txt',
      path: 'file.txt',
      rootId: 'root',
      stat: { mtimeMs: 1, size: 1 },
    },
  ];
  setCatalogRoot();
  setCatalogRecords(() => records);
  const removal = Promise.withResolvers<boolean>();
  let retired = false;
  const native = {
    ...writer(),
    removeScopedFile: vi.fn(async () => {
      const removed = await removal.promise;
      retired = true;
      return removed;
    }),
    verifyScopedManifest: vi.fn(
      async (request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]) => ({
        authorityEpoch: 'b'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: requestedScope(request),
        storeId,
        unexpected:
          mocks.acquire.mock.calls.length >= 2 &&
          !retired &&
          requestedScope(request).kind === 'workspace'
            ? [
                {
                  chunks: [],
                  contentHash: 'c'.repeat(64),
                  embeddingSetId: 'selected',
                  fileId: 'retained-0',
                  relativePath: 'file.txt',
                  rootId: 'root',
                  sourcePath: '/actual/root/file.txt',
                },
              ]
            : [],
      })
    ),
  };
  mocks.readyPort.mockReturnValue(native);
  mocks.manager.attachCanonicalWorkspace.mockImplementation(emptyWorkspace);
  const { activation, settings } = fixture(application);
  settings.mockResolvedValue(semanticSettings());
  await activation.acquire();
  settings.mockResolvedValue(textSettings());
  const changing = activation.reconfigure();
  await vi.waitFor(() => expect(native.removeScopedFile).toHaveBeenCalledOnce());
  expect(native.removeScopedFile).toHaveBeenCalledWith({ fileId: 'retained-0', scope: workspace });
  expect(lease.retire).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  await expect(activation.acquireRead()).rejects.toThrow('transitioning');
  removal.resolve(true);
  await changing;
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  expect((await activation.getSearchAuthority()).collectionId).toBeNull();
  await activation.close();
});

it('finishes folder VECTOR startup with its verified receipt and no missing-vector inference', async () => {
  const record = {
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
  setCatalogRoot();
  setCatalogRecords(() => [record]);
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
    profile: miniLm,
    profileHash: vectorProfileHash(miniLm),
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
    prepareScopedFile: vi.fn(async () => plan),
    verifyScopedManifest: vi.fn(writer().verifyScopedManifest),
  };
  mocks.readyPort.mockReturnValue(native);
  const publish = async (
    publication: CanonicalVectorPublicationPort
  ): Promise<CanonicalScanReceipt> => {
    const ticket = await publication.beginScan({ requestId: 'folder-scan', scope: workspace });
    const prepared = await publication.prepareVectorFile({
      file: identity,
      payload: { content: 'canonical', fileId: identity.fileId, providedChunks },
      profile: miniLm,
      ticket,
    });
    await publication.commitVectorFile({
      embeddings: [],
      file: identity,
      plan: prepared,
      profile: miniLm,
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
      dependencies.onReceipt(await publish(dependencies.publication));
      return { close: async () => {}, trigger: unused };
    }
  );
  const documentEmbeddings = vi.fn(unused);
  const activation = createActivation({
    application: mountedRoot(),
    databasePath: '/owned/profile/index.sqlite',
    embedding: { destroyAndRestart: vi.fn(), documentEmbeddings },
    hostedEmbeddings: unused,
    onError: vi.fn(),
    settings: async () => semanticSettings(),
  });
  await activation.acquire();
  expect(activation.getReadiness()).toMatchObject([{ scanComplete: true, scope: workspace }]);
  expect(documentEmbeddings).not.toHaveBeenCalled();
  expect(native.commitScopedFile).toHaveBeenCalledOnce();
  // The opened writer lists the stored rows of its folder and of its vector space once
  // each (no files declared, BST-1988/BST-2011), then the folder's scan proves its file.
  const manifests = vi
    .mocked(native.verifyScopedManifest)
    .mock.calls.map(([input]) => (input as { readonly files: readonly unknown[] }).files.length);
  expect(manifests.filter((declared) => declared === 0)).toHaveLength(2);
  expect(manifests.filter((declared) => declared > 0)).toHaveLength(1);
  await activation.close();
});

it('joins physical grep disposal before retiring read authority during a genuine settings replacement', async () => {
  setCatalogRoot();
  const f = fixture(mountedRoot());
  f.settings.mockResolvedValue(textSettings({ paused: true }));
  const disposing = Promise.withResolvers<void>();
  const disposed = Promise.withResolvers<void>();
  const close = vi.fn(async () => {
    disposing.resolve();
    await disposed.promise;
  });
  const capability = createNativeScopedSearchCapability({
    openQuery: async () => ({
      close,
      grep: async () => ({
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
      }),
    }),
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  });
  // Boot's reader starts the index; reads never do (BST-2277).
  await f.activation.acquireRead();
  const pending = capability
    .grep({
      caseSensitive: false,
      isRegex: false,
      limit: 10,
      pattern: 'marker',
      rootIds: ['root'],
    })
    .catch((error: unknown) => error);
  await disposing.promise;
  f.settings.mockResolvedValue(textSettings({ mode: 'off', paused: true }));
  const replacing = f.activation.reconfigure().catch((error: unknown) => error);
  // Turning search off retires the live generation's authority with that typed choice.
  await vi.waitFor(() =>
    expect(() => f.activation.captureAcknowledgedAuthority()).toThrow(
      expect.objectContaining({ code: 'native-index-off' })
    )
  );
  expect(mocks.close).not.toHaveBeenCalled();
  disposed.resolve();
  expect(await pending).toBeInstanceOf(Error);
  // Off is a choice: the replacement closes the writer and opens nothing, without a failure.
  expect(await replacing).toBeUndefined();
  await expect(f.activation.acquireRead()).rejects.toMatchObject({ code: 'native-index-off' });
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
  await f.activation.close();
});

it('opens no writer under a saved Off and answers reads with that choice, reporting no failure', async () => {
  const f = fixture();
  f.settings.mockResolvedValue(textSettings({ mode: 'off' }));
  await expect(f.activation.acquire()).rejects.toMatchObject({ code: 'native-index-off' });
  await expect(f.activation.acquireRead()).rejects.toMatchObject({ code: 'native-index-off' });
  await f.activation.reconfigure();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
  await f.activation.close();
});

it('answers a boot acquisition a newer generation superseded with the typed transition, not its retired mount abort', async () => {
  const attach = Promise.withResolvers<never>();
  mocks.manager.attachCanonicalWorkspace
    .mockReturnValueOnce(attach.promise)
    .mockImplementation(emptyWorkspace);
  mocks.manager.retireCanonicalSources.mockImplementation(async () => {
    // The utility answers an attach whose mount retired with an AbortError, untyped across its channel.
    const retired = new Error('Canonical mount retired.');
    retired.name = 'AbortError';
    attach.reject(retired);
  });
  setCatalogRoot();
  const { activation } = fixture(mountedRoot());
  const initial = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledOnce());
  // A folder registration opens the next generation from the committed roots.
  await activation.reconfigureRoots();
  const error = await initial;
  expect(error).toBeInstanceOf(NativeIndexRefusalError);
  expect((error as NativeIndexRefusalError).refusal).toEqual({ kind: 'transitioning' });
  await activation.close();
});
