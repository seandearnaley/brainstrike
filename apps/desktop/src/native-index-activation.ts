import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  CanonicalIngestionDependencies,
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalSourceScope,
} from '@brainstrike/canonical-ingestion';
import { getFileSizeConfig } from '@brainstrike/file-system';
import type { HostAttachment } from '@brainstrike/host-lease';
import type { IndexerPort, ScopedIndexerPort, VectorProfile } from '@brainstrike/indexer';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { getDatabase } from './db-main';
import { resolveDesktopDatabaseProfileDirectory } from './desktop-database-location';
import type { DesktopProfileRuntime } from './desktop-profile-runtime';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { generateHostedEmbeddings } from './hosted-embeddings';
import {
  acquireIndexerHost,
  closeIndexerRuntime,
  destroyIndexerRuntime,
  getReadyIndexerHost,
  getReadyScopedIndexerPort,
} from './indexer-runtime';
import type { ApplicationIpcDomain } from './ipc-handlers';
import { NativeAuthorityTransitionError as TransitionError } from './native-authority-transition';
import {
  createNativeCanonicalCatalog,
  decodeNativeCanonicalCatalogRecords,
  type NativeCanonicalCatalogRecord,
} from './native-canonical-catalog';
import {
  NativeCanonicalInference,
  NativeCanonicalProfileResolver,
} from './native-canonical-profile';
import { createNativeCanonicalPublication } from './native-canonical-publication';
import { isolateNativeCoverage } from './native-coverage-reader';
import { retainedNativeIndexFailure } from './native-index-blocked';
import {
  catalogFingerprint,
  catalogReadiness,
  deferNativeIndexCatalog,
  observeNativeIndexCatalog,
  triggerCatalogWorkspaces,
} from './native-index-catalog-observation';
import { decodeRoots, decodeSelectedCollections } from './native-index-pg-decoders';
import { createNativeIndexReadAuthority } from './native-index-read-authority';
import { createNativeIndexRuntime, type NativeIndexAuthority } from './native-index-runtime';
import { createNativeScanAdmission } from './native-index-scan-admission';
import {
  NATIVE_INDEX_SETTINGS_KEY,
  type NativeIndexSettings,
  readNativeIndexSettings,
  readNativeManagedCollectionId,
} from './native-index-settings';
import {
  type NativeIndexActivationGraph as Graph,
  joinInvalidNativeSettingsRetirement,
  prepareNativeSavedPause,
  readTrackedNativeSettings,
  reconfigureNativeSavedSettings,
} from './native-index-settings-preparation';
import { NativeIndexSetupRequiredError as SetupRequired } from './native-index-setup-required';
import { createNativeSourceInventory } from './native-index-source-inventory';
import {
  joinNativeSourceRetirement,
  type NativeIndexSources,
  retireNativeIndexSources,
} from './native-index-source-retirement';
import { createNativeIndexWatchHealthHandler } from './native-index-watch-health';
import { createProfileAdmission, resumeProfileForReset } from './native-profile-admission';
import {
  closeAllIndexQueries,
  installIndexQueryTarget,
  openIndexCoverage,
} from './sqlite-query-host-manager';

type WithoutSource<T> = T extends unknown ? Omit<T, 'source'> : never;
interface Dependencies {
  readonly application: ApplicationIpcDomain;
  readonly embedding: Pick<EmbeddingHostManager, 'documentEmbeddings'>;
  readonly onError: (operation: string, error: unknown) => void;
  readonly onReceipt?: (receipt: CanonicalScanReceipt) => void;
  readonly profile: DesktopProfileRuntime<HostAttachment>;
  readonly storage: Pick<ElectronStorageAdapter, 'getItem'>;
}
/** Desktop main's actual catalog/grant/inference callbacks; the utility owns parsing and scans. */
export function createNativeIndexActivation(dependencies: Dependencies) {
  let generation = 0;
  let graph: Graph | undefined;
  let startup: Promise<void> | undefined;
  let readerReady: Promise<IndexerPort & ScopedIndexerPort> | undefined;
  let startupFailed = false;
  let stopping: Promise<void> | undefined;
  let closed = false;
  let lastError: unknown;
  let reconfiguration: Promise<void> | undefined;
  let terminalEpoch = 0;
  let terminalRequested = false;
  let sourceRetirement: Promise<void> | undefined;
  const settingsReads = new Set<Promise<NativeIndexSettings>>();
  const assertCurrent = (current: Graph): void => {
    current.controller.signal.throwIfAborted();
    if (closed || graph !== current || current.generation !== generation) {
      throw new TransitionError('Native catalog authority changed during its operation.');
    }
  };
  const contextFor = (current: Graph): CanonicalOperationContext => ({
    requestId: randomUUID(),
    signal: current.controller.signal,
  });
  const identity = (current: Graph, record: NativeCanonicalCatalogRecord) => {
    if (record.rootId === null) {
      return {
        embeddingSetId: record.embeddingSetId,
        fileId: record.fileId,
        fileName: record.fileName,
        relativePath: null,
        rootId: null,
        sourcePath: record.path,
      };
    }
    const lease = current.leases.get(record.rootId);
    if (
      !lease ||
      record.path === null ||
      path.posix.isAbsolute(record.path) ||
      record.path.includes('\\') ||
      record.path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('Canonical catalog file has no current mounted relative-path authority.');
    }
    lease.signal.throwIfAborted();
    return {
      embeddingSetId: record.embeddingSetId,
      fileId: record.fileId,
      fileName: record.fileName,
      relativePath: record.path,
      rootId: record.rootId,
      sourcePath: path.join(lease.canonicalPath, ...record.path.split('/')),
    };
  };
  const loadRecords = async (current: Graph): Promise<readonly NativeCanonicalCatalogRecord[]> => {
    assertCurrent(current);
    const database = await getDatabase();
    const result = await database.query<NativeCanonicalCatalogRecord>(
      `SELECT id::text AS "fileId", name AS "fileName", path, root_id AS "rootId",
       embedding_set_id::text AS "embeddingSetId", content_hash AS "contentHash",
       (chunks_processed_at IS NOT NULL) AS "chunksProcessed", NULL::text AS content,
       json_build_object('mtimeMs',mtime_ms,'size',size) AS stat
       FROM file_records WHERE embedding_set_id::text=$1 ORDER BY id`,
      [current.settings.managedCollectionId]
    );
    assertCurrent(current);
    const records = decodeNativeCanonicalCatalogRecords(result.rows);
    if (
      records.some((record) => record.embeddingSetId !== current.settings.managedCollectionId) ||
      new Set(records.map((record) => record.fileId)).size !== records.length
    ) {
      throw new Error('Canonical catalog returned duplicated or unauthorized file identities.');
    }
    return records;
  };
  const resolver = (current: Graph): NativeCanonicalProfileResolver =>
    new NativeCanonicalProfileResolver({
      query: async (sql, params) => (await getDatabase()).query(sql, params),
      readLocalSelection: async () => {
        assertCurrent(current);
        return current.settings.selection ?? undefined;
      },
      resolveEmbeddingSetId: async (scope) => {
        assertCurrent(current);
        if (
          (scope.kind === 'workspace' && !current.leases.has(scope.rootId)) ||
          (scope.kind === 'collection' &&
            scope.embeddingSetId !== current.settings.managedCollectionId)
        ) {
          throw new Error('Canonical profile scope is not authorized by current desktop settings.');
        }
        return current.settings.managedCollectionId;
      },
    });
  const authority = async (): Promise<NativeIndexAuthority> => {
    const current = graph;
    if (!current) {
      throw new TransitionError('Native indexing has no current saved authority.');
    }
    assertCurrent(current);
    const database = await getDatabase();
    const collections = decodeSelectedCollections(
      (
        await database.query('SELECT id::text AS id FROM embedding_sets WHERE id::text=$1', [
          current.settings.managedCollectionId,
        ])
      ).rows
    );
    assertCurrent(current);
    if (collections.length !== 1 || collections[0]?.id !== current.settings.managedCollectionId) {
      throw new Error(
        'The saved native collection is missing or ambiguous in the application catalog.'
      );
    }
    const profile =
      current.settings.mode === 'VECTOR'
        ? (
            await resolver(current).resolve(
              { embeddingSetId: current.settings.managedCollectionId, kind: 'collection' },
              contextFor(current)
            )
          ).profile
        : null;
    const records = current.sources?.scanAdmission?.getInventory() ?? (await loadRecords(current));
    const rootIds = [...current.leases.keys()].sort();
    return {
      fileBindings: records.map((record) => {
        const { fileName: _fileName, ...binding } = identity(current, record);
        return { ...binding, profile };
      }),
      rootIds,
      scopes: [
        ...rootIds.map((rootId) => ({ kind: 'workspace' as const, rootId })),
        { embeddingSetId: current.settings.managedCollectionId, kind: 'collection' },
      ],
    };
  };
  const runtime = createNativeIndexRuntime({
    closeQueries: closeAllIndexQueries,
    createIndexOwner: async (authorized) => {
      const databasePath = path.join(resolveDesktopDatabaseProfileDirectory(), 'index.sqlite');
      const creation = acquireIndexerHost(
        { ...authorized, dbPath: databasePath, embedding: { indexMode: 'text-only' } },
        { closeMs: 1000, exitMs: 1000, requestMs: 5000, startupMs: 60_000 }
      );
      creation.catch(() => undefined);
      return {
        close: () => closeIndexerRuntime(closeAllIndexQueries),
        databasePath,
        destroy: () => destroyIndexerRuntime(closeAllIndexQueries),
        start: async (): Promise<IndexerPort & ScopedIndexerPort> => {
          await creation;
          return isolateNativeCoverage(getReadyScopedIndexerPort(), openIndexCoverage);
        },
      };
    },
    getAuthority: authority,
    getFileInvalidator: () => graph?.publication?.invalidateFile,
    installQueryTarget: () =>
      installIndexQueryTarget(getReadyIndexerHost, { deadlineMs: 1000, startupDeadlineMs: 5000 }),
    profile: dependencies.profile,
  });
  const suspendSources = async (current: Graph): Promise<void> => {
    const sources = current.sources;
    if (!sources) {
      return;
    }
    await retireNativeIndexSources(sources, () => getReadyIndexerHost().retireCanonicalSources());
    if (current.sources === sources) {
      current.sources = undefined;
    }
  };
  const retireSources = async (): Promise<void> => {
    closed = true;
    graph?.controller.abort(new TransitionError('Native indexing admission closed.'));
    const results = await Promise.allSettled([
      runtime.retireReads(),
      graph ? suspendSources(graph) : undefined,
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : []
    );
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Retirement failed.');
    }
    await startup?.catch(() => undefined);
    // Startup can acquire a graph or late source owner while its caller closes admission.
    if (graph) {
      await suspendSources(graph);
      for (const [id, lease] of graph.leases) {
        await lease.retire();
        graph.leases.delete(id);
      }
    }
    await closeAllIndexQueries();
  };
  const stopSourcesOwned = (): Promise<void> => {
    sourceRetirement ??= retireSources().finally(() => {
      sourceRetirement = undefined;
    });
    return sourceRetirement;
  };
  const startOwned = async (ready: {
    resolve(port: IndexerPort & ScopedIndexerPort): void;
  }): Promise<void> => {
    const settings = readNativeIndexSettings(
      await dependencies.storage.getItem(NATIVE_INDEX_SETTINGS_KEY)
    );
    if (!settings.enabled) {
      throw new Error('Native indexing is disabled in saved settings.');
    }
    const current: Graph = {
      controller: new AbortController(),
      generation,
      leases: new Map(),
      settings,
      watchFailures: new Map(),
    };
    graph = current;
    const descriptors = await dependencies.application.roots.restoreRoots();
    assertCurrent(current);
    const database = await getDatabase();
    const roots = decodeRoots(
      (await database.query(`SELECT id, kind FROM roots WHERE status='live'`)).rows
    );
    for (const descriptor of descriptors) {
      if (descriptor.permissionState !== 'granted') {
        continue;
      }
      const root = roots.find((row) => row.id === descriptor.rootId);
      if (!root || (root.kind === 'worktree' && !settings.worktreeOptIns.has(root.id))) {
        continue;
      }
      const lease = await dependencies.application.roots.borrowSourceRoot(
        descriptor.rootId,
        dependencies.application.watches.subscribe.bind(dependencies.application.watches)
      );
      current.leases.set(lease.rootId, lease);
      assertCurrent(current);
    }
    const port = await runtime.acquire();
    assertCurrent(current);
    const authorized = await authority();
    const publication = createNativeCanonicalPublication(
      {
        ...port,
        removeScopedFile: (request) =>
          runtime.mutateAuthority(port, () => port.removeScopedFile(request)),
      },
      authorized.scopes
    );
    current.publication = publication;
    current.observedCatalogRecords = await loadRecords(current);
    current.observedCatalogFingerprint = catalogFingerprint(current.observedCatalogRecords);
    assertCurrent(current);
    ready.resolve(port);
    if (!settings.paused) {
      await admitSources(current, port);
    }
  };
  const startSources = async (
    current: Graph,
    sources: NativeIndexSources,
    port: IndexerPort & ScopedIndexerPort
  ): Promise<void> => {
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
      parser: { parser: 'oxc' as const, treeSitterLanguages: [] },
      request: {
        batchSize: 64,
        chunkingOptions: { strategy: 'auto' as const },
        maxFileBytes: getFileSizeConfig().maxFileSize,
      },
    };
    const pipeline = (
      scope: CanonicalSourceScope
    ): WithoutSource<CanonicalIngestionDependencies> => {
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
          scope.kind === 'workspace'
            ? scanAdmission.workspacePublication(publication)
            : publication,
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
    const scope = { embeddingSetId: settings.managedCollectionId, kind: 'collection' } as const;
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
  };
  const admitSources = (current: Graph, port: IndexerPort & ScopedIndexerPort): Promise<void> => {
    if (current.settings.paused) {
      throw new Error('Native ingestion is paused.');
    }
    if (current.sources) {
      throw new Error('Native ingestion already has a retained source owner.');
    }
    const sources: NativeIndexSources = {
      attachments: new Set(),
      controller: new AbortController(),
      inference: new Set(),
      leases: new Map(),
      workspaceTriggers: new Map(),
    };
    current.sources = sources;
    sources.startup = startSources(current, sources, port);
    sources.startup.catch(() => undefined);
    return sources.startup;
  };
  const ensureStartup = (): void => {
    if (startup) {
      return;
    }
    const ready = Promise.withResolvers<IndexerPort & ScopedIndexerPort>();
    readerReady = ready.promise;
    readerReady.catch(() => undefined);
    startup = startOwned(ready).catch((error: unknown) => {
      if (!graph?.settings.paused) {
        startupFailed = true;
        lastError = error;
      }
      ready.reject(error);
      throw error;
    });
    startup.catch(() => undefined);
  };
  const refreshCatalog = async (
    current: Graph,
    join: boolean,
    inventory?: readonly NativeCanonicalCatalogRecord[]
  ): Promise<void> => {
    const records = inventory ?? (await loadRecords(current));
    const pending = inventory
      ? undefined
      : deferNativeIndexCatalog(current, records, current.sources?.collectionScan);
    if (pending) {
      await pending;
      await refreshCatalog(current, join);
      return;
    }
    const changedRoots = observeNativeIndexCatalog(current, records);
    if (!changedRoots) {
      if (join) {
        await current.sources?.waitForCollection?.();
      }
      return;
    }
    if (current.settings.paused) {
      // Reconcile authority only; never start a parser, watcher or inference while paused.
      return;
    }
    triggerCatalogWorkspaces(changedRoots, current.sources?.workspaceTriggers, (error) =>
      dependencies.onError('catalog workspace reconciliation', error)
    );
    if (inventory || !current.sources?.scanCollection) {
      return;
    }
    const scan = current.sources.scanCollection();
    scan.catch((error: unknown) => {
      lastError = error;
      startupFailed = true;
      dependencies.onError('catalog collection reconciliation', error);
    });
    if (join) {
      await scan;
    }
  };
  const assertAdmission = (): void => {
    if (closed || terminalRequested) {
      throw TransitionError.closedAdmission('Native index activation is closed.', lastError);
    }
    if (settingsReads.size > 0) {
      throw new TransitionError('Native saved configuration is being revalidated.');
    }
  };
  const acquireRead = async (): Promise<IndexerPort & ScopedIndexerPort> => {
    assertAdmission();
    if (graph && [...graph.leases.values()].some((lease) => lease.signal.aborted)) {
      await transition(false);
    }
    ensureStartup();
    try {
      await readerReady;
    } catch (error) {
      throw startupFailed && error === lastError ? retainedNativeIndexFailure(error) : error;
    }
    if (graph?.sources?.controller.signal.aborted) {
      throw lastError ?? graph.sources.controller.signal.reason;
    }
    if (startupFailed) {
      throw retainedNativeIndexFailure(lastError);
    }
    const current = graph;
    if (current) {
      await refreshCatalog(current, false);
    }
    return current?.sources?.scanAdmission
      ? current.sources.scanAdmission.acquireRead(() => runtime.acquire())
      : runtime.acquire();
  };
  const acquire = async (): Promise<IndexerPort & ScopedIndexerPort> => {
    assertAdmission();
    if (graph && [...graph.leases.values()].some((lease) => lease.signal.aborted)) {
      await transition(false);
    }
    ensureStartup();
    await startup;
    if (startupFailed) {
      throw new Error('Canonical native scan failed.', { cause: lastError });
    }
    if (graph?.sources?.controller.signal.aborted) {
      throw lastError ?? graph.sources.controller.signal.reason;
    }
    const current = graph;
    if (current) {
      await refreshCatalog(current, true);
    }
    return current?.sources?.scanAdmission
      ? current.sources.scanAdmission.acquireRead(() => runtime.acquire())
      : runtime.acquire();
  };
  const clearRetiredGraph = (): void => {
    graph = undefined;
    startup = undefined;
    readerReady = undefined;
    lastError = undefined;
    startupFailed = false;
  };
  const closeOwned = (): Promise<void> => {
    stopping ??= stopSourcesOwned()
      .then(() => runtime.closeIndex())
      .then(clearRetiredGraph)
      .finally(() => {
        stopping = undefined;
      });
    return stopping;
  };
  const resumeOwned = async (signal?: AbortSignal): Promise<void> => {
    await runtime.resume(signal).catch((error: unknown) => {
      lastError = error;
      throw error;
    });
    signal?.throwIfAborted();
    if (terminalRequested) {
      throw new TransitionError('Native resume was superseded by terminal retirement.');
    }
    closed = false;
    generation += 1;
  };
  const destroyOwned = async (): Promise<void> => {
    await stopSourcesOwned();
    await runtime.destroyIndex();
    clearRetiredGraph();
  };
  const closeForReconfiguration = async (): Promise<void> => {
    const original = graph;
    await stopSourcesOwned();
    const nextId = readNativeManagedCollectionId(
      await dependencies.storage.getItem(NATIVE_INDEX_SETTINGS_KEY)
    );
    if (original && nextId !== original.settings.managedCollectionId) {
      await runtime.retireWorkspaceCollectionFiles(original.settings.managedCollectionId);
    }
    await closeOwned();
  };
  const fenceTerminal = (): void => {
    terminalRequested = true;
    terminalEpoch += 1;
    closed = true;
    generation += 1;
    graph?.controller.abort(new TransitionError('Native owner terminal retirement requested.'));
  };
  const stopSources = async (): Promise<void> => {
    fenceTerminal();
    const pending = Promise.allSettled([...settingsReads, reconfiguration]).then(() => undefined);
    return joinNativeSourceRetirement(stopSourcesOwned(), pending);
  };
  const closeRootCapabilities = async (): Promise<void> => {
    await stopSources();
    await closeOwned();
  };
  const profileFence = {
    epoch: () => terminalEpoch,
    reconfiguration: () => reconfiguration,
    reopen: () => {
      terminalRequested = false;
    },
    requested: () => terminalRequested,
  };
  const profileAdmission = createProfileAdmission(runtime, profileFence, closeRootCapabilities);
  const close = async (reason?: unknown): Promise<void> => {
    await closeRootCapabilities();
    await runtime.retireProfile(reason);
  };
  const destroyAndRetireProfile = async (): Promise<void> => {
    await stopSources();
    await destroyOwned();
    await runtime.retireProfile();
  };
  const resume = (signal?: AbortSignal): Promise<void> =>
    resumeProfileForReset({
      fence: profileFence,
      resume: () => resumeOwned(signal),
      retire: close,
      signal,
    });
  const transition = (destroy: boolean): Promise<void> => {
    if (terminalRequested) {
      return Promise.reject(
        new TransitionError('Native owner terminal retirement has closed transition admission.')
      );
    }
    const epoch = terminalEpoch;
    closed = true;
    generation += 1;
    graph?.controller.abort(
      new TransitionError(
        destroy ? 'Derived index rebuild requested.' : 'Native source authority changed.'
      )
    );
    const assertTransition = (): void => {
      if (terminalRequested || terminalEpoch !== epoch) {
        throw new TransitionError('Native transition was superseded by terminal retirement.');
      }
    };
    reconfiguration = (reconfiguration?.catch(() => undefined) ?? Promise.resolve()).then(
      async () => {
        assertTransition();
        await (destroy ? destroyOwned() : closeForReconfiguration());
        assertTransition();
        await resumeOwned();
        assertTransition();
        await acquire();
      }
    );
    return reconfiguration;
  };
  const applySourceSettings = (
    current: Graph,
    settings: NativeIndexSettings,
    retire: () => Promise<void>
  ): Promise<void> => {
    current.settings = settings;
    if (settings.paused) {
      current.sources?.controller.abort(new TransitionError('Native ingestion paused.'));
    }
    reconfiguration = (reconfiguration?.catch(() => undefined) ?? Promise.resolve())
      .then(async () => {
        assertCurrent(current);
        await retire();
        assertCurrent(current);
        await getReadyIndexerHost().start();
        startupFailed = false;
        lastError = undefined;
        startup = Promise.resolve();
        if (!current.settings.paused) {
          const port = await runtime.acquire();
          assertCurrent(current);
          startup = admitSources(current, port);
          await startup;
        }
      })
      .catch((error: unknown) => {
        startupFailed = true;
        lastError = error;
        throw error;
      });
    return reconfiguration;
  };
  const prepareInvalidSettings = (error: unknown, epoch: number) => {
    closed = true;
    generation += 1;
    graph?.controller.abort(error);
    const physical = stopSourcesOwned();
    physical.catch(() => undefined);
    return {
      complete: (): Promise<void> => {
        reconfiguration = (reconfiguration?.catch(() => undefined) ?? Promise.resolve()).then(
          async () => {
            await joinInvalidNativeSettingsRetirement(physical, closeForReconfiguration, error);
            lastError = terminalEpoch === epoch ? error : lastError;
            throw error;
          }
        );
        return reconfiguration;
      },
      physical,
    };
  };
  const settingsOwner = {
    apply: applySourceSettings,
    current: () => graph,
    readSettings: () => readTrackedNativeSettings(dependencies.storage, settingsReads),
    suspend: suspendSources,
    transition: () => transition(false),
  };
  const assertSettingsEpoch = (epoch: number, operation: string): void => {
    if (terminalRequested || terminalEpoch !== epoch) {
      throw new TransitionError(`Native ${operation} was superseded by terminal retirement.`);
    }
  };
  const prepareSavedPause = () => {
    const epoch = terminalEpoch;
    return prepareNativeSavedPause({
      ...settingsOwner,
      active: Boolean(startup && (graph || !startupFailed)),
      assertAdmission: () => assertSettingsEpoch(epoch, 'Pause'),
      assertCurrent,
      invalidate: (error) => prepareInvalidSettings(error, epoch),
      readerReady: () => readerReady,
    });
  };
  const reconfigure = (): Promise<void> => {
    const epoch = terminalEpoch;
    return reconfigureNativeSavedSettings({
      ...settingsOwner,
      assertAdmission: () => assertSettingsEpoch(epoch, 'configuration'),
      invalidate: (error) => prepareInvalidSettings(error, epoch),
      terminalRequested,
    });
  };
  const readAuthority = createNativeIndexReadAuthority({
    acquireRead,
    assertCurrent,
    authority,
    getGraph: () => graph,
    readiness: catalogReadiness,
    resolveProfile: (current) =>
      current.settings.mode === 'VECTOR'
        ? resolver(current).resolve(
            { embeddingSetId: current.settings.managedCollectionId, kind: 'collection' },
            contextFor(current)
          )
        : Promise.resolve(null),
    runtime,
    settingsReads,
    setupRequired: () => (closed && lastError instanceof SetupRequired ? lastError : undefined),
  });
  return {
    acquire,
    acquireProfile: profileAdmission.acquireProfile,
    acquireRead,
    captureAcknowledgedAuthority: () => {
      const current = graph;
      if (!current) {
        throw new Error('Native indexing has no live source generation to capture.');
      }
      assertCurrent(current);
      const captured = runtime.captureAcknowledgedAuthority();
      return {
        generation: current.generation,
        port: captured.port,
        readAuthority: () => {
          if (graph !== current) {
            throw new TransitionError('Captured native source generation has been replaced.');
          }
          return captured.readAuthority();
        },
      };
    },
    close,
    closeRootCapabilities: profileAdmission.releaseRootForHost,
    destroyAndRetireProfile,
    fenceTerminal,
    getReadiness: () => (graph ? catalogReadiness(graph) : []),
    getSearchAuthority: readAuthority.getSearchAuthority,
    prepareSavedPause,
    rebuild: () => transition(true),
    reconfigure,
    resume,
    stopSources,
    withRead: readAuthority.withRead,
  };
}
