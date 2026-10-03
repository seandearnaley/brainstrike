// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalScanReceipt } from '@brainstrike/canonical-ingestion';
import type {
  IndexFileBinding,
  ScopedManifestRequest,
  ScopedManifestResult,
} from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { openIndexer } from '../../../../packages/indexer/dist/index.js';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalCollectionDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import type { NativeCanonicalCatalogRecord } from '../native-canonical-catalog';
import { createNativeIndexActivation } from '../native-index-activation';
import { createNativeScopedSearchCapability } from '../native-scoped-search';

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
  const nextEntered = Promise.withResolvers<void>();
  const nextGate = Promise.withResolvers<void>();
  const sawNewInventory = Promise.withResolvers<void>();
  const bindings: string[][] = [];
  const finished = Promise.withResolvers<CanonicalScanReceipt>();
  const proofs: ScopedManifestResult[] = [];
  const manifests: string[][] = [];
  const receipts: CanonicalScanReceipt[] = [];
  const activeScans = new Set<Promise<CanonicalScanReceipt>>();
  const state = {
    files: records(0),
    hold: false,
    holdNext: false,
    nativeFailure: undefined as Error | undefined,
    populateOnAttachment: false,
    removeNativeFile: false,
    sourceFailure: undefined as Error | undefined,
  };
  const writer = {
    ...native,
    replaceFileBindings: async (files: readonly IndexFileBinding[]) => {
      bindings.push(files.map((file) => file.fileId));
      await native.replaceFileBindings(files);
    },
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
      if (state.holdNext && request.files.length === 2) {
        nextEntered.resolve();
        await nextGate.promise;
      }
      if (state.nativeFailure) {
        throw state.nativeFailure;
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
    if (!Array.isArray(ids) && state.files.length === 2) {
      sawNewInventory.resolve();
    }
    return {
      rows: Array.isArray(ids)
        ? state.files.filter((record) => ids.includes(record.fileId))
        : state.files,
    };
  });
  const parent = new CanonicalUtilityParent(
    (frame) => queueMicrotask(() => child.receive(structuredClone(frame))),
    vi.fn()
  );
  const child = new CanonicalUtilityChild((frame) =>
    queueMicrotask(() => parent.receive(structuredClone(frame)))
  );
  mocks.manager.retireCanonicalSources.mockImplementation(() => parent.retireAttachments());
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      if (dependencies.mode !== 'TEXT') {
        throw new Error('Catalog refresh fixture requires explicit TEXT admission.');
      }
      if (state.populateOnAttachment) {
        state.files = records(1);
      }
      const attachment = await parent.attachCollection({
        ...dependencies,
        catalog: {
          ...dependencies.catalog,
          applyManagedCacheBatch: async () => {},
          completeFiles: async () => {},
        },
        publication: {
          ...dependencies.publication,
          finishScan: async (request) => {
            const receipt = await dependencies.publication.finishScan(request);
            receipts.push(receipt);
            if (state.hold) {
              finished.resolve(receipt);
            }
            return receipt;
          },
        },
        source: {
          ...dependencies.source,
          inventory: {
            ...dependencies.source.inventory,
            readRetained: async () => {
              if (state.sourceFailure) {
                throw state.sourceFailure;
              }
              return { content: source, stat: { mtimeMs: 1, size: source.length } };
            },
          },
        },
      });
      return {
        ...attachment,
        scan: (requestId: string) => {
          const scan = attachment.scan(requestId);
          activeScans.add(scan);
          scan.finally(() => activeScans.delete(scan)).catch(() => undefined);
          return scan;
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
    bindings,
    capability: createNativeScopedSearchCapability({
      acquireIndexer: activation.acquireRead,
      getAuthority: activation.getSearchAuthority,
      openQuery: async () => {
        throw new Error('Unexpected SQLite query opening.');
      },
      rebuild: activation.rebuild,
    }),
    close: async () => {
      gate.resolve();
      nextGate.resolve();
      await Promise.allSettled([...activeScans]);
      try {
        await activation.close();
        await parent.close();
        await child.close();
      } finally {
        await native.close();
        await rm(directory, { force: true, recursive: true });
      }
    },
    entered,
    finished,
    gate,
    manifests,
    native,
    nextEntered,
    nextGate,
    onError,
    proofs,
    receipts,
    sawNewInventory,
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

it('queues a newer inventory until the actual host and private channel join the old verified scan, gating every readiness projection', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.files = records(1);
    test.state.hold = true;
    test.state.holdNext = true;
    await test.activation.acquireRead();
    await test.entered.promise;
    expect(test.proofs.at(-1)).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    });
    test.state.files = records(2);
    let updated = false;
    const updating = test.activation
      .acquireRead()
      .then(() => {
        updated = true;
      })
      .catch((error: unknown) => error);
    await test.sawNewInventory.promise;
    let statusSettled = false;
    const status = test.capability
      .status()
      .then((value) => {
        statusSettled = true;
        return value;
      })
      .catch((error: unknown) => error);
    expect((await test.activation.getSearchAuthority()).readiness).toEqual([
      { scanComplete: false, scope },
    ]);
    expect(test.bindings.at(-1)).toEqual(['retained-0']);
    expect(updated).toBe(false);
    expect(statusSettled).toBe(false);
    test.gate.resolve();
    expect(await test.finished.promise).toMatchObject({ reason: 'complete', scanComplete: true });
    await test.nextEntered.promise;
    expect(test.activation.getReadiness()).toEqual([{ scanComplete: false, scope }]);
    expect((await test.activation.getSearchAuthority()).readiness).toEqual([
      { scanComplete: false, scope },
    ]);
    expect(test.bindings.at(-1)).toEqual(['retained-0', 'retained-1']);
    expect(updated).toBe(false);
    expect(statusSettled).toBe(false);
    test.nextGate.resolve();
    expect(await updating).toBeUndefined();
    expect(await status).toMatchObject({
      collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
      kind: 'ready',
    });
    await test.activation.acquire();
    expect(test.receipts).toHaveLength(3);
    expect(test.receipts.every((receipt) => receipt.scanComplete)).toBe(true);
    expect(test.manifests).toEqual([[], ['retained-0'], ['retained-0', 'retained-1']]);
    expect(test.proofs.at(-1)).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    });
    expect(test.activation.getReadiness()).toEqual([{ scanComplete: true, scope }]);
    expect((await test.activation.getSearchAuthority()).readiness).toEqual([
      { scanComplete: true, scope },
    ]);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});

it.each([false, true])(
  'refuses an actually missing native row through the actual host/channel with newer inventory=%s',
  async (newer) => {
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
      const updating = newer
        ? (() => {
            test.state.files = records(2);
            return test.activation.acquireRead().catch((error: unknown) => error);
          })()
        : undefined;
      if (newer) {
        await test.sawNewInventory.promise;
        await test.activation.getSearchAuthority();
      }
      test.gate.resolve();
      expect(await test.finished.promise).toMatchObject({
        reason: 'manifest-mismatch',
        scanComplete: false,
      });
      await updating;
      await vi.waitFor(() => expect(test.onError).toHaveBeenCalled());
      await expect(test.activation.acquireRead()).rejects.toThrow('Canonical native scan failed');
      expect(test.manifests).toEqual([[], ['retained-0']]);
    } finally {
      await test.close();
    }
  }
);

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

it.each([false, true])(
  'preserves genuine aggregate verification failure across the actual host/channel with newer inventory=%s',
  async (newer) => {
    const test = await fixture();
    try {
      await test.activation.acquire();
      test.state.files = records(1);
      test.state.hold = true;
      await test.activation.acquireRead();
      await test.entered.promise;
      test.state.nativeFailure = new AggregateError(
        [new Error('independent writer failure')],
        'genuine verification failure',
        { cause: new Error('original verification cause') }
      );
      const updating = newer
        ? (() => {
            test.state.files = records(2);
            return test.activation.acquireRead().catch((error: unknown) => error);
          })()
        : undefined;
      if (newer) {
        await test.sawNewInventory.promise;
        await test.activation.getSearchAuthority();
      }
      test.gate.resolve();
      await updating;
      await vi.waitFor(() => expect(test.onError).toHaveBeenCalled());
      expect(test.onError.mock.calls[0]?.[1]).toMatchObject({
        cause: expect.objectContaining({ message: 'original verification cause' }),
        errors: [expect.objectContaining({ message: 'independent writer failure' })],
        message: 'genuine verification failure',
      });
      await expect(test.activation.acquireRead()).rejects.toThrow('Canonical native scan failed');
      expect(test.manifests).toEqual([[], ['retained-0']]);
      expect(test.activation.getReadiness()).toEqual([{ scanComplete: false, scope }]);
    } finally {
      await test.close();
    }
  }
);

it('joins a queued inventory that reverts before the old verified scan settles without leaving readiness gated', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.files = records(1);
    test.state.hold = true;
    await test.activation.acquireRead();
    await test.entered.promise;
    test.state.files = records(2);
    const updating = test.activation.acquireRead().catch((error: unknown) => error);
    await test.sawNewInventory.promise;
    await test.activation.getSearchAuthority();
    test.state.files = records(1);
    const reverted = test.activation.acquireRead().catch((error: unknown) => error);
    expect(test.activation.getReadiness()).toEqual([{ scanComplete: false, scope }]);
    test.gate.resolve();
    expect(await test.finished.promise).toMatchObject({ reason: 'complete', scanComplete: true });
    expect(await updating).toHaveProperty('info');
    expect(await reverted).toHaveProperty('info');
    expect(test.manifests).toEqual([[], ['retained-0']]);
    expect(test.bindings.at(-1)).toEqual(['retained-0']);
    expect(test.activation.getReadiness()).toEqual([{ scanComplete: true, scope }]);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});
