import path from 'node:path';
import type {
  NativeScopedRead,
  NativeSearchAuthority,
} from '@brainstrike/assistant-service/node-native-text-services';
import { NativeAuthorityTransitionError as TransitionError } from '@brainstrike/assistant-service/node-native-text-services';
import type { CanonicalScanReceipt, CanonicalSourceScope } from '@brainstrike/canonical-ingestion';
import {
  assertSavedCollection,
  createNativeCanonicalCatalog,
  createNativeCanonicalPublication,
  createNativeScanAdmission,
  createNativeSourceInventory,
  isPartitionRoot,
  type NativeCanonicalCatalogRecord,
  NativeCanonicalInference,
  type NativeCanonicalProfileResolver,
  partitionAuthority,
  vectorCollectionId,
} from '@brainstrike/canonical-ingestion';
import { getFileSizeConfig } from '@brainstrike/file-system';
import type { IndexerPort, ScopedIndexerPort, VectorProfile } from '@brainstrike/indexer';
import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import { CHILD_CLOSE_BUDGET_MS } from '@brainstrike/state-store';
import type { CanonicalRemoteIngestion } from './canonical-utility-parent';
import { resolveDesktopDatabaseProfileDirectory } from './desktop-database-location';
import { generateHostedEmbeddings } from './hosted-embeddings';
import {
  acquireIndexerHost,
  closeIndexerRuntime,
  destroyIndexerRuntime,
  fenceIndexerCanonicalSources,
  getReadyIndexerHost,
  getReadyScopedIndexerPort,
} from './indexer-runtime';
import { isolateNativeCoverage } from './native-coverage-reader';
import { nativeFileIdentity } from './native-index-attach';
import {
  catalogFingerprint,
  deferNativeIndexCatalog,
  observeNativeIndexCatalog,
  settleDeferredNativeIndexCatalog,
} from './native-index-catalog-observation';
import { createNativeIndexContentOperations } from './native-index-content-operations';
import {
  nativeGraphContext as contextFor,
  createNativeGraphProfileResolver,
  type NativeIndexActivationDependencies as Dependencies,
  type NativeIndexActivationGraph as Graph,
  loadNativeGraphRecords,
} from './native-index-graph';
import {
  type NativeIndexState,
  nativeIndexObservation,
  nativeIndexReadiness,
} from './native-index-lifecycle';
import { nativeIndexStateError as stateError } from './native-index-lifecycle-errors';
import {
  createNativeIndexLifecycle,
  NativeSourceRetirementFailure,
} from './native-index-lifecycle-owner';
import { createNativeIndexProfileAdmission } from './native-index-profile-admission';
import { createNativeIndexFailures } from './native-index-reopen';
import { createNativeIndexRuntime, type NativeIndexAuthority } from './native-index-runtime';
import { type NativeIndexSettings, prepareSavedNativeIndexPause } from './native-index-settings';
import {
  type NativeIndexSources,
  settleNativeIndexSources,
} from './native-index-source-retirement';
import { createNativeIndexWatchHealthHandler } from './native-index-watch-health';
import {
  closeAllIndexQueries,
  installIndexQueryTarget,
  openIndexCoverage,
} from './sqlite-query-host-manager';

/** Why a closing generation's work ends: its settings failure, or the typed Off choice. */
function unconfiguredReason(state: Extract<NativeIndexState, { kind: 'unconfigured' }>): unknown {
  return state.cause.kind === 'off'
    ? stateError(state)
    : (state.cause.error ?? new Error(state.cause.message));
}
const logger = createLogger('NativeIndexActivation');

/** Desktop main's actual catalog/grant/inference callbacks; the utility owns parsing and scans. */
export function createNativeIndexActivation(dependencies: Dependencies) {
  // This handle owns physical resources only. Admission and failure are owned by lifecycle.
  let graph: (Graph & { retirement?: Promise<void> | undefined }) | undefined;
  // A scan's start, settle or invalidation, or a source's health, changed what a status read says.
  const changeListeners = new Set<() => void>();
  const indexChanged = (): void => {
    for (const listener of changeListeners) {
      listener();
    }
  };
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
            await resolver(current).resolveVectorSpace(
              vectorCollectionId(current.settings),
              contextFor(current)
            )
          ).profile
        : null;
    return partitionAuthority({
      identity: (record) => identity(current, record),
      profile,
      records: await loadRecords(current),
      rootIds: [...current.leases.keys()],
      settings: current.settings,
    });
  };
  const runtime = createNativeIndexRuntime({
    admitProfile: (signal) => admission.acquire(signal),
    closeQueries: closeAllIndexQueries,
    createIndexOwner: async (authorized) => {
      const databasePath = path.join(resolveDesktopDatabaseProfileDirectory(), 'index.sqlite');
      const creation = acquireIndexerHost(
        { ...authorized, dbPath: databasePath, embedding: { indexMode: 'text-only' } },
        // R5(b) only (ADR-0030): from the close request to the utility's exit, then a kill and
        // the still-joined exit. Startup and requests have no deadline (R2).
        { closeMs: CHILD_CLOSE_BUDGET_MS },
        dependencies.lifecycleDelays
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
    await settleNativeIndexSources(
      sources,
      () => getReadyIndexerHost().retireCanonicalSources(),
      (exit) => dependencies.onError('source retirement', exit)
    );
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
    // The next open borrows the folders it restores; a restore meanwhile has nothing to tell.
    dependencies.application.roots.releaseRestoredRoots();
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
  // The lifecycle opens no generation for Off settings (`native-index-lifecycle.ts`, `open`).
  const startOwned = async (settings: NativeIndexSettings, generation: number): Promise<void> => {
    const current: Graph = {
      controller: new AbortController(),
      generation,
      leases: new Map(),
      settings,
      watchFailures: new Map(),
    };
    graph = current;
    // One registry mutation: a folder removed meanwhile is removed after these borrows.
    await dependencies.application.roots.borrowRestoredRoots(async (descriptors, borrow) => {
      assertCurrent(current);
      const roots = (await dependencies.catalog.workspaceRoots({ operation: 'list' })).roots.filter(
        (root) => root.status === 'live'
      );
      for (const descriptor of descriptors) {
        if (descriptor.permissionState !== 'granted') {
          continue;
        }
        const root = roots.find((row) => row.id === descriptor.rootId);
        if (!(root && isPartitionRoot(root))) {
          continue;
        }
        const lease = await borrow(
          descriptor.rootId,
          dependencies.application.watches.subscribe.bind(dependencies.application.watches)
        );
        current.leases.set(lease.rootId, lease);
        assertCurrent(current);
      }
    });
    const port = await runtime.acquire();
    assertCurrent(current);
    const authorized = await authority();
    const publication = createNativeCanonicalPublication(
      {
        ...port,
        // A scan's proofs are reads: another root's binding replacement joins them
        // before it retires their query client (BST-2055).
        coverageScope: (request) => runtime.withWriterRead(port, () => port.coverageScope(request)),
        removeScopedFiles: (request) =>
          runtime.mutateAuthority(port, () => port.removeScopedFiles(request)),
        verifyScopedManifest: (request) =>
          runtime.withWriterRead(port, () => port.verifyScopedManifest(request)),
      },
      authorized.rootIds.map((rootId) => ({ kind: 'workspace', rootId }) as const),
      indexChanged
    );
    current.publication = publication;
    current.observedCatalogFingerprint = catalogFingerprint(await loadRecords(current));
    assertCurrent(current);
    if (!settings.paused) {
      admitSources(current, port);
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
    for (const [rootId, reader] of current.leases) {
      const lease = await dependencies.application.roots
        .borrowSourceRoot(
          rootId,
          dependencies.application.watches.subscribe.bind(dependencies.application.watches)
        )
        .catch((error: unknown) => {
          // A folder removed since the open answers with its retirement, as the lease does.
          reader.signal.throwIfAborted();
          throw error;
        });
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
        if (!current.leases.has(scope.rootId)) {
          throw new Error('Canonical catalog scope is not currently authorized.');
        }
        return {
          assertCurrent: () => {
            assertSource();
            current.leases.get(scope.rootId)?.signal.throwIfAborted();
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
        scope,
      });
    const manager = getReadyIndexerHost();
    const common = {
      parser: { parser: 'oxc' as const },
      request: {
        batchSize: 64,
        chunkingOptions:
          settings.chunking._tag === 'Custom'
            ? {
                maxTokens: settings.chunking.maxTokens,
                overlap: settings.chunking.overlap,
                strategy: 'auto' as const,
              }
            : { strategy: 'auto' as const },
        maxFileBytes: getFileSizeConfig().maxFileSize,
      },
    };
    const pipeline = (scope: CanonicalSourceScope): CanonicalRemoteIngestion => {
      if (settings.mode === 'TEXT') {
        return {
          catalog,
          managedCollectionId: settings.managedCollectionId,
          mode: 'TEXT',
          parser: common.parser,
          publication: scanAdmission.workspacePublication(publication),
        };
      }
      const inference = new NativeCanonicalInference({
        hostedEmbeddings: generateHostedEmbeddings,
        resolver: profileResolver,
        scope,
      });
      sources.inference.add(inference);
      return {
        catalog,
        inference,
        managedCollectionId: settings.managedCollectionId,
        mode: 'VECTOR',
        parser: common.parser,
        publication: scanAdmission.workspacePublication(publication),
      };
    };
    const firstReceipts: Promise<CanonicalScanReceipt>[] = [];
    for (const lease of sources.leases.values()) {
      // The folder's lease is the scan's authority: its retirement ends the wait too.
      const signal = AbortSignal.any([
        current.controller.signal,
        sources.controller.signal,
        lease.signal,
      ]);
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
        onError: (operation, reported) => {
          // A folder removed during its scan fails the utility's reads, and that failure returns
          // by name only: it answers with the lease's own typed retirement.
          const error: unknown = lease.signal.aborted ? lease.signal.reason : reported;
          if (operation === 'sync' || operation === 'sync loop') {
            scanAdmission.failWorkspace(lease.rootId, error);
          }
          reject(error);
          dependencies.onError(operation, error);
        },
        onReceipt: (receipt, sourceInvalidated) => {
          indexChanged();
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
        },
        onWatchHealth: createNativeIndexWatchHealthHandler({
          changed: indexChanged,
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
  };
  /** Start ingestion and observe its startup; a Pause or retirement supersedes a failure. */
  const admitSources = (current: Graph, port: IndexerPort & ScopedIndexerPort): void => {
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
    sources.startup.then(failures.started, (error: unknown) => {
      if (current.controller.signal.aborted || current.settings.paused) {
        // Superseded: the next generation redoes the work.
        logger.debug('A retired native ingestion generation ended with an error', {
          error,
          generation: current.generation,
        });
        return;
      }
      failures.record(current.generation, error, true);
    });
  };
  const refreshCatalog = async (current: Graph, joinScan = true): Promise<void> => {
    const records = await loadRecords(current);
    const sources = current.sources;
    const pending = deferNativeIndexCatalog(
      current,
      records,
      sources?.scanAdmission?.getWorkspaceCompletions()
    );
    if (pending) {
      // Passive catalog observation must not invalidate the discovery publication
      // whose committed records it just read.
      await settleDeferredNativeIndexCatalog(
        current,
        sources?.scanAdmission?.joinPublication(pending) ?? pending,
        joinScan,
        () => refreshCatalog(current),
        (error) => {
          if (graph === current && !current.controller.signal.aborted) {
            failures.record(current.generation, error);
            dependencies.onError('catalog refresh after scan', error);
          }
        }
      );
      return;
    }
    observeNativeIndexCatalog(current, records);
  };
  const captureSettings = (): Promise<NativeIndexSettings> => {
    const settings = dependencies.settings();
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
      admitSources(current, port);
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
              graph?.controller.abort(unconfiguredReason(state));
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
              // E2E seam: an open replacing a live index waits this long before borrowing a host.
              await dependencies.lifecycleDelays?.().delay('index-replace');
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
      fence: () => {
        // One turn, as `retireSources` does: revoked utility work answers cancelled (BST-2140).
        graph?.controller.abort(new TransitionError('Native owner terminal retirement requested.'));
        fenceIndexerCanonicalSources();
      },
    }
  );
  const failures = createNativeIndexFailures({
    delaysMs: dependencies.reopenDelaysMs,
    dispatch: async (event) => (await lifecycle).dispatch(event),
    onError: dependencies.onError,
  });
  const currentReader = async (joinOpen = false): Promise<Graph> => {
    // Capture this command's input before owner construction can yield to a later save.
    // Only the lifecycle owner may accept it as an initial configuration.
    const settings = captureSettings();
    const owner = await lifecycle;
    let state = await owner.start(settings);
    if (
      // An explicit owner joins an open in flight, such as the one resume() started;
      // reads join only boot's first open (BST-2277).
      (joinOpen &&
        (state.kind === 'opening' ||
          state.kind === 'transitioning' ||
          state.kind === 'validating')) ||
      (state.kind === 'opening' && state.generation === 1) ||
      (state.kind === 'validating' && state.previous.kind === 'idle' && state.generation === 0)
    ) {
      state = await owner.settled();
    }
    if (nativeIndexReadiness(state).kind !== 'ready') {
      throw stateError(state);
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
    await refreshCatalog(current, false);
    // While a catalog change waits for its scan, reads stay on the acknowledged bindings.
    const read = current.queuedCatalogRecords ? runtime.acknowledged : runtime.acquire;
    return current.sources?.scanAdmission
      ? current.sources.scanAdmission.acquireRead(read)
      : read();
  };
  const acquire = async (): Promise<IndexerPort & ScopedIndexerPort> => {
    const current = await currentReader(true);
    await current.sources?.startup?.catch((error: unknown) => {
      // A generation its owner replaced or retired answers with that owner's typed reason; its
      // sources' own rejection (a retired mount's abort) only echoes that retirement.
      current.controller.signal.throwIfAborted();
      throw error;
    });
    assertCurrent(current);
    const state = await (await lifecycle).state();
    if (nativeIndexReadiness(state).kind !== 'ready') {
      throw stateError(state);
    }
    await refreshCatalog(current);
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
  /**
   * A resumed generation's starter (reset resume, host-loss recovery): open the idle index
   * from its saved settings, as boot does. Reads never start it (BST-2277). The outcome is
   * the lifecycle's state, which readers see with its cause; a refusal is reported here.
   */
  const openResumed = async (): Promise<void> => {
    try {
      await (await lifecycle).start(captureSettings());
      await graph?.sources?.startup;
    } catch (error) {
      dependencies.onError('open after resume', error);
    }
  };
  /** The close a host's release requested; the index reopens after it on the next host. */
  let hostReleased: Promise<unknown> | undefined;
  // BST-2004: the replacement of a host whose release closed the index is admitted. The
  // index reopens after that close has run, once, without any borrow waiting for it.
  const resumeAfterHostRelease = async (): Promise<void> => {
    const released = hostReleased;
    hostReleased = undefined;
    if (!released) {
      return;
    }
    try {
      await released;
    } catch {
      // That close's failure was reported where it ran; the index stays closed.
      return;
    }
    try {
      const owner = await lifecycle;
      const state = await owner.state();
      if (state.kind !== 'closed' || state.reason !== 'host-released') {
        return;
      }
      const resuming = await owner.dispatch({ kind: 'profile-resume' });
      await owner.dispatch({ generation: resuming.generation, kind: 'profile-resumed' });
    } catch (error) {
      dependencies.onError('resume after host release', error);
      return;
    }
    await openResumed();
  };
  const admission = createNativeIndexProfileAdmission(lifecycle, runtime, () => {
    void resumeAfterHostRelease();
  });
  const fenceTerminal = (): void => {
    failures.cancel();
    admission.fenceTerminal();
    dispatch({ kind: 'fence', reason: 'shutdown' }).catch((error: unknown) =>
      dependencies.onError('terminal fence', error)
    );
  };
  const close = async (cause?: unknown): Promise<void> => {
    failures.cancel();
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
    // Not waited on: quit cancels a reset's replacement startup, and an indexer start cannot
    // be cancelled. Shutdown joins this open through the lifecycle permit like any other.
    void openResumed();
  };
  const reconfigure = async (roots = false): Promise<void> => {
    const settings = captureSettings();
    await (await lifecycle).configure(() => settings, roots);
    await graph?.sources?.startup;
  };
  const prepareSavedPause = () => prepareSavedNativeIndexPause(dependencies.settings, lifecycle);
  const assertReadAdmission = async (): Promise<void> => {
    const state = await (await lifecycle).state();
    if (nativeIndexReadiness(state).kind !== 'ready') {
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
      const message = [...current.watchFailures.values()].join(' ');
      throw new NativeIndexRefusalError({ kind: 'source-failure', message }, message);
    }
    for (const lease of current.leases.values()) {
      lease.signal.throwIfAborted();
    }
    const authorized = await authority();
    const resolved =
      current.settings.mode === 'VECTOR'
        ? await resolver(current).resolveVectorSpace(
            vectorCollectionId(current.settings),
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
      queryPlan: resolved ? { modelKey: resolved.modelKey } : undefined,
      readiness: current.publication?.getReadiness() ?? [],
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
      assertCurrent,
      closeNativeOwner: () => dispatch({ kind: 'terminal', reason: 'root-data-deletion' }),
      closeOwned,
      getGraph: () => graph,
      retireProfile: close,
      runtime,
      stopSources,
    }),
    acquire,
    acquireProfile: admission.acquire,
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
    closeRootCapabilities: async (host: 'closing' | 'gone') => {
      const state = await (await lifecycle).state();
      if (state.kind === 'closed' && state.reason !== 'host-released') {
        // The host calls this from profile retirement itself: join the resource
        // close without queueing behind the action that is awaiting this callback.
        await closeOwned();
        return;
      }
      const released = dispatch({ kind: 'terminal', reason: 'host-released' });
      hostReleased = released;
      if (host === 'closing') {
        await released;
        return;
      }
      // BST-2004: a host that is gone holds no writer to release, and its owner's release must
      // not queue behind an index action that may be waiting for the host admitted after it.
      // The terminal fenced that action's work; its close runs when the action ends.
      released.catch((error: unknown) => dependencies.onError('lost host Root release', error));
    },
    fenceTerminal,
    getReadiness: () => graph?.publication?.getReadiness() ?? [],
    getSearchAuthority: () => getSearchAuthority(),
    /** Hears each change a status read would show besides the lifecycle; `signal` ends it. */
    observeChanges: (listener: () => void, signal: AbortSignal): void => {
      changeListeners.add(listener);
      signal.addEventListener('abort', () => changeListeners.delete(listener), { once: true });
    },
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
