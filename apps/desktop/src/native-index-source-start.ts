import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  CanonicalFileIdentity,
  CanonicalIngestionDependencies,
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalSourceScope,
} from '@brainstrike/canonical-ingestion';
import { getFileSizeConfig } from '@brainstrike/file-system';
import type { IndexerPort, ScopedIndexerPort, VectorProfile } from '@brainstrike/indexer';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { getDatabase } from './db-main';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { generateHostedEmbeddings } from './hosted-embeddings';
import { getReadyIndexerHost } from './indexer-runtime';
import type { ApplicationIpcDomain } from './ipc-handlers';
import { NativeAuthorityTransitionError as TransitionError } from './native-authority-transition';
import {
  createNativeCanonicalCatalog,
  type NativeCanonicalCatalogRecord,
} from './native-canonical-catalog';
import {
  NativeCanonicalInference,
  type NativeCanonicalProfileResolver,
} from './native-canonical-profile';
import { catalogFingerprint } from './native-index-catalog-observation';
import type { NativeIndexRuntime } from './native-index-runtime';
import { createNativeScanAdmission } from './native-index-scan-admission';
import type { NativeIndexActivationGraph as Graph } from './native-index-settings-preparation';
import { createNativeSourceInventory } from './native-index-source-inventory';
import type { NativeIndexSources } from './native-index-source-retirement';
import { createNativeIndexWatchHealthHandler } from './native-index-watch-health';

type WithoutSource<T> = T extends unknown ? Omit<T, 'source'> : never;

/** What starting a source generation reads from its native index activation. */
export interface NativeSourceStartOwner {
  readonly assertCurrent: (current: Graph) => void;
  readonly contextFor: (current: Graph) => CanonicalOperationContext;
  readonly dependencies: {
    readonly application: ApplicationIpcDomain;
    readonly embedding: Pick<EmbeddingHostManager, 'documentEmbeddings'>;
    readonly onError: (operation: string, error: unknown) => void;
    readonly onReceipt?: (receipt: CanonicalScanReceipt) => void;
    readonly storage: Pick<ElectronStorageAdapter, 'getItem'>;
  };
  readonly identity: (
    current: Graph,
    record: NativeCanonicalCatalogRecord
  ) => CanonicalFileIdentity;
  readonly loadRecords: (current: Graph) => Promise<readonly NativeCanonicalCatalogRecord[]>;
  readonly refreshCatalog: (
    current: Graph,
    join: boolean,
    inventory?: readonly NativeCanonicalCatalogRecord[]
  ) => Promise<void>;
  readonly resolver: (current: Graph) => NativeCanonicalProfileResolver;
  readonly runtime: Pick<NativeIndexRuntime, 'acquire' | 'mutateAuthority'>;
}

/**
 * Starts a graph's source generation: borrows each mounted root, attaches its
 * canonical workspace and the retained collection, and joins their first scans.
 * The activation owns the graph and its retirement.
 */
export async function startNativeIndexSources(
  owner: NativeSourceStartOwner,
  current: Graph,
  sources: NativeIndexSources,
  port: IndexerPort & ScopedIndexerPort
): Promise<void> {
  const {
    assertCurrent,
    contextFor,
    dependencies,
    identity,
    loadRecords,
    refreshCatalog,
    resolver,
    runtime,
  } = owner;
  const assertSource = (): void => {
    assertCurrent(current);
    sources.controller.signal.throwIfAborted();
    for (const lease of current.leases.values()) {
      lease.signal.throwIfAborted();
    }
    if (current.sources !== sources || current.settings.paused) {
      throw new TransitionError('Native ingestion admission changed.');
    }
  };
  assertSource();
  const settings = current.settings;
  const database = await getDatabase();
  assertSource();
  const publication = current.publication;
  if (!publication) {
    throw new Error('Native ingestion has no authoritative publication owner.');
  }
  // Source attachments own and retire their own borrows; reader authority keeps its original borrow.
  for (const rootId of current.leases.keys()) {
    const lease = await dependencies.application.roots.borrowSourceRoot(
      rootId,
      dependencies.application.watches.subscribe.bind(dependencies.application.watches)
    );
    sources.leases.set(rootId, lease);
    assertSource();
    if (lease.canonicalPath !== current.leases.get(rootId)?.canonicalPath) {
      throw new Error('Native source borrow differs from its original mounted read authority.');
    }
  }
  const scanAdmission = createNativeScanAdmission(assertSource, sources.controller.signal);
  sources.scanAdmission = scanAdmission;
  const profileResolver = resolver(current);
  const catalog = createNativeCanonicalCatalog<VectorProfile>({
    database,
    joinNativeRemoval: async (files, scope) => {
      for (const file of files) {
        await runtime.mutateAuthority(port, () =>
          port.removeScopedFile({ fileId: file.fileId, scope })
        );
      }
      assertSource();
    },
    replaceTrustedBindings: async (_scope, context) => {
      await scanAdmission.acquireBindings(context, () => runtime.acquire());
      assertSource();
    },
    resolveProfile: (scope, _authority, context) =>
      profileResolver.resolveProfile({ scope }, context),
    resolveScope: async (scope) => {
      assertSource();
      if (
        (scope.kind === 'workspace' && !current.leases.has(scope.rootId)) ||
        (scope.kind === 'collection' && scope.embeddingSetId !== settings.managedCollectionId)
      ) {
        throw new Error('Canonical catalog scope is not currently authorized.');
      }
      return {
        assertCurrent: () => {
          assertSource();
          if (scope.kind === 'workspace') {
            current.leases.get(scope.rootId)?.signal.throwIfAborted();
          }
        },
        assertDiscoveredSource: (file) => {
          const lease = current.leases.get(file.rootId);
          if (
            !lease ||
            file.sourcePath !== path.join(lease.canonicalPath, ...file.relativePath.split('/'))
          ) {
            throw new Error('Canonical discovery differs from its actual pinned mount.');
          }
          lease.signal.throwIfAborted();
        },
        embeddingSetId: settings.managedCollectionId,
        resolveIdentity: (record) => identity(current, record),
      };
    },
  });
  const inventory = (scope: CanonicalSourceScope) =>
    createNativeSourceInventory({
      assertSource,
      catalog,
      identity: (record) => identity(current, record),
      loadRecords: () => loadRecords(current),
      retainCollection: (records) => {
        sources.collectionInventory = records;
      },
      scanAdmission,
      scope,
    });
  const manager = getReadyIndexerHost();
  const common = {
    parser: { parser: 'oxc' as const },
    request: {
      batchSize: 64,
      chunkingOptions: { strategy: 'auto' as const },
      maxFileBytes: getFileSizeConfig().maxFileSize,
    },
  };
  const pipeline = (scope: CanonicalSourceScope): WithoutSource<CanonicalIngestionDependencies> => {
    if (settings.mode === 'TEXT') {
      return {
        catalog,
        mode: 'TEXT',
        parser: common.parser,
        publication:
          scope.kind === 'workspace'
            ? scanAdmission.workspacePublication(publication)
            : publication,
      };
    }
    const inference = new NativeCanonicalInference({
      hostedEmbeddings: (input) =>
        generateHostedEmbeddings({ ...input, storage: dependencies.storage }),
      resolver: profileResolver,
      scope,
      transport: dependencies.embedding,
    });
    sources.inference.add(inference);
    return {
      catalog,
      inference,
      mode: 'VECTOR',
      parser: common.parser,
      publication:
        scope.kind === 'workspace' ? scanAdmission.workspacePublication(publication) : publication,
    };
  };
  const firstReceipts: Promise<CanonicalScanReceipt>[] = [];
  for (const lease of sources.leases.values()) {
    const signal = AbortSignal.any([current.controller.signal, sources.controller.signal]);
    signal.throwIfAborted();
    const { promise, reject, resolve } = Promise.withResolvers<CanonicalScanReceipt>();
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    firstReceipts.push(promise);
    const scope = { kind: 'workspace', rootId: lease.rootId } as const;
    let workspace: Awaited<ReturnType<typeof manager.attachCanonicalWorkspace>> | undefined;
    workspace = await manager.attachCanonicalWorkspace({
      ...common,
      ...pipeline(scope),
      managedCollectionId: settings.managedCollectionId,
      onError: (operation, error) => {
        if (operation === 'sync' || operation === 'sync loop') {
          scanAdmission.failWorkspace(lease.rootId, error);
        }
        reject(error);
        dependencies.onError(operation, error);
      },
      onReceipt: (receipt, sourceInvalidated) => {
        if (sourceInvalidated) {
          scanAdmission.releaseInvalidatedWorkspace(receipt);
          dependencies.onReceipt?.(receipt);
          return;
        }
        scanAdmission.completeWorkspace(receipt);
        dependencies.onReceipt?.(receipt);
        if (receipt.scanComplete) {
          resolve(receipt);
        } else {
          reject(new Error(`Initial native workspace scan was ${receipt.reason}.`));
        }
        if (sources.scanCollection && !sources.controller.signal.aborted) {
          sources
            .scanCollection()
            .catch((error: unknown) =>
              dependencies.onError('collection refresh after workspace scan', error)
            );
        }
      },
      onWatchHealth: createNativeIndexWatchHealthHandler({
        collectionId: settings.managedCollectionId,
        onError: dependencies.onError,
        publication: () => current.publication,
        rootId: lease.rootId,
        signal: sources.controller.signal,
        watchFailures: current.watchFailures,
        workspace: () => workspace,
      }),
      source: {
        indexingPolicyPreset: settings.indexingPolicyPreset,
        inventory: inventory(scope),
        lease,
      },
    });
    const attachedWorkspace = workspace;
    sources.workspaceTriggers.set(lease.rootId, () => attachedWorkspace.trigger());
    sources.attachments.add(workspace);
    assertSource();
  }
  await Promise.all(firstReceipts);
  assertSource();
  const collectionId = settings.managedCollectionId;
  if (collectionId === null) {
    // The TEXT partition is its workspace roots: no retained collection to ingest (BST-1988).
    return;
  }
  const scope = { embeddingSetId: collectionId, kind: 'collection' } as const;
  const collection = await manager.attachCanonicalCollection({
    ...common,
    ...pipeline(scope),
    scope,
    source: { indexingPolicyPreset: settings.indexingPolicyPreset, inventory: inventory(scope) },
  });
  sources.attachments.add(collection);
  const reverifyWorkspaces = async (): Promise<void> => {
    const profile =
      settings.mode === 'VECTOR'
        ? (await profileResolver.resolve(scope, contextFor(current))).profile
        : null;
    for (const rootId of current.leases.keys()) {
      await publication.reverifyScope({ kind: 'workspace', rootId }, profile);
      assertSource();
    }
  };
  let collectionScan: Promise<void> | undefined;
  sources.waitForCollection = () => collectionScan ?? Promise.resolve();
  let requested = false;
  sources.scanCollection = (): Promise<void> => {
    assertSource();
    requested = true;
    collectionScan ??= Promise.resolve()
      .then(async () => {
        while (requested) {
          requested = false;
          assertSource();
          const requestId = randomUUID();
          await scanAdmission.runCollection(requestId, async () => {
            sources.collectionInventory = await loadRecords(current);
            scanAdmission.retainInventory(sources.collectionInventory);
            await runtime.acquire();
            assertSource();
            await refreshCatalog(current, false, sources.collectionInventory);
            const receipt = await collection.scan(requestId);
            dependencies.onReceipt?.(receipt);
            assertSource();
            if (!receipt.scanComplete) {
              throw new Error(`Native collection scan was ${receipt.reason}.`);
            }
            await reverifyWorkspaces();
            const latest = await loadRecords(current);
            await refreshCatalog(current, false, latest);
            if (catalogFingerprint(latest) !== catalogFingerprint(sources.collectionInventory)) {
              requested = true;
            }
          });
        }
      })
      .finally(() => {
        collectionScan = undefined;
        sources.collectionScan = undefined;
      });
    sources.collectionScan = collectionScan;
    return collectionScan;
  };
  await sources.scanCollection();
  assertSource();
}
