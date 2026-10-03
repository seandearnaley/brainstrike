// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalScanReceipt } from '@brainstrike/canonical-ingestion';
import type { ScopedManifestRequest, ScopedManifestResult } from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { openIndexer } from '../../../../packages/indexer/dist/index.js';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import type { NativeCanonicalCatalogRecord } from '../native-canonical-catalog';
import { createNativeIndexActivation } from '../native-index-activation';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  database: { query: vi.fn(), transaction: vi.fn() },
  manager: { attachCanonicalCollection: vi.fn(), retireCanonicalSources: vi.fn() },
  readyPort: vi.fn(),
}));
vi.mock('../db-main', () => ({ getDatabase: async () => mocks.database }));
vi.mock('../desktop-database-location', () => ({
  resolveDesktopDatabaseProfileDirectory: () => '/owned/profile',
}));
vi.mock('../host-lease-manager', () => ({
  createDesktopHostLease: () => ({ acquire: async () => {}, close: async () => {} }),
}));
vi.mock('../indexer-runtime', () => ({
  acquireIndexerHost: mocks.acquire,
  closeIndexerRuntime: mocks.close,
  getReadyIndexerHost: () => mocks.manager,
  getReadyScopedIndexerPort: mocks.readyPort,
}));
vi.mock('../sqlite-query-host-manager', () => ({
  closeAllIndexQueries: async () => {},
  installIndexQueryTarget: () => {},
}));

const scope = { embeddingSetId: 'selected', kind: 'collection' } as const;
const source = 'retained canonical marker';
const contentHash = createHash('sha256').update(source).digest('hex');
function records(count: number): NativeCanonicalCatalogRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    chunksProcessed: false,
    content: null,
    contentHash,
    embeddingSetId: scope.embeddingSetId,
    fileId: `retained-${index}`,
    fileName: `retained-${index}.txt`,
    path: null,
    rootId: null,
    stat: { mtimeMs: 1, size: source.length },
  }));
}
async function fixture() {
  vi.resetAllMocks();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-catalog-refresh-'));
  const native = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: [],
      rootIds: [],
      scopes: [scope],
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<CanonicalScanReceipt>();
  const proofs: ScopedManifestResult[] = [];
  const manifests: string[][] = [];
  const receipts: CanonicalScanReceipt[] = [];
  const state = {
    files: records(0),
    hold: false,
    populateOnAttachment: false,
    removeNativeFile: false,
  };
  const writer = {
    ...native,
    verifyScopedManifest: async (request: ScopedManifestRequest) => {
      if (state.removeNativeFile && request.files[0]) {
        await native.removeScopedFile({ fileId: request.files[0].fileId, scope });
      }
      const result = await native.verifyScopedManifest(request);
      manifests.push(request.files.map((file) => file.fileId));
      proofs.push(result);
      if (state.hold && request.files.length === 1) {
        entered.resolve();
        await gate.promise;
      }
      return result;
    },
  };
  mocks.acquire.mockResolvedValue(writer);
  mocks.readyPort.mockReturnValue(writer);
  mocks.close.mockImplementation(() => native.close());
  mocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  mocks.database.query.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('FROM embedding_sets')) {
      return { rows: [{ id: scope.embeddingSetId }] };
    }
    if (sql.includes('FROM roots')) {
      return { rows: [] };
    }
    const ids = params[0];
    return {
      rows: Array.isArray(ids)
        ? state.files.filter((record) => ids.includes(record.fileId))
        : state.files,
    };
  });
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      if (state.populateOnAttachment) {
        state.files = records(1);
      }
      return {
        close: async () => {},
        scan: async (requestId: string) => {
          const ticket = await dependencies.publication.beginScan({ requestId, scope });
          const files = await dependencies.source.inventory.loadFiles(scope, {
            requestId,
            signal: new AbortController().signal,
          });
          for (const file of files) {
            await dependencies.publication.commitTextFile({
              file,
              payload: {
                content: source,
                fileId: file.fileId,
                providedChunks: [
                  {
                    chunkIndex: 0,
                    chunkSize: 384,
                    chunkType: 'text',
                    content: source,
                    contentHash,
                    endLine: 1,
                    endOffset: source.length,
                    startLine: 1,
                    startOffset: 0,
                    tokenCount: 4,
                  },
                ],
              },
              ticket,
            });
          }
          const receipt = await dependencies.publication.finishScan({
            aborted: false,
            errors: [],
            files: files.map((file) => ({ ...file, contentHash })),
            full: true,
            ticket,
            truncatedDirectories: [],
          });
          receipts.push(receipt);
          if (state.hold) {
            finished.resolve(receipt);
          }
          return receipt;
        },
      };
    }
  );
  const onError = vi.fn();
  const activation = createNativeIndexActivation({
    application: {
      roots: { restoreRoots: async () => [] },
      watches: {},
    } as unknown as ApplicationIpcDomain,
    embedding: { documentEmbeddings: vi.fn() },
    onError,
    storage: {
      getItem: async () =>
        JSON.stringify({
          state: {
            enabled: true,
            indexingPolicyPreset: 'balanced',
            managedCollectionId: scope.embeddingSetId,
            nativeIndexMode: 'TEXT',
            nativeLocalSelection: null,
            paused: false,
            worktreeRootIndexingOptInById: {},
          },
        }),
    },
  });
  return {
    activation,
    close: async () => {
      gate.resolve();
      await activation.close();
      await native.close();
      await rm(directory, { force: true, recursive: true });
    },
    entered,
    finished,
    gate,
    manifests,
    native,
    onError,
    proofs,
    receipts,
    state,
  };
}

it.each([false, true])(
  'finishes the first retained addition with repeated reads=%s and a complete real native manifest',
  async (repoll) => {
    const test = await fixture();
    try {
      await test.activation.acquire();
      test.state.files = records(1);
      test.state.hold = true;
      await test.activation.acquireRead();
      await test.entered.promise;
      expect(test.proofs.at(-1)).toMatchObject({
        changed: [],
        complete: true,
        missing: [],
        unexpected: [],
      });
      if (repoll) {
        await test.activation.acquireRead();
        await test.activation.acquireRead();
      }
      let joined = false;
      const joining = repoll
        ? test.activation
            .acquire()
            .then(() => {
              joined = true;
            })
            .catch((error: unknown) => error)
        : undefined;
      await Promise.resolve();
      expect(joined).toBe(false);
      test.gate.resolve();
      const receipt = await test.finished.promise;
      expect(receipt).toMatchObject({ reason: 'complete', scanComplete: true });
      await test.activation.acquire();
      expect(await joining).toBeUndefined();
      expect((await test.activation.getSearchAuthority()).readiness).toEqual([
        { scanComplete: true, scope },
      ]);
      expect(test.receipts).toHaveLength(2);
      expect(test.manifests).toEqual([[], ['retained-0']]);
      expect(test.onError).not.toHaveBeenCalled();
      expect(
        (
          await test.native.searchScopes({
            limit: 10,
            mode: 'bm25',
            scopes: [scope],
            text: 'marker',
          })
        ).hits.map((hit) => hit.fileId)
      ).toEqual(['retained-0']);
    } finally {
      await test.close();
    }
  }
);

it('rejects the superseded receipt and reconciles a genuinely newer catalog inventory observed during native verification', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.files = records(1);
    test.state.hold = true;
    await test.activation.acquireRead();
    await test.entered.promise;
    expect(test.proofs.at(-1)).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    });
    test.state.files = records(2);
    await test.activation.acquireRead();
    expect((await test.activation.getSearchAuthority()).readiness).toEqual([
      { scanComplete: false, scope },
    ]);
    test.gate.resolve();
    expect(await test.finished.promise).toMatchObject({
      reason: 'manifest-mismatch',
      scanComplete: false,
    });
    await test.activation.acquire();
    expect(test.receipts).toHaveLength(3);
    expect(test.receipts.at(-1)).toMatchObject({ reason: 'complete', scanComplete: true });
    expect(test.manifests).toEqual([[], ['retained-0'], ['retained-0', 'retained-1']]);
    expect(test.proofs.at(-1)).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    });
    expect((await test.activation.getSearchAuthority()).readiness).toEqual([
      { scanComplete: true, scope },
    ]);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});

it('refuses an actually missing native row despite unchanged repeated catalog observations', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.files = records(1);
    test.state.hold = true;
    test.state.removeNativeFile = true;
    await test.activation.acquireRead();
    await test.entered.promise;
    await test.activation.acquireRead();
    expect(test.proofs.at(-1)).toMatchObject({
      complete: false,
      missing: [expect.objectContaining({ fileId: 'retained-0' })],
    });
    test.gate.resolve();
    expect(await test.finished.promise).toMatchObject({
      reason: 'manifest-mismatch',
      scanComplete: false,
    });
    await vi.waitFor(() => expect(test.onError).toHaveBeenCalled());
    await expect(test.activation.acquireRead()).rejects.toThrow('Canonical native scan failed');
  } finally {
    await test.close();
  }
});

it('observes catalog population before the initial collection scan so concurrent reads preserve its complete native receipt', async () => {
  const test = await fixture();
  try {
    test.state.populateOnAttachment = true;
    test.state.hold = true;
    const starting = test.activation.acquire().catch((error: unknown) => error);
    await test.entered.promise;
    await test.activation.acquireRead();
    await test.activation.acquireRead();
    expect(test.proofs.at(-1)).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    });
    test.gate.resolve();
    expect(await test.finished.promise).toMatchObject({ reason: 'complete', scanComplete: true });
    expect(await starting).toHaveProperty('info');
    expect(test.manifests).toEqual([['retained-0']]);
    expect(test.onError).not.toHaveBeenCalled();
    expect((await test.activation.getSearchAuthority()).readiness).toEqual([
      { scanComplete: true, scope },
    ]);
  } finally {
    await test.close();
  }
});
