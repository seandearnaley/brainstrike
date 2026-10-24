// @vitest-environment node
/**
 * BST-1988: text search needs no embedding model. Activation in TEXT mode
 * indexes the workspace roots as the TEXT partition: no collection is invented
 * or looked up.
 */
import type {
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
  NativeCanonicalCatalogRecord,
} from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { textSettings } from './helpers/native-index-settings';
import {
  createActivation,
  mocks,
  requestedScope,
  resetActivationFixture,
  setCatalogRecords,
  setCatalogRoot,
  storeId,
  unused,
  writer,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

const workspace = { kind: 'workspace', rootId: 'root' } as const;

function mountedRoot(): ApplicationIpcDomain {
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
  return {
    roots: {
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
}

it('activates TEXT with no collection as its workspace roots alone', async () => {
  setCatalogRoot();
  const native = {
    ...writer(),
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
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      const ticket = await dependencies.publication.beginScan({
        requestId: 'text-partition-scan',
        scope: workspace,
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
  const activation = createActivation({
    application: mountedRoot(),
    embedding: { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    settings: async () => textSettings(),
    storage: { getItem: unused },
  });
  try {
    await activation.acquire();

    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ rootIds: ['root'], scopes: [workspace] }),
      expect.anything(),
      // No E2E delay seam in this composition.
      undefined
    );
    expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ managedCollectionId: null, mode: 'TEXT' })
    );
    expect(mocks.catalog.collections).not.toHaveBeenCalled();
    const catalogReads = mocks.catalog.sourceCatalog.mock.calls.map(([request]) => request);
    expect(catalogReads.length).toBeGreaterThan(0);
    expect(
      catalogReads.every(
        (request) => request.operation === 'inventory' && request.embeddingSetId === null
      )
    ).toBe(true);
    expect(activation.getReadiness()).toEqual([
      expect.objectContaining({ scanComplete: true, scope: workspace }),
    ]);
  } finally {
    await activation.close();
  }
});

it('routes explicit workspace scans to the existing admitted trigger and refuses unknown or retired roots', async () => {
  setCatalogRoot();
  const completion = Promise.withResolvers<void>();
  const trigger = vi.fn(() => completion.promise);
  mocks.readyPort.mockReturnValue({
    ...writer(),
    verifyScopedManifest: async (
      request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]
    ) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope: requestedScope(request),
      storeId,
      unexpected: [],
    }),
  });
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      const ticket = await dependencies.publication.beginScan({
        requestId: 'initial',
        scope: workspace,
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
      return { close: async () => {}, trigger };
    }
  );
  const activation = createActivation({
    application: mountedRoot(),
    embedding: { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    settings: async () => textSettings(),
    storage: { getItem: unused },
  });
  try {
    await activation.acquire();
    await expect(activation.requestWorkspaceScan('unknown')).rejects.toThrow();
    expect(trigger).not.toHaveBeenCalled();
    let settled = false;
    const requested = activation.requestWorkspaceScan('root').then(() => {
      settled = true;
    });
    expect(trigger).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);
    completion.resolve();
    await requested;
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledOnce();
  } finally {
    completion.resolve();
    await activation.close();
  }
  await expect(activation.requestWorkspaceScan('root')).rejects.toThrow();
  expect(trigger).toHaveBeenCalledOnce();
});

it('a read neither rescans nor un-readies a folder its own scan just indexed', async () => {
  setCatalogRoot();
  const notes = (hash: string): NativeCanonicalCatalogRecord => ({
    chunksProcessed: true,
    content: null,
    contentHash: hash.repeat(64),
    embeddingSetId: null,
    fileId: 'notes',
    fileName: 'notes.txt',
    path: 'notes.txt',
    rootId: 'root',
    stat: { mtimeMs: 1, size: 42 },
  });
  let records: NativeCanonicalCatalogRecord[] = [];
  setCatalogRecords(() => records);
  mocks.readyPort.mockReturnValue({
    ...writer(),
    verifyScopedManifest: async (
      request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]
    ) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope: requestedScope(request),
      storeId,
      unexpected: [],
    }),
  });
  // The folder's own scan: it commits notes.txt to the source catalog, then its receipt.
  let scanFolder: ((hash: string) => Promise<void>) | undefined;
  const rescans = vi.fn(async () => {});
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      let scans = 0;
      scanFolder = async (hash) => {
        scans += 1;
        const ticket = await dependencies.publication.beginScan({
          requestId: `scan-${scans}`,
          scope: workspace,
        });
        records = [notes(hash)];
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
      };
      await scanFolder('1');
      return { close: async () => {}, trigger: rescans };
    }
  );
  const indexed = Promise.withResolvers<void>();
  const activation = createActivation({
    application: mountedRoot(),
    embedding: { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    onReceipt: () => indexed.resolve(),
    settings: async () => textSettings(),
    storage: { getItem: unused },
  });
  // Status reads the index the way the status IPC does.
  const status = () => activation.withRead(async (read) => (await read.getAuthority()).readiness);
  try {
    // Launch: the first read opens the index, whose first scan indexes the folder.
    await activation.acquireRead();
    await indexed.promise;
    expect(await status()).toEqual([
      expect.objectContaining({ scanComplete: true, scope: workspace }),
    ]);
    // An edit: the folder's watcher scan indexes the new content.
    await scanFolder?.('2');
    expect(await status()).toEqual([
      expect.objectContaining({ scanComplete: true, scope: workspace }),
    ]);
    expect(rescans).not.toHaveBeenCalled();
    expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledOnce();
  } finally {
    await activation.close();
  }
});

it('refuses explicit workspace scans while source admission is paused', async () => {
  setCatalogRoot();
  const activation = createActivation({
    application: mountedRoot(),
    embedding: { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    settings: async () => textSettings({ paused: true }),
    storage: { getItem: unused },
  });
  try {
    await activation.acquire();
    await expect(activation.requestWorkspaceScan('root')).rejects.toThrow();
    expect(mocks.manager.attachCanonicalWorkspace).not.toHaveBeenCalled();
  } finally {
    await activation.close();
  }
});
