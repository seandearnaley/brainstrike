import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  CanonicalCatalogFile,
  CanonicalIngestionDependencies,
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalSourceScope,
  CanonicalWorkspaceLease,
} from '@brainstrike/canonical-ingestion';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { getFileSizeConfig } from '@brainstrike/file-system';
import type { IndexerPort, ScopedIndexerPort, VectorProfile } from '@brainstrike/indexer';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { Schema } from 'effect';
import { getDatabase } from './db-main';
import { resolveDesktopDatabaseProfileDirectory } from './desktop-database-location';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { createDesktopHostLease } from './host-lease-manager';
import {
  acquireIndexerHost,
  closeIndexerRuntime,
  destroyIndexerRuntime,
  getReadyIndexerHost,
  getReadyScopedIndexerPort,
} from './indexer-runtime';
import type { ApplicationIpcDomain } from './ipc-handlers';
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
import { createNativeIndexRuntime, type NativeIndexAuthority } from './native-index-runtime';
import {
  NATIVE_INDEX_SETTINGS_KEY,
  type NativeIndexSettings,
  nativeIndexConfigurationIdentity,
  readNativeIndexSettings,
  readNativeManagedCollectionId,
} from './native-index-settings';
import {
  type NativeIndexSources,
  retireNativeIndexSources,
} from './native-index-source-retirement';
import type { NativeSearchAuthority } from './native-scoped-search';
import { closeAllIndexQueries, installIndexQueryTarget } from './sqlite-query-host-manager';

const decodeRoots = makeThrowingDecoder(
  Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      kind: Schema.Literals(['path', 'fsa', 'snapshot', 'legacy', 'worktree']),
    })
  )
);

const decodeSelectedCollections = makeThrowingDecoder(
  Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))
);
const catalogBatchSize = 250;
function catalogFingerprint(records: readonly NativeCanonicalCatalogRecord[]): string {
  return JSON.stringify(
    records.map(({ chunksProcessed: _processed, content: _content, ...record }) => record)
  );
}

type WithoutSource<T> = T extends unknown ? Omit<T, 'source'> : never;
interface Dependencies {
  readonly application: ApplicationIpcDomain;
  readonly embedding: Pick<EmbeddingHostManager, 'documentEmbeddings'>;
  readonly onError: (operation: string, error: unknown) => void;
  readonly onReceipt?: (receipt: CanonicalScanReceipt) => void;
  readonly storage: Pick<ElectronStorageAdapter, 'getItem'>;
}
interface Graph {
  catalogFingerprint?: string;
  catalogRecords?: readonly NativeCanonicalCatalogRecord[];
  readonly controller: AbortController;
  readonly generation: number;
  readonly leases: Map<string, CanonicalWorkspaceLease>;
  publication?: ReturnType<typeof createNativeCanonicalPublication>;
  settings: NativeIndexSettings;
  sources?: NativeIndexSources | undefined;
  readonly watchFailures: Map<string, string>;
}
const scopeMatches = (left: CanonicalSourceScope, right: CanonicalSourceScope): boolean =>
  left.kind === right.kind &&
  (left.kind === 'workspace' && right.kind === 'workspace'
    ? left.rootId === right.rootId
    : left.kind === 'collection' &&
      right.kind === 'collection' &&
      left.embeddingSetId === right.embeddingSetId);

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
      throw new Error('Native catalog authority changed during its operation.');
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
      throw new Error('Native indexing has no current saved authority.');
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
    const records = await loadRecords(current);
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
        { closeMs: 1000, exitMs: 1000, requestMs: 5000, startupMs: 5000 }
      );
      creation.catch(() => undefined);
      return {
        close: () => closeIndexerRuntime(closeAllIndexQueries),
        databasePath,
        destroy: () => destroyIndexerRuntime(closeAllIndexQueries),
        start: async (): Promise<IndexerPort & ScopedIndexerPort> => {
          await creation;
          return getReadyScopedIndexerPort();
        },
      };
    },
    createProfileOwner: () =>
      createDesktopHostLease({
        closeTimeoutMs: 1000,
        root: resolveDesktopDatabaseProfileDirectory(),
        startupTimeoutMs: 5000,
      }),
    getAuthority: authority,
    getFileInvalidator: () => graph?.publication?.invalidateFile,
    installQueryTarget: () =>
      installIndexQueryTarget(getReadyIndexerHost, { deadlineMs: 1000, startupDeadlineMs: 5000 }),
  });
  const suspendSources = (current: Graph): Promise<void> => {
    const sources = current.sources;
    if (!sources) {
      return Promise.resolve();
    }
    return retireNativeIndexSources(sources, () =>
      getReadyIndexerHost().retireCanonicalSources()
    ).then(() => {
      if (current.sources === sources) {
        current.sources = undefined;
      }
    });
  };
  const retireSources = async (): Promise<void> => {
    closed = true;
    graph?.controller.abort(new Error('Native indexing admission closed.'));
    const current = graph;
    if (current) {
      await suspendSources(current);
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
    const publication = createNativeCanonicalPublication(port, authorized.scopes);
    current.publication = publication;
    current.catalogRecords = await loadRecords(current);
    current.catalogFingerprint = catalogFingerprint(current.catalogRecords);
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
        throw new Error('Native ingestion admission changed.');
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
    const profileResolver = resolver(current);
    const catalog = createNativeCanonicalCatalog<VectorProfile>({
      database,
      joinNativeRemoval: async (files, scope) => {
        for (const file of files) {
          await port.removeScopedFile({ fileId: file.fileId, scope });
        }
        assertSource();
      },
      replaceTrustedBindings: async () => {
        await runtime.acquire();
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
    const inventory = (scope: CanonicalSourceScope) => ({
      loadFiles: async (requested: CanonicalSourceScope, context: CanonicalOperationContext) => {
        if (!scopeMatches(scope, requested)) {
          throw new Error('Canonical source inventory scope changed.');
        }
        const records = (await loadRecords(current)).filter(
          (record) => requested.kind === 'collection' || record.rootId === requested.rootId
        );
        const files: CanonicalCatalogFile[] = [];
        for (let offset = 0; offset < records.length; offset += catalogBatchSize) {
          context.signal.throwIfAborted();
          assertSource();
          files.push(
            ...(await catalog.loadAuthorizedBatch(
              {
                files: records
                  .slice(offset, offset + catalogBatchSize)
                  .map((record) => identity(current, record)),
                scope,
              },
              context
            ))
          );
          context.signal.throwIfAborted();
          assertSource();
        }
        if (scope.kind === 'collection') {
          sources.collectionInventory = records;
        }
        return files;
      },
      readRetained: (
        file: Parameters<typeof catalog.readRetainedSource>[0],
        maxBytes: number,
        context: CanonicalOperationContext
      ) => catalog.readRetainedSource(file, maxBytes, scope, context),
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
        return { catalog, mode: 'TEXT', parser: common.parser, publication };
      }
      const inference = new NativeCanonicalInference({
        resolver: profileResolver,
        scope,
        transport: dependencies.embedding,
      });
      sources.inference.add(inference);
      return { catalog, inference, mode: 'VECTOR', parser: common.parser, publication };
    };
    const firstReceipts: Promise<CanonicalScanReceipt>[] = [];
    for (const lease of sources.leases.values()) {
      const first = Promise.withResolvers<CanonicalScanReceipt>();
      const onAbort = (): void => first.reject(sources.controller.signal.reason);
      sources.controller.signal.addEventListener('abort', onAbort, { once: true });
      first.promise
        .finally(() => sources.controller.signal.removeEventListener('abort', onAbort))
        .catch(() => undefined);
      firstReceipts.push(first.promise);
      const scope = { kind: 'workspace', rootId: lease.rootId } as const;
      let workspace: Awaited<ReturnType<typeof manager.attachCanonicalWorkspace>> | undefined;
      workspace = await manager.attachCanonicalWorkspace({
        ...common,
        ...pipeline(scope),
        managedCollectionId: settings.managedCollectionId,
        onError: (operation, error) => {
          first.reject(error);
          dependencies.onError(operation, error);
        },
        onReceipt: (receipt) => {
          dependencies.onReceipt?.(receipt);
          if (receipt.scanComplete) {
            first.resolve(receipt);
          } else {
            first.reject(new Error(`Initial native workspace scan was ${receipt.reason}.`));
          }
          if (sources.scanCollection && !sources.controller.signal.aborted) {
            sources
              .scanCollection()
              .catch((error: unknown) =>
                dependencies.onError('collection refresh after workspace scan', error)
              );
          }
        },
        onWatchHealth: (health) => {
          if (sources.controller.signal.aborted) {
            return;
          }
          if (health.state === 'healthy') {
            const recovering = current.watchFailures.delete(lease.rootId);
            if (recovering && workspace) {
              workspace
                .trigger()
                .catch((error: unknown) => dependencies.onError('watch recovery scan', error));
            }
            return;
          }
          if (
            health.state === 'degraded' ||
            health.state === 'failed' ||
            health.state === 'stopped'
          ) {
            const reason = health.failure?.message ?? `Workspace watcher is ${health.state}.`;
            current.watchFailures.set(lease.rootId, reason);
            current.publication?.invalidateScope(scope);
            current.publication?.invalidateScope({
              embeddingSetId: settings.managedCollectionId,
              kind: 'collection',
            });
            dependencies.onError('workspace watcher health', new Error(reason));
          }
        },
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
    let requested = false;
    sources.scanCollection = (): Promise<void> => {
      assertSource();
      requested = true;
      collectionScan ??= Promise.resolve()
        .then(async () => {
          while (requested) {
            requested = false;
            assertSource();
            await runtime.acquire();
            assertSource();
            sources.collectionInventory = await loadRecords(current);
            const receipt = await collection.scan(randomUUID());
            dependencies.onReceipt?.(receipt);
            assertSource();
            if (!receipt.scanComplete) {
              throw new Error(`Native collection scan was ${receipt.reason}.`);
            }
            current.catalogRecords = sources.collectionInventory;
            current.catalogFingerprint = catalogFingerprint(current.catalogRecords);
            await reverifyWorkspaces();
            const latest = await loadRecords(current);
            if (catalogFingerprint(latest) !== current.catalogFingerprint) {
              publication.invalidateScope(scope);
              requested = true;
            }
          }
        })
        .finally(() => {
          collectionScan = undefined;
        });
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
  const refreshCatalog = async (current: Graph, join: boolean): Promise<void> => {
    const records = await loadRecords(current);
    if (current.catalogFingerprint === catalogFingerprint(records)) {
      return;
    }
    current.publication?.invalidateScope({
      embeddingSetId: current.settings.managedCollectionId,
      kind: 'collection',
    });
    for (const rootId of current.leases.keys()) {
      const before = current.catalogRecords?.filter((record) => record.rootId === rootId) ?? [];
      const after = records.filter((record) => record.rootId === rootId);
      if (catalogFingerprint(before) === catalogFingerprint(after)) {
        continue;
      }
      current.publication?.invalidateScope({ kind: 'workspace', rootId });
      if (current.settings.paused) {
        continue;
      }
      const trigger = current.sources?.workspaceTriggers.get(rootId);
      if (!trigger) {
        continue;
      }
      const work = trigger();
      work.catch((error: unknown) =>
        dependencies.onError('catalog workspace reconciliation', error)
      );
    }
    if (current.settings.paused || !current.sources?.scanCollection) {
      // Reconcile authority only; never start a parser, watcher or inference while paused.
      current.catalogRecords = records;
      current.catalogFingerprint = catalogFingerprint(records);
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
  const acquireRead = async (): Promise<IndexerPort & ScopedIndexerPort> => {
    if (closed || terminalRequested) {
      throw new Error('Native index activation is closed.', { cause: lastError });
    }
    if (settingsReads.size > 0) {
      throw new Error('Native saved configuration is being revalidated.');
    }
    if (graph && [...graph.leases.values()].some((lease) => lease.signal.aborted)) {
      await transition(false);
    }
    ensureStartup();
    await readerReady;
    if (graph?.sources?.controller.signal.aborted) {
      throw new Error('Native ingestion retirement remains owned.', { cause: lastError });
    }
    if (startupFailed) {
      throw new Error('Canonical native scan failed.', { cause: lastError });
    }
    const current = graph;
    if (current) {
      await refreshCatalog(current, false);
    }
    return runtime.acquire();
  };
  const acquire = async (): Promise<IndexerPort & ScopedIndexerPort> => {
    if (closed || terminalRequested) {
      throw new Error('Native index activation is closed.', { cause: lastError });
    }
    if (settingsReads.size > 0) {
      throw new Error('Native saved configuration is being revalidated.');
    }
    if (graph && [...graph.leases.values()].some((lease) => lease.signal.aborted)) {
      await transition(false);
    }
    ensureStartup();
    await startup;
    if (startupFailed) {
      throw new Error('Canonical native scan failed.', { cause: lastError });
    }
    if (graph?.sources?.controller.signal.aborted) {
      throw new Error('Native ingestion retirement remains owned.', { cause: lastError });
    }
    const current = graph;
    if (current) {
      await refreshCatalog(current, true);
    }
    return runtime.acquire();
  };
  const closeOwned = (): Promise<void> => {
    stopping ??= stopSourcesOwned()
      .then(() => runtime.retireProfile())
      .then(() => {
        graph = undefined;
        startup = undefined;
        readerReady = undefined;
      })
      .finally(() => {
        stopping = undefined;
      });
    return stopping;
  };
  const resumeOwned = async (): Promise<void> => {
    await runtime.resume();
    if (terminalRequested) {
      throw new Error('Native resume was superseded by terminal retirement.');
    }
    closed = false;
    lastError = undefined;
    startupFailed = false;
    generation += 1;
  };
  const destroyOwned = async (): Promise<void> => {
    await stopSourcesOwned();
    await runtime.destroyIndex();
    await runtime.retireProfile();
    graph = undefined;
    startup = undefined;
    readerReady = undefined;
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
  const fenceTerminal = (): Promise<void> | undefined => {
    terminalRequested = true;
    terminalEpoch += 1;
    closed = true;
    generation += 1;
    graph?.controller.abort(new Error('Native owner terminal retirement requested.'));
    return Promise.allSettled([...settingsReads, reconfiguration]).then(() => undefined);
  };
  const stopSources = async (): Promise<void> => {
    const pending = fenceTerminal();
    const source = stopSourcesOwned();
    const outcomes = await Promise.allSettled([source, pending]);
    // Transition startup failures remain observed by their caller; physical cleanup must still succeed.
    const result = outcomes[0];
    if (result?.status === 'rejected') {
      throw result.reason;
    }
  };
  const close = async (): Promise<void> => {
    await stopSources();
    await closeOwned();
  };
  const destroyAndRetireProfile = async (): Promise<void> => {
    await stopSources();
    await destroyOwned();
  };
  const resume = async (): Promise<void> => {
    const epoch = terminalEpoch;
    if (reconfiguration) {
      await reconfiguration.catch(() => undefined);
    }
    if (terminalEpoch !== epoch) {
      throw new Error('Native resume was superseded by terminal retirement.');
    }
    terminalRequested = false;
    await resumeOwned();
  };
  const transition = (destroy: boolean): Promise<void> => {
    if (terminalRequested) {
      return Promise.reject(
        new Error('Native owner terminal retirement has closed transition admission.')
      );
    }
    const epoch = terminalEpoch;
    closed = true;
    generation += 1;
    graph?.controller.abort(
      new Error(destroy ? 'Derived index rebuild requested.' : 'Native source authority changed.')
    );
    const assertTransition = (): void => {
      if (terminalRequested || terminalEpoch !== epoch) {
        throw new Error('Native transition was superseded by terminal retirement.');
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
  const reconfigure = async (): Promise<void> => {
    if (terminalRequested) {
      throw new Error('Native owner terminal retirement has closed transition admission.');
    }
    const epoch = terminalEpoch;
    const reading = dependencies.storage
      .getItem(NATIVE_INDEX_SETTINGS_KEY)
      .then(readNativeIndexSettings);
    settingsReads.add(reading);
    let settings: NativeIndexSettings;
    try {
      settings = await reading;
    } catch (error) {
      if (terminalRequested || terminalEpoch !== epoch) {
        throw new Error('Native configuration was superseded by terminal retirement.');
      }
      closed = true;
      generation += 1;
      graph?.controller.abort(error);
      reconfiguration = (reconfiguration?.catch(() => undefined) ?? Promise.resolve()).then(
        async () => {
          try {
            await closeForReconfiguration();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Invalid native settings retained cleanup ownership.'
            );
          }
          throw error;
        }
      );
      return reconfiguration;
    } finally {
      settingsReads.delete(reading);
    }
    if (terminalRequested || terminalEpoch !== epoch) {
      throw new Error('Native configuration was superseded by terminal retirement.');
    }
    const current = graph;
    if (
      !current ||
      nativeIndexConfigurationIdentity(current.settings) !==
        nativeIndexConfigurationIdentity(settings) ||
      (settings.paused === current.settings.paused && !current.sources?.controller.signal.aborted)
    ) {
      return transition(false);
    }
    current.settings = settings;
    if (settings.paused) {
      current.sources?.controller.abort(new Error('Native ingestion paused.'));
    }
    reconfiguration = (reconfiguration?.catch(() => undefined) ?? Promise.resolve())
      .then(async () => {
        assertCurrent(current);
        await suspendSources(current);
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
  return {
    acquire,
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
            throw new Error('Captured native source generation has been replaced.');
          }
          return captured.readAuthority();
        },
      };
    },
    close,
    destroyAndRetireProfile,
    getReadiness: () => graph?.publication?.getReadiness() ?? [],
    getSearchAuthority: async (): Promise<NativeSearchAuthority> => {
      if (settingsReads.size > 0) {
        throw new Error('Native saved configuration is being revalidated.');
      }
      const current = graph;
      if (!current) {
        throw new Error('Native indexing has no current source authority.');
      }
      assertCurrent(current);
      if (current.watchFailures.size > 0) {
        throw new Error([...current.watchFailures.values()].join(' '));
      }
      for (const lease of current.leases.values()) {
        lease.signal.throwIfAborted();
      }
      const authorized = await authority();
      const resolved =
        current.settings.mode === 'VECTOR'
          ? await resolver(current).resolve(
              { embeddingSetId: current.settings.managedCollectionId, kind: 'collection' },
              contextFor(current)
            )
          : null;
      assertCurrent(current);
      return {
        bindings: authorized.fileBindings,
        collectionId: current.settings.managedCollectionId,
        generation: current.generation,
        profile: resolved?.profile ?? null,
        queryPlan: resolved?.workerPlan
          ? { inferencePlan: resolved.workerPlan, modelKey: resolved.modelKey }
          : undefined,
        readiness: current.publication?.getReadiness() ?? [],
        rootIds: authorized.rootIds,
      };
    },
    rebuild: () => transition(true),
    reconfigure,
    resume,
    stopSources,
  };
}
