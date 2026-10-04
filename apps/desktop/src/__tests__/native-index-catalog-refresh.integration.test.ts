// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CanonicalScanReceipt,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
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
import {
  createNativeScopedSearchCapability,
  type NativeSearchAuthority,
} from '../native-scoped-search';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  database: { query: vi.fn(), transaction: vi.fn() },
  manager: {
    attachCanonicalCollection: vi.fn(),
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
  },
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
async function fixture(withWorkspace = false) {
  vi.resetAllMocks();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-catalog-refresh-'));
  const native = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: [],
      rootIds: withWorkspace ? ['root'] : [],
      scopes: withWorkspace ? [{ kind: 'workspace', rootId: 'root' }, scope] : [scope],
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  const attachmentEntered = Promise.withResolvers<void>();
  const attachmentGate = Promise.withResolvers<void>();
  const coverageEntered = Promise.withResolvers<void>();
  const coverageGate = Promise.withResolvers<void>();
  const authorities: NativeSearchAuthority[] = [];
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const nextEntered = Promise.withResolvers<void>();
  const nextGate = Promise.withResolvers<void>();
  const sawNewInventory = Promise.withResolvers<void>();
  const sawSingleInventory = Promise.withResolvers<void>();
  const inventoryEntered = Promise.withResolvers<void>();
  const inventoryGate = Promise.withResolvers<void>();
  const workspaceEntered = Promise.withResolvers<void>();
  const workspaceGate = Promise.withResolvers<void>();
  const workspaceInventorySeen = Promise.withResolvers<void>();
  const workspacePasses = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const batchEntered = Promise.withResolvers<void>();
  const batchGate = Promise.withResolvers<void>();
  const bindings: string[][] = [];
  const finished = Promise.withResolvers<CanonicalScanReceipt>();
  const proofs: ScopedManifestResult[] = [];
  const manifests: string[][] = [];
  const receipts: CanonicalScanReceipt[] = [];
  const activeScans = new Set<Promise<CanonicalScanReceipt>>();
  const state = {
    enabled: true,
    files: records(0),
    hold: false,
    holdAttachment: false,
    holdBatch: false,
    holdCoverage: false,
    holdInventoryAfterReads: -1,
    holdNext: false,
    holdWorkspace: false,
    nativeFailure: undefined as Error | undefined,
    observeWorkspaceInventory: false,
    populateOnAttachment: false,
    removeNativeFile: false,
    sourceFailure: undefined as Error | undefined,
    workspaceLoading: false,
  };
  const writer = {
    ...native,
    coverageScope: async (request: unknown) => {
      const result = await native.coverageScope(request);
      if (state.holdCoverage) {
        state.holdCoverage = false;
        coverageEntered.resolve();
        await coverageGate.promise;
      }
      return result;
    },
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
      return { rows: withWorkspace ? [{ id: 'root', kind: 'path' }] : [] };
    }
    const ids = params[0];
    const snapshot = state.files;
    if (!Array.isArray(ids) && state.holdInventoryAfterReads >= 0) {
      if (state.holdInventoryAfterReads === 0) {
        state.holdInventoryAfterReads = -1;
        inventoryEntered.resolve();
        await inventoryGate.promise;
      } else {
        state.holdInventoryAfterReads -= 1;
      }
    }
    if (Array.isArray(ids) && state.holdBatch) {
      state.holdBatch = false;
      batchEntered.resolve();
      await batchGate.promise;
    }
    if (!Array.isArray(ids) && state.files.length === 1) {
      sawSingleInventory.resolve();
    }
    if (!Array.isArray(ids) && state.files.length === 2) {
      sawNewInventory.resolve();
    }
    return {
      rows: Array.isArray(ids)
        ? state.files.filter((record) => ids.includes(record.fileId))
        : snapshot,
    };
  });
  const parent = new CanonicalUtilityParent(
    (frame) => queueMicrotask(() => child.receive(structuredClone(frame))),
    vi.fn()
  );
  const child = new CanonicalUtilityChild((frame) =>
    queueMicrotask(() => parent.receive(structuredClone(frame)))
  );
  const workspaceBegins: string[] = [];
  const workspaceReceipts: CanonicalScanReceipt[] = [];
  let workspaceTrigger: (() => Promise<void>) | undefined;
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: '/owned/root',
    generation: 'generation',
    listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
    readFile: async () => {
      throw new Error('Unexpected empty workspace read.');
    },
    retire: async () => {},
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: async () => ({ close: async () => {} }),
  };
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      if (dependencies.mode !== 'TEXT') {
        throw new Error('Workspace refresh fixture requires explicit TEXT admission.');
      }
      const attachment = await parent.attachWorkspace({
        ...dependencies,
        onError: (operation, error) => {
          if (operation === 'sync' || operation === 'sync loop') {
            for (const pass of workspacePasses.values()) {
              pass.resolve();
            }
            workspacePasses.clear();
          }
          dependencies.onError(operation, error);
        },
        onReceipt: (receipt) => {
          workspacePasses.get(receipt.ticket.requestId)?.resolve();
          workspacePasses.delete(receipt.ticket.requestId);
          workspaceReceipts.push(receipt);
          dependencies.onReceipt(receipt);
        },
        publication: {
          ...dependencies.publication,
          beginScan: async (request) => {
            workspacePasses.set(request.requestId, Promise.withResolvers<void>());
            const ticket = await dependencies.publication.beginScan(request);
            workspaceBegins.push(request.requestId);
            return ticket;
          },
          finishScan: async (request) => {
            const receipt = await dependencies.publication.finishScan(request);
            if (state.holdWorkspace) {
              state.holdWorkspace = false;
              workspaceEntered.resolve();
              await workspaceGate.promise;
            }
            return receipt;
          },
        },
        source: {
          ...dependencies.source,
          inventory: {
            ...dependencies.source.inventory,
            loadFiles: async (requested, context) => {
              if (state.observeWorkspaceInventory) {
                state.workspaceLoading = true;
                workspaceInventorySeen.resolve();
              }
              try {
                return await dependencies.source.inventory.loadFiles(requested, context);
              } finally {
                state.workspaceLoading = false;
              }
            },
          },
        },
      });
      workspaceTrigger = () => attachment.trigger();
      return attachment;
    }
  );
  mocks.manager.retireCanonicalSources.mockImplementation(() => parent.retireAttachments());
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      if (dependencies.mode !== 'TEXT') {
        throw new Error('Catalog refresh fixture requires explicit TEXT admission.');
      }
      if (state.holdAttachment) {
        attachmentEntered.resolve();
        await attachmentGate.promise;
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
      roots: {
        borrowSourceRoot: async () => lease,
        restoreRoots: async () =>
          withWorkspace ? [{ permissionState: 'granted', rootId: 'root' }] : [],
      },
      watches: { subscribe: async () => {} },
    } as unknown as ApplicationIpcDomain,
    embedding: { documentEmbeddings: vi.fn() },
    onError,
    storage: {
      getItem: async () =>
        JSON.stringify({
          state: {
            enabled: state.enabled,
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
    attachmentEntered,
    attachmentGate,
    authorities,
    batchEntered,
    batchGate,
    bindings,
    capability: createNativeScopedSearchCapability({
      openQuery: async () => {
        throw new Error('Unexpected SQLite query opening.');
      },
      rebuild: activation.rebuild,
      withRead: (work) =>
        activation.withRead((read) =>
          work({
            ...read,
            getAuthority: async () => {
              const result = await read.getAuthority();
              authorities.push(structuredClone(result));
              return result;
            },
          })
        ),
    }),
    close: async () => {
      attachmentGate.resolve();
      coverageGate.resolve();
      inventoryGate.resolve();
      workspaceGate.resolve();
      batchGate.resolve();
      gate.resolve();
      nextGate.resolve();
      while (workspacePasses.size > 0 || activeScans.size > 0) {
        await Promise.allSettled([
          ...activeScans,
          ...[...workspacePasses.values()].map((pass) => pass.promise),
        ]);
      }
      try {
        await activation.close();
        await parent.close();
        await child.close();
      } finally {
        await native.close();
        await rm(directory, { force: true, recursive: true });
      }
    },
    coverageEntered,
    coverageGate,
    entered,
    finished,
    gate,
    inventoryEntered,
    inventoryGate,
    manifests,
    native,
    nextEntered,
    nextGate,
    onError,
    proofs,
    receipts,
    sawNewInventory,
    sawSingleInventory,
    state,
    triggerWorkspace: async () => {
      if (!workspaceTrigger) {
        throw new Error('Workspace fixture has no actual attachment.');
      }
      await workspaceTrigger();
    },
    workspaceBegins,
    workspaceEntered,
    workspaceGate,
    workspaceInventorySeen,
    workspaceReceipts,
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

it.each([false, true])(
  'keeps the admitted real native inventory during catalog loading with newer inventory=%s',
  async (newer) => {
    const test = await fixture();
    try {
      await test.activation.acquire();
      test.state.files = records(1);
      test.state.holdBatch = true;
      await test.activation.acquireRead();
      await test.batchEntered.promise;
      if (newer) {
        test.state.files = records(2);
      }
      const joining = test.activation.acquire().catch((error: unknown) => error);
      if (newer) {
        await test.sawNewInventory.promise;
        expect(test.activation.getReadiness()).toEqual([{ scanComplete: false, scope }]);
      }
      expect(test.bindings.at(-1)).toEqual(['retained-0']);
      test.batchGate.resolve();
      expect(await joining).toHaveProperty('info');
      expect(test.onError).not.toHaveBeenCalled();
      expect(test.manifests).toEqual(
        newer ? [[], ['retained-0'], ['retained-0', 'retained-1']] : [[], ['retained-0']]
      );
      expect(test.receipts.every((receipt) => receipt.scanComplete)).toBe(true);
      expect((await test.activation.getSearchAuthority()).readiness).toEqual([
        { scanComplete: true, scope },
      ]);
    } finally {
      await test.close();
    }
  }
);

it('uses one snapshot for admission, bindings and source inventory when PG changes during admission loading', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.files = records(1);
    test.state.holdInventoryAfterReads = 1;
    const initial = test.activation.acquireRead().catch((error: unknown) => error);
    await test.inventoryEntered.promise;
    test.state.files = records(2);
    const latest = test.activation.acquire().catch((error: unknown) => error);
    await test.sawNewInventory.promise;
    test.inventoryGate.resolve();
    expect(await initial).toHaveProperty('info');
    expect(await latest).toHaveProperty('info');
    expect(test.manifests).toEqual([[], ['retained-0'], ['retained-0', 'retained-1']]);
    expect(test.receipts.every((receipt) => receipt.scanComplete)).toBe(true);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});

it('drains a real workspace pass through the private-channel receipt before collection loading', async () => {
  const test = await fixture(true);
  try {
    await test.activation.acquire();
    test.state.holdWorkspace = true;
    await test.triggerWorkspace();
    await test.workspaceEntered.promise;
    test.state.files = records(1);
    const refresh = test.activation.acquire().catch((error: unknown) => error);
    await test.sawSingleInventory.promise;
    await test.native.info();
    expect(test.bindings).toEqual([]);
    expect(test.receipts).toHaveLength(1);
    test.workspaceGate.resolve();
    expect(await refresh).toHaveProperty('info');
    expect(test.workspaceReceipts).toHaveLength(2);
    expect(test.manifests).toContainEqual(['retained-0']);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});

it('admits a later real workspace pass only after the owned collection host/channel settles', async () => {
  const test = await fixture(true);
  try {
    await test.activation.acquire();
    const count = test.workspaceBegins.length;
    test.state.files = records(1);
    test.state.holdBatch = true;
    await test.activation.acquireRead();
    await test.batchEntered.promise;
    test.state.observeWorkspaceInventory = true;
    await test.triggerWorkspace();
    await test.workspaceInventorySeen.promise;
    await test.native.info();
    expect(test.state.workspaceLoading).toBe(true);
    expect(test.workspaceBegins).toHaveLength(count);
    test.batchGate.resolve();
    await test.activation.acquire();
    await vi.waitFor(() => expect(test.workspaceReceipts).toHaveLength(2));
    expect(test.workspaceBegins).toHaveLength(count + 1);
    expect(test.receipts.every((receipt) => receipt.scanComplete)).toBe(true);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});

it.each([false, true])(
  'owns pending startup coverage across binding admission (progress=%s)',
  async (progress) => {
    const test = await fixture();
    test.state.holdAttachment = true;
    test.state.holdCoverage = true;
    test.state.populateOnAttachment = progress;
    test.state.hold = progress;
    try {
      expect(await test.capability.status()).toMatchObject({
        collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
        kind: 'ready',
      });
      await test.attachmentEntered.promise;
      const pending = test.capability
        .coverage({ collectionId: 'selected', rootIds: [] })
        .catch((error: unknown) => error);
      await test.coverageEntered.promise;
      const before = test.authorities.at(-1);
      const beforeStore = (await test.native.info()).storeId;
      test.attachmentGate.resolve();
      if (progress) {
        await test.sawSingleInventory.promise;
      } else {
        await test.activation.acquire();
      }
      const after = await test.activation.getSearchAuthority();
      const fields = [
        'generation',
        'collectionId',
        'rootIds',
        'bindings',
        'profile',
        'queryPlan',
      ] as const;
      expect(
        fields.filter((field) => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]))
      ).toEqual(progress ? ['bindings'] : []);
      expect((await test.native.info()).storeId).toBe(beforeStore);
      expect(test.bindings.flat()).not.toContain('retained-0');
      expect(test.receipts).toHaveLength(progress ? 0 : 1);
      test.coverageGate.resolve();
      expect(await pending).toMatchObject({
        storeId: beforeStore,
        totals: { chunks: 0, indexedFiles: 0 },
      });
      expect(test.authorities.at(-1)?.bindings).toEqual(before?.bindings);
      if (progress) {
        await test.entered.promise;
        expect(test.bindings.flat()).toContain('retained-0');
        expect(test.receipts).toHaveLength(0);
      }
      test.gate.resolve();
      await test.activation.acquire();
      expect(test.onError).not.toHaveBeenCalled();
      expect(test.activation.getReadiness()).toEqual([{ scanComplete: true, scope }]);
    } finally {
      await test.close();
    }
  }
);

it('rejects held native coverage when genuine saved authority replacement retires its owner', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.holdCoverage = true;
    const pending = test.capability
      .coverage({ collectionId: 'selected', rootIds: [] })
      .catch((error: unknown) => error);
    await test.coverageEntered.promise;
    const originalStore = (await test.native.info()).storeId;
    test.state.enabled = false;
    const replacing = test.activation.reconfigure().catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(() => test.activation.captureAcknowledgedAuthority()).toThrow(
        'Native source authority changed'
      )
    );
    expect(mocks.close).not.toHaveBeenCalled();
    expect((await test.native.info()).storeId).toBe(originalStore);
    test.coverageGate.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(await replacing).toEqual(new Error('Native indexing is disabled in saved settings.'));
    expect(mocks.close).toHaveBeenCalledOnce();
  } finally {
    await test.close();
  }
});
