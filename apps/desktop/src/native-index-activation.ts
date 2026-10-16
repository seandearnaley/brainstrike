import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CanonicalScanReceipt, CanonicalSourceScope } from '@brainstrike/canonical-ingestion';
import {
  createNativeCanonicalCatalog,
  createNativeCanonicalPublication,
  createNativeScanAdmission,
  createNativeSourceInventory,
  isPartitionRoot,
  type NativeCanonicalCatalogRecord,
  NativeCanonicalInference,
  type NativeCanonicalProfileResolver,
  partitionAuthority,
} from '@brainstrike/canonical-ingestion';
import { getFileSizeConfig } from '@brainstrike/file-system';
import type { HostAttachment } from '@brainstrike/host-lease';
import type { IndexerPort, ScopedIndexerPort, VectorProfile } from '@brainstrike/indexer';
import type { CanonicalRemoteIngestion } from './canonical-utility-parent';
import { resolveDesktopDatabaseProfileDirectory } from './desktop-database-location';
import { generateHostedEmbeddings } from './hosted-embeddings';
import {
  acquireIndexerHost,
  closeIndexerRuntime,
  destroyIndexerRuntime,
  getReadyIndexerHost,
  getReadyScopedIndexerPort,
} from './indexer-runtime';
import { NativeAuthorityTransitionError as TransitionError } from './native-authority-transition';
import { isolateNativeCoverage } from './native-coverage-reader';
import { nativeFileIdentity } from './native-index-attach';
import {
  catalogFingerprint,
  catalogReadiness,
  deferNativeIndexCatalog,
  observeNativeIndexCatalog,
  settleDeferredNativeIndexCatalog,
  triggerCatalogWorkspaces,
} from './native-index-catalog-observation';
import { createNativeIndexContentOperations } from './native-index-content-operations';
import {
  nativeGraphContext as contextFor,
  createNativeGraphProfileResolver,
  type NativeIndexActivationDependencies as Dependencies,
  type NativeIndexActivationGraph as Graph,
  loadNativeGraphRecords,
} from './native-index-graph';
import { nativeIndexObservation, nativeIndexReadiness } from './native-index-lifecycle';
import { nativeIndexStateError as stateError } from './native-index-lifecycle-errors';
import {
  createNativeIndexLifecycle,
  NativeSourceRetirementFailure,
} from './native-index-lifecycle-owner';
import { assertSavedCollection, vectorCollectionId } from './native-index-partition';
import { createNativeIndexRuntime, type NativeIndexAuthority } from './native-index-runtime';
import {
  NATIVE_INDEX_SETTINGS_KEY,
  type NativeIndexSettings,
  prepareSavedNativeIndexPause,
  readNativeIndexSettings,
} from './native-index-settings';
import {
  type NativeIndexSources,
  retireNativeIndexSources,
} from './native-index-source-retirement';
import { createNativeIndexWatchHealthHandler } from './native-index-watch-health';
import type { NativeScopedRead, NativeSearchAuthority } from './native-scoped-search';
import {
  closeAllIndexQueries,
  installIndexQueryTarget,
  openIndexCoverage,
} from './sqlite-query-host-manager';

/** Desktop main's actual catalog/grant/inference callbacks; the utility owns parsing and scans. */
export function createNativeIndexActivation(dependencies: Dependencies) {
  // This handle owns physical resources only. Admission and failure are owned by lifecycle.
  let graph: (Graph & { retirement?: Promise<void> | undefined }) | undefined;
  const assertCurrent = (current: Graph): void => {
    current.controller.signal.throwIfAborted();
    if (graph !== current) {
      throw new TransitionError('Native catalog authority changed during its operation.');
    }
  };
  const identity = (current: Graph, record: NativeCanonicalCatalogRecord) =>
    nativeFileIdentity(current.leases, record);
  const loadRecords = (current: Graph) =>
    loadNativeGraphRecords(current, assertCurrent, dependencies.catalog);
  const resolver = (current: Graph): NativeCanonicalProfileResolver =>
    createNativeGraphProfileResolver(current, assertCurrent, {
      collections: dependencies.catalog,
      modelCatalog: dependencies.modelCatalog,
    });
  const authority = async (): Promise<NativeIndexAuthority> => {
    const current = graph;
    if (!current) {
      throw new TransitionError('Native indexing has no current saved authority.');
    }
    assertCurrent(current);
    await assertSavedCollection(current.settings, dependencies.catalog, () =>
      assertCurrent(current)
    );
    const profile =
      current.settings.mode === 'VECTOR'
        ? (
            await resolver(current).resolve(
              { embeddingSetId: vectorCollectionId(current.settings), kind: 'collection' },
              contextFor(current)
            )
          ).profile
        : null;
    return partitionAuthority({
      identity: (record) => identity(current, record),
      profile,
      records: current.sources?.scanAdmission?.getInventory() ?? (await loadRecords(current)),
      rootIds: [...current.leases.keys()],
      settings: current.settings,
    });
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
    await graph?.sources?.startup?.catch(() => undefined);
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
    const current = graph;
    if (!current) {
      return retireSources();
    }
    current.retirement ??= retireSources().finally(() => {
      current.retirement = undefined;
    });
    return current.retirement;
  };
  const startOwned = async (settings: NativeIndexSettings, generation: number): Promise<void> => {
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
    const roots = (await dependencies.catalog.workspaceRoots({ operation: 'list' })).roots.filter(
      (root) => root.status === 'live'
    );
    for (const descriptor of descriptors) {
      if (descriptor.permissionState !== 'granted') {
        continue;
      }
      const root = roots.find((row) => row.id === descriptor.rootId);
      if (!(root && isPartitionRoot(root, settings))) {
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
    if (!settings.paused) {
      admitSources(current, port).catch((error: unknown) => {
        if (!(current.controller.signal.aborted || current.settings.paused)) {
          recordFailure(current, error);
        }
      });
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
      catalog: dependencies.catalog,
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
    const pipeline = (scope: CanonicalSourceScope): CanonicalRemoteIngestion => {
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
  const refreshCatalog = async (
    current: Graph,
    join: boolean,
    inventory?: readonly NativeCanonicalCatalogRecord[],
    joinScan = true
  ): Promise<void> => {
    const records = inventory ?? (await loadRecords(current));
    const sources = current.sources;
    const pending = inventory
      ? undefined
      : deferNativeIndexCatalog(
          current,
          records,
          sources?.collectionScan ?? sources?.scanAdmission?.getWorkspaceCompletions()
        );
    if (pending) {
      // Passive catalog observation must not invalidate the discovery publication
      // whose committed records it just read. Internal inventory never joins itself.
      await settleDeferredNativeIndexCatalog(
        current,
        sources?.scanAdmission?.joinPublication(pending) ?? pending,
        joinScan,
        () => refreshCatalog(current, join),
        (error) => {
          if (graph === current && !current.controller.signal.aborted) {
            recordFailure(current, error);
            dependencies.onError('catalog refresh after scan', error);
          }
        }
      );
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
      recordFailure(current, error);
      dependencies.onError('catalog collection reconciliation', error);
    });
    if (join) {
      await scan;
    }
  };
  const readSettings = async (): Promise<NativeIndexSettings> =>
    readNativeIndexSettings(await dependencies.storage.getItem(NATIVE_INDEX_SETTINGS_KEY));
  const captureSettings = (): Promise<NativeIndexSettings> => {
    const settings = readSettings();
    // Observe immediately while owner construction/admission is pending; preserve the rejection.
    settings.catch(() => undefined);
    return settings;
  };
  const closeOwned = async (destroy = false): Promise<void> => {
    await stopSourcesOwned();
    if (destroy) {
      await runtime.destroyIndex();
    } else {
      await runtime.closeIndex();
    }
    graph = undefined;
  };
  const applySources = async (settings: NativeIndexSettings): Promise<void> => {
    const current = graph;
    if (!current) {
      throw new TransitionError('Native Pause has no retained read authority.');
    }
    current.settings = settings;
    await suspendSources(current).catch((error: unknown) => {
      throw new NativeSourceRetirementFailure({ error });
    });
    assertCurrent(current);
    await getReadyIndexerHost().start();
    if (!current.settings.paused) {
      const port = await runtime.acquire();
      assertCurrent(current);
      admitSources(current, port).catch((error: unknown) => recordFailure(current, error));
    }
  };
  const lifecycle = createNativeIndexLifecycle(
    { generation: 0, kind: 'idle' },
    {
      execute: async (action) => {
        switch (action.kind) {
          case 'stop-sources': {
            await stopSourcesOwned();
            return;
          }
          case 'close': {
            const state = await (await lifecycle).state();
            if (state.kind === 'unconfigured') {
              graph?.controller.abort(state.cause.error ?? new Error(state.cause.message));
            }
            await closeOwned();
            return;
          }
          case 'retire-profile': {
            await runtime.retireProfile(action.cause);
            return;
          }
          case 'apply-sources': {
            await applySources(action.settings);
            return;
          }
          case 'open': {
            const owner = await lifecycle;
            const state = await owner.state();
            if (
              (state.kind !== 'opening' && state.kind !== 'transitioning') ||
              state.generation !== action.generation
            ) {
              throw stateError(state);
            }
            graph?.controller.abort(new TransitionError('Native source authority changed.'));
            if (graph) {
              await closeOwned(action.destroy);
            }
            await runtime.resume();
            const current = await owner.state();
            if (current !== state) {
              throw stateError(current);
            }
            await startOwned(state.settings, action.generation);
            return { generation: action.generation, kind: 'opened' };
          }
        }
      },
      fence: () =>
        graph?.controller.abort(new TransitionError('Native owner terminal retirement requested.')),
    }
  );
  const recordFailure = (current: Graph, error: unknown): void => {
    lifecycle
      .then((owner) =>
        owner.dispatch({
          error,
          generation: current.generation,
          kind: 'failure',
          message: error instanceof Error ? error.message : String(error),
        })
      )
      .catch((failure: unknown) => dependencies.onError('failure observation', failure));
  };
  const currentReader = async (): Promise<Graph> => {
    // Capture this command's input before owner construction can yield to a later save.
    // Only the lifecycle owner may accept it as an initial configuration.
    const settings = captureSettings();
    const owner = await lifecycle;
    let state = await owner.start(settings);
    if (
      (state.kind === 'opening' && state.generation === 1) ||
      (state.kind === 'validating' && state.previous.kind === 'idle' && state.generation === 0)
    ) {
      state = await owner.settled();
    }
    if (nativeIndexReadiness(state).kind !== 'ready') {
      throw stateError(state);
    }
    if (graph && [...graph.leases.values()].some((lease) => lease.signal.aborted)) {
      await owner.configure(readSettings, true);
      state = await owner.state();
      if (nativeIndexReadiness(state).kind !== 'ready') {
        throw stateError(state);
      }
    }
    if (!graph) {
      throw new TransitionError('Native indexing has no current source authority.');
    }
    assertCurrent(graph);
    return graph;
  };
  const acquireRead = async (): Promise<IndexerPort & ScopedIndexerPort> => {
    const current = await currentReader().catch(async (error: unknown) => {
      const state = await (await lifecycle).state();
      if (
        (state.kind === 'failed' || state.kind === 'unconfigured') &&
        state.cause.error === error
      ) {
        throw stateError(state);
      }
      throw error;
    });
    await refreshCatalog(current, false, undefined, false);
    // While a catalog change waits for its scan, reads stay on the acknowledged bindings.
    const read = current.queuedCatalogRecords ? runtime.acknowledged : runtime.acquire;
    return current.sources?.scanAdmission
      ? current.sources.scanAdmission.acquireRead(read)
      : read();
  };
  const acquire = async (): Promise<IndexerPort & ScopedIndexerPort> => {
    const current = await currentReader();
    await current.sources?.startup;
    assertCurrent(current);
    const state = await (await lifecycle).state();
    if (nativeIndexReadiness(state).kind !== 'ready') {
      throw stateError(state);
    }
    await refreshCatalog(current, true);
    return current.sources?.scanAdmission
      ? current.sources.scanAdmission.acquireRead(() => runtime.acquire())
      : runtime.acquire();
  };
  const dispatch = async (
    event: Parameters<Awaited<typeof lifecycle>['dispatch']>[0]
  ): Promise<void> => {
    await (await lifecycle).dispatch(event);
  };
  const stopSources = (): Promise<void> =>
    dispatch({ kind: 'stop-sources', reason: 'root-data-deletion' });
  const fenceTerminal = (): void => {
    dispatch({ kind: 'fence', reason: 'shutdown' }).catch((error: unknown) =>
      dependencies.onError('terminal fence', error)
    );
  };
  const close = async (cause?: unknown): Promise<void> => {
    await dispatch({ cause, kind: 'terminal', reason: 'profile-retired' });
  };
  const resume = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const owner = await lifecycle;
    await owner.settled();
    signal?.throwIfAborted();
    await owner.dispatch({ kind: 'profile-resume' });
    const expected = await owner.state();
    let retiring: Promise<void> | undefined;
    const onAbort = (): void => {
      retiring = close(signal?.reason);
      retiring.catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const failures: unknown[] = [];
    try {
      await runtime.resume(signal);
      signal?.throwIfAborted();
      const current = await owner.state();
      if (current !== expected) {
        throw stateError(current);
      }
      await owner.dispatch({ generation: expected.generation, kind: 'profile-resumed' });
    } catch (error) {
      failures.push(error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try {
        await retiring;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Native reset resume and retirement failed');
    }
  };
  const acquireProfile = async (): Promise<HostAttachment> => {
    const owner = await lifecycle;
    const recover = async (): Promise<boolean> => {
      if (!(await runtime.retireFailedProfile())) {
        return false;
      }
      const state = await owner.state();
      if (state.kind === 'closed') {
        if (state.reason !== 'host-released') {
          return false;
        }
        const resuming = await owner.dispatch({ kind: 'profile-resume' });
        await owner.dispatch({ generation: resuming.generation, kind: 'profile-resumed' });
      }
      return true;
    };
    // BST-2004: a lost ready host fails like a failed start; join its Root release first.
    const recovered = await recover();
    let state = await owner.state();
    if (state.kind === 'closed' && !recovered) {
      throw stateError(state);
    }
    const admit = async (): Promise<HostAttachment> => {
      const attachment = await runtime.acquireProfile({ indexIndependent: true });
      state = await owner.state();
      if (state.kind === 'closed') {
        throw stateError(state);
      }
      return attachment;
    };
    try {
      return await admit();
    } catch (cause) {
      let recovered: boolean;
      try {
        recovered = await recover();
      } catch (release) {
        throw cause instanceof AggregateError && cause.errors.includes(release)
          ? cause
          : new AggregateError([cause, release], 'Host acquisition failed and its release failed');
      }
      if (!recovered) {
        throw cause;
      }
      return admit();
    }
  };
  const reconfigure = async (roots = false): Promise<void> => {
    const settings = captureSettings();
    await (await lifecycle).configure(() => settings, roots);
    await graph?.sources?.startup;
  };
  const prepareSavedPause = () => prepareSavedNativeIndexPause(dependencies.storage, lifecycle);
  const assertReadAdmission = async (): Promise<void> => {
    const state = await (await lifecycle).state();
    if (state.kind !== 'idle' && nativeIndexReadiness(state).kind !== 'ready') {
      throw stateError(state);
    }
  };
  const getSearchAuthority = async (
    acknowledged?: NativeIndexAuthority
  ): Promise<NativeSearchAuthority> => {
    await assertReadAdmission();
    const current = graph;
    if (!current) {
      throw new TransitionError('Native indexing has no current source authority.');
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
            { embeddingSetId: vectorCollectionId(current.settings), kind: 'collection' },
            contextFor(current)
          )
        : null;
    assertCurrent(current);
    for (const lease of current.leases.values()) {
      lease.signal.throwIfAborted();
    }
    await assertReadAdmission();
    return {
      bindings: acknowledged?.fileBindings ?? authorized.fileBindings,
      collectionId: current.settings.managedCollectionId,
      generation: current.generation,
      profile: resolved?.profile ?? null,
      queryPlan: resolved
        ? {
            ...(resolved.workerPlan ? { inferencePlan: resolved.workerPlan } : {}),
            modelKey: resolved.modelKey,
          }
        : undefined,
      readiness: catalogReadiness(current),
      rootIds: authorized.rootIds,
    };
  };
  const withRead = async <T>(work: (read: NativeScopedRead) => Promise<T>): Promise<T> => {
    try {
      await assertReadAdmission();
      return await runtime.withRead(acquireRead, (captured) =>
        work({
          getAuthority: async () => {
            const result = await getSearchAuthority(captured.readAuthority());
            captured.readAuthority();
            return result;
          },
          port: captured.port,
        })
      );
    } catch (error) {
      const state = await (await lifecycle).state();
      // Only the retained owner failure is classified; independent read/cleanup failures pass through.
      if (
        (state.kind === 'failed' || state.kind === 'unconfigured') &&
        state.cause.error === error
      ) {
        throw stateError(state);
      }
      throw error;
    }
  };
  return {
    ...createNativeIndexContentOperations({
      acquire,
      assertCurrent,
      captureSettings,
      closeNativeOwner: () => dispatch({ kind: 'terminal', reason: 'root-data-deletion' }),
      closeOwned,
      getGraph: () => graph,
      retireProfile: close,
      runtime,
      stopSources,
    }),
    acquire,
    acquireProfile,
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
    closeNativeOwner: () => dispatch({ kind: 'terminal', reason: 'root-data-deletion' }),
    closeRootCapabilities: async () => {
      const state = await (await lifecycle).state();
      if (state.kind === 'closed' && state.reason !== 'host-released') {
        // The host calls this from profile retirement itself: join the resource
        // close without queueing behind the action that is awaiting this callback.
        await closeOwned();
        return;
      }
      await dispatch({ kind: 'terminal', reason: 'host-released' });
    },
    fenceTerminal,
    getReadiness: () => (graph ? catalogReadiness(graph) : []),
    getSearchAuthority: () => getSearchAuthority(),
    observeLifecycle: async (
      listener: (value: ReturnType<typeof nativeIndexObservation>) => void,
      signal: AbortSignal
    ) => (await lifecycle).observe((state) => listener(nativeIndexObservation(state)), signal),
    prepareSavedPause,
    rebuild: async () => {
      const settings = captureSettings();
      await (await lifecycle).rebuild(() => settings);
      await graph?.sources?.startup;
    },
    reconfigure: () => reconfigure(),
    reconfigureRoots: () => reconfigure(true),
    resume,
    stopSources,
    withRead,
  };
}
