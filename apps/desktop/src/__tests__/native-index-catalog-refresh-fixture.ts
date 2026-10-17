// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CanonicalScanReceipt,
  CanonicalWorkspaceLease,
  NativeCanonicalCatalogRecord,
} from '@brainstrike/canonical-ingestion';
import type {
  IndexFileBinding,
  ScopedManifestRequest,
  ScopedManifestResult,
} from '@brainstrike/indexer';
import { openIndexer } from '@brainstrike/indexer';
import type { CoverageAuthority } from '@brainstrike/indexer/coverage-reader';
import { SqliteQueryClient, spawnQueryProcess } from '@brainstrike/sqlite-query';
import { vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalCollectionDependencies,
  type CanonicalRemoteWorkspaceDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeIndexActivation } from '../native-index-activation';
import {
  createNativeScopedSearchCapability,
  type NativeSearchAuthority,
} from '../native-scoped-search';
import {
  createActivationCatalogFixture,
  retainedCatalogRecords,
  sourceRecord,
} from './native-activation-catalog-fixture';
import { createNativePublicationReceiptAssertions } from './native-publication-receipt-test-helpers';

const catalogFixture = createActivationCatalogFixture();
const fixtureMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  coverageClosed: vi.fn(),
  holdCoverage: vi.fn(),
  manager: {
    attachCanonicalCollection: vi.fn(),
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
  },
  readyPort: vi.fn(),
}));
export const mocks = fixtureMocks;
vi.mock('../desktop-database-location', () => ({
  resolveDesktopDatabaseProfileDirectory: () => '/owned/profile',
}));
vi.mock('../host-lease-manager', () => ({
  createDesktopHostLease: () => ({ acquire: async () => {}, close: async () => {} }),
}));
vi.mock('../indexer-runtime', () => ({
  acquireIndexerHost: fixtureMocks.acquire,
  closeIndexerRuntime: fixtureMocks.close,
  getReadyIndexerHost: () => fixtureMocks.manager,
  getReadyScopedIndexerPort: fixtureMocks.readyPort,
}));
vi.mock('../sqlite-query-host-manager', () => ({
  closeAllIndexQueries: async () => {},
  installIndexQueryTarget: () => {},
  openIndexCoverage: async (authority: CoverageAuthority) => {
    const reader = await SqliteQueryClient.openNativeCoverage({
      authority,
      deadlineMs: 5000,
      spawn: () => spawnQueryProcess({ executable: process.execPath }),
      startupDeadlineMs: 5000,
    });
    return {
      close: async () => {
        await reader.close();
        fixtureMocks.coverageClosed();
      },
      nativeCoverage: async (requests: Parameters<SqliteQueryClient['nativeCoverage']>[0]) => {
        const result = await reader.nativeCoverage(requests);
        await fixtureMocks.holdCoverage();
        return result;
      },
    };
  },
}));
export const scope = { embeddingSetId: 'selected', kind: 'collection' } as const;
export const source = 'retained canonical marker';
export const contentHash = createHash('sha256').update(source).digest('hex');
export function records(count: number): NativeCanonicalCatalogRecord[] {
  return retainedCatalogRecords(count, contentHash, source.length, scope.embeddingSetId);
}
export async function fixture(withWorkspace = false, discovery = false) {
  vi.resetAllMocks();
  catalogFixture.reset();
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
    holdWorkspaceProof: false,
    nativeFailure: undefined as Error | undefined,
    observeWorkspaceInventory: false,
    populateOnAttachment: false,
    removeNativeFile: false,
    sourceFailure: undefined as Error | undefined,
    workspaceLoading: false,
  };
  fixtureMocks.holdCoverage.mockImplementation(async () => {
    if (!state.holdCoverage) {
      return;
    }
    state.holdCoverage = false;
    coverageEntered.resolve();
    await coverageGate.promise;
  });
  const receiptAssertions = createNativePublicationReceiptAssertions(native);
  const { expectReadiness } = receiptAssertions;
  const writer = {
    ...native,
    prepareScopedFile: receiptAssertions.prepareScopedFile,
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
      if (
        state.holdWorkspaceProof &&
        request.scope.kind === 'workspace' &&
        request.files.length === 1
      ) {
        workspaceEntered.resolve();
        await workspaceGate.promise;
      }
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
  fixtureMocks.acquire.mockResolvedValue(writer);
  fixtureMocks.readyPort.mockReturnValue(writer);
  fixtureMocks.close.mockImplementation(() => native.close());
  fixtureMocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  if (withWorkspace) {
    catalogFixture.setRoot();
  }
  catalogFixture.catalog.sourceCatalog.mockImplementation(async (request) => {
    if (request.operation !== 'inventory' && request.operation !== 'read') {
      throw new Error('Unexpected catalog mutation');
    }
    const ids = request.operation === 'read' ? request.fileIds : undefined;
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
      files: (ids ? state.files.filter((record) => ids.includes(record.fileId)) : snapshot).map(
        sourceRecord
      ),
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
    listDir: async () => ({
      entries: discovery
        ? [
            {
              isDirectory: false,
              isFile: true,
              isSymbolicLink: false,
              lastModified: 1,
              name: 'alpha.txt',
              size: source.length,
            },
          ]
        : [],
      inspected: discovery ? 1 : 0,
      truncated: false,
    }),
    readFile: async () => {
      if (!discovery) {
        throw new Error('Unexpected empty workspace read.');
      }
      return { content: Buffer.from(source), status: 'ok' };
    },
    retire: async () => {},
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: async () => ({ close: async () => {} }),
  };
  fixtureMocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
      if (dependencies.mode !== 'TEXT') {
        throw new Error('Workspace refresh fixture requires explicit TEXT admission.');
      }
      const attachment = await parent.attachWorkspace({
        ...dependencies,
        catalog: discovery
          ? {
              ...dependencies.catalog,
              applyManagedCacheBatch: async () => {},
              completeFiles: async () => {},
              prepareManagedSourcesBatch: async (request, context) => {
                const prepared = request.files.map((file) => ({
                  contentHash: file.contentHash,
                  embeddingSetId: scope.embeddingSetId,
                  fileId: 'f500392d-90d2-44ae-bf7a-eb58171f4856',
                  fileName: file.fileName,
                  relativePath: file.relativePath,
                  rootId: file.rootId,
                  sourcePath: file.sourcePath,
                }));
                state.files = request.files.map((file, index) => ({
                  chunksProcessed: false,
                  content: file.content,
                  contentHash: file.contentHash,
                  embeddingSetId: scope.embeddingSetId,
                  fileId: prepared[index]!.fileId,
                  fileName: file.fileName,
                  path: file.relativePath,
                  rootId: file.rootId,
                  stat: file.stat,
                }));
                // The fixture catalog commits its real discovery payload, then uses the
                // production authorization/binding acknowledgement over the private channel.
                await dependencies.catalog.loadAuthorizedBatch(
                  { files: prepared, scope: request.scope },
                  context
                );
                return prepared;
              },
            }
          : dependencies.catalog,
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
  fixtureMocks.manager.retireCanonicalSources.mockImplementation(() => parent.retireAttachments());
  fixtureMocks.manager.attachCanonicalCollection.mockImplementation(
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
          commitTextFile: receiptAssertions.commitTextFile(dependencies.publication),
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
    catalog: catalogFixture.catalog,
    embedding: { destroyAndRestart: vi.fn(), documentEmbeddings: vi.fn() },
    modelCatalog: catalogFixture.modelCatalog,
    onError,
    profile: createDesktopProfileRuntime(() => createDesktopHostLease({ root: '/owned/profile' })),
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
    expectReadiness,
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
