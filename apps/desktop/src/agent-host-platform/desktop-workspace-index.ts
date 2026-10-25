import type { HostWorkspaceIndex, WorkspaceIndexEvent } from '@brainstrike/agent-host';
import { localIndexConfigStore } from '@brainstrike/agent-host/catalog';
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { createNativeScopedSearchCapability } from '@brainstrike/assistant-service/node-native-text-services';
import type { CanonicalHostedEmbeddings } from '@brainstrike/canonical-ingestion';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import type { StateStore } from '@brainstrike/state-store';
import { generateHostedEmbeddings, type HostedEmbeddingCredentials } from '../hosted-embeddings';
import { assertRegisteredEmbeddingModel, createDesktopIndexConfig } from '../index-config';
import type { ForkLentUtility } from '../lent-utility';
import type { LifecycleDelaySeam } from '../lifecycle-delay-seam';
import { createDesktopModelCatalog } from '../model-catalog';
import { createNativeIndexActivation } from '../native-index-activation';
import { reportNativeIndexActivationError } from '../native-index-activation-error';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';
import type { NativeIndexActivationDependencies, NativeIndexProfile } from '../native-index-graph';
import { observeNativeIndex } from '../native-index-observations';
import { createNativeRootDataDeletion } from '../native-root-data-deletion';
import { createNativeRootRegistration } from '../native-root-registration';
import { openIndexQuery } from '../sqlite-query-host-manager';
import type { DesktopWorkspaceRoots } from './desktop-workspace-roots';

const logger = createLogger('DesktopWorkspaceIndex');

export interface DesktopWorkspaceIndex {
  /** A content clear: the index and its folders' bookkeeping go before the store clears. */
  clearForContent(): Promise<void>;
  /** Closes the index with its host: sources, readers and the writer, joined. */
  close(): Promise<void>;
  /** A disconnected folder's derived index data. */
  deleteRootData(rootId: string): Promise<void>;
  /**
   * Main's embedding Stop: the index pauses its saved settings first, so its own inference is
   * cancelled before the renderer stops (`stop` is Main's).
   */
  embeddingStop(stop: () => Promise<void>): Promise<void>;
  readonly index: HostWorkspaceIndex;
  /** A rewound or checked-out folder's files changed under the index. */
  requestWorkspaceScan(rootId: string): Promise<void>;
  /** The folders changed: the index re-reads them. Its own failure is reported, not thrown. */
  rootsChanged(): void;
  /** The index's reads for this host's own tools and run admission. */
  readonly search: IndexSearchCapability;
}

interface DesktopWorkspaceIndexOptions {
  readonly databasePath: string;
  /** Main's embedding renderer, lent to the index (ADR-0007). */
  readonly embedding: NativeIndexActivationDependencies['embedding'];
  readonly folders: DesktopWorkspaceRoots;
  readonly forkLentUtility: ForkLentUtility;
  readonly hostedCredentials: HostedEmbeddingCredentials;
  readonly isClosing: () => boolean;
  readonly lifecycleDelays: LifecycleDelaySeam;
  /** The host's own cancellation: once it is closing, the index stops observing itself. */
  readonly signal: AbortSignal;
  readonly store: StateStore;
}

/**
 * The index lives inside its profile's host: it opens with the host and retires with it, so it
 * never borrows or restarts the host itself. Retirement joins the index's close first.
 */
function hostIndexProfile(): NativeIndexProfile {
  let retiring = false;
  return {
    acquire: async () => undefined,
    isRetiring: () => retiring,
    retire: async (beforeClose) => {
      retiring = true;
      await beforeClose;
    },
    retireFailed: async () => false,
  };
}

/**
 * A client's index request: the index's own refusals (closed, preparing, off, setup) cross typed,
 * as Main's IPC answered them; anything else is logged here and crosses as the internal fault.
 */
function typedIndexFailures<P, R>(run: (params: P) => Promise<R>): (params: P) => Promise<R> {
  return async (params) => {
    try {
      return await run(params);
    } catch (error) {
      throw new BoundaryFailureError(
        nativeIndexBoundaryFailure(error, (message, fields) => logger.error(message, fields)),
        { cause: error }
      );
    }
  };
}

/**
 * ADR-0029 stage 4: the desktop's native search index, run by its agent host over the host's own
 * store and folders. Main lends it the index utilities (ADR-0030 decision 1) and the embedding
 * renderer; everything else it needs is the host's.
 */
export function createDesktopWorkspaceIndex(
  options: DesktopWorkspaceIndexOptions
): DesktopWorkspaceIndex {
  const { folders, store } = options;
  const listeners = new Set<(event: WorkspaceIndexEvent) => void>();
  // A subscriber starts from the index's current state: a window that outlived its host learns
  // the replacement's settings and lifecycle without waiting for the next change.
  let observation: Extract<WorkspaceIndexEvent, { type: 'lifecycle' }> | undefined;
  let configChanges = 0;
  const publish = (event: WorkspaceIndexEvent): void => {
    if (event.type === 'lifecycle') {
      observation = event;
    } else {
      configChanges += 1;
    }
    for (const listener of listeners) {
      listener(event);
    }
  };
  const reportError = (message: string, error: unknown): void =>
    reportNativeIndexActivationError(message, error, options.isClosing(), logger);
  const hostedEmbeddings: CanonicalHostedEmbeddings = (input) =>
    generateHostedEmbeddings({ ...input, credentials: options.hostedCredentials });
  const modelCatalog = createDesktopModelCatalog(store);
  const activation = createNativeIndexActivation({
    application: folders,
    catalog: store,
    databasePath: options.databasePath,
    embedding: options.embedding,
    forkLentUtility: options.forkLentUtility,
    hostedEmbeddings,
    lifecycleDelays: () => options.lifecycleDelays,
    modelCatalog,
    onError: (operation, error) => reportError(`Native indexing ${operation} failed`, error),
    onReceipt: (receipt) =>
      logger.info('Canonical native scan settled', {
        receipt,
        settledAt: new Date().toISOString(),
      }),
    profile: hostIndexProfile(),
    settings: () => indexConfig.nativeSettings(),
  });
  const rootData = createNativeRootDataDeletion({
    acquire: () => activation.acquire(),
    captureOwner: async () => {
      await activation.getSearchAuthority();
      return activation.captureAcknowledgedAuthority();
    },
    closeOwner: () => activation.closeNativeOwner(),
    deleteCanonicalRoot: async (mounted) => {
      await store.workspaceRoots({
        operation: 'delete',
        paths: [mounted.canonicalPath, mounted.presentationPath],
        rootId: mounted.rootId,
      });
    },
    reserveRoot: (rootId) => folders.roots.reserveRootDataDeletion(rootId),
    resume: () => activation.resume(),
    stopSources: () => activation.stopSources(),
  });
  const search = createNativeScopedSearchCapability({
    openQuery: openIndexQuery,
    rebuild: () => rootData.transition(() => activation.rebuild()),
    withRead: activation.withRead,
  });
  const registration = createNativeRootRegistration({
    isShuttingDown: options.isClosing,
    reconfigureRoots: () => activation.reconfigureRoots(),
    reportError,
    transition: (operation) => rootData.transition(operation),
  });
  const activateSavedSettings = (): Promise<void> =>
    rootData.prepareTransition(
      () => activation.prepareSavedPause(),
      (prepared) => (prepared ? prepared.complete() : activation.reconfigure())
    );
  const indexConfig = createDesktopIndexConfig({
    assertModel: assertRegisteredEmbeddingModel,
    catalog: {
      collections: (request) => store.collections(request),
      ...localIndexConfigStore(store),
    },
    publish: (config) => publish({ config, type: 'config' }),
    // A saved change joins the native owner's FIFO and `update` returns: the scan runs in the
    // background, so a Pause saved meanwhile fences admission at once. Each apply re-reads the
    // saved config when it runs, so the index ends on the last save. Failures stay visible in
    // the lifecycle observation and these reports.
    rebuild: async () => {
      search
        .rebuild()
        .catch((error: unknown) =>
          reportError('Search index rebuild for the new chunking failed', error)
        );
    },
    reconfigure: async () => {
      activateSavedSettings().catch((error: unknown) =>
        reportError('Saved native index configuration could not activate', error)
      );
    },
    replaceVectorSpace: (id) =>
      rootData.transition(async () => {
        await activation.cleanupCollection(id);
        await store.collections({ id, operation: 'delete' });
        await activation.resume();
      }),
  });
  const observer = new AbortController();
  // Clients follow this push for the index's lifecycle, status and coverage; none of them polls.
  observeNativeIndex({
    coverageBatch: search.coverageBatch,
    observeChanges: activation.observeChanges,
    observeLifecycle: activation.observeLifecycle,
    publish: (observation) => publish({ observation, type: 'lifecycle' }),
    signal: AbortSignal.any([observer.signal, options.signal]),
    status: search.status,
  }).catch((error: unknown) => {
    if (error !== observer.signal.reason && error !== options.signal.reason) {
      reportError('Native lifecycle observer failed', error);
    }
  });
  // The index opens with its host; a start that fails stays in the lifecycle it reports.
  activation.acquire().catch((error: unknown) => {
    reportError('Native index activation unavailable', error);
  });
  const done = {};
  const index: HostWorkspaceIndex = {
    'index/config/read': typedIndexFailures(() => indexConfig.read()),
    'index/config/update': typedIndexFailures((patch) => indexConfig.update(patch)),
    'index/coverage': typedIndexFailures((request) => search.coverage(request)),
    'index/coverage-batch': typedIndexFailures(({ requests }) => search.coverageBatch(requests)),
    'index/file-chunks': typedIndexFailures((request) => search.fileChunks(request)),
    'index/grep': typedIndexFailures((request) => search.grep(request)),
    'index/rebuild': typedIndexFailures(async () => {
      await search.rebuild();
      return done;
    }),
    'index/retry': typedIndexFailures(async () => {
      await rootData.transition(() => activation.retryIndexing());
      return done;
    }),
    'index/roots-registered': typedIndexFailures(async () => {
      await registration.rootsRegistered();
      return done;
    }),
    'index/search': typedIndexFailures((request) => search.search(request)),
    'index/status': typedIndexFailures(() => search.status()),
    subscribe: (listener) => {
      listeners.add(listener);
      if (observation) {
        listener(observation);
      }
      // A change saved during this read reaches the listener itself, and is newer than the read.
      const changesBefore = configChanges;
      indexConfig.read().then(
        (config) => {
          if (listeners.has(listener) && configChanges === changesBefore) {
            listener({ config, type: 'config' });
          }
        },
        (error: unknown) => reportError('Search index settings could not be read', error)
      );
      return () => listeners.delete(listener);
    },
  };
  return {
    clearForContent: async () => {
      await activation.destroyNativeOwner();
      await folders.roots.clearForContent();
    },
    close: async () => {
      activation.fenceTerminal();
      observer.abort(new Error('The workspace index closed.'));
      listeners.clear();
      await activation.close();
    },
    deleteRootData: (rootId) => rootData.deleteRootData(rootId),
    embeddingStop: async (stop) => {
      const admitted = Promise.withResolvers<{ paused: boolean; stop: Promise<void> }>();
      const completion = rootData.prepareTransition(
        async () => {
          try {
            const pause = await activation.prepareSavedPause();
            // The index's own inference is cancelled before the renderer stops. Start the Stop
            // here: the earlier FIFO entry may itself be waiting for inference.
            const stopping = stop();
            stopping.catch(() => undefined);
            admitted.resolve({ paused: pause !== null, stop: stopping });
            return { pause, stopping };
          } catch (error) {
            admitted.reject(error);
            throw error;
          }
        },
        async ({ pause, stopping }) => {
          const [native, host] = await Promise.allSettled([pause?.complete(), stopping]);
          const failures = [native, host].flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          );
          if (failures.length > 1) {
            throw new AggregateError(
              failures,
              'Saved native Pause and embedding Stop did not settle.'
            );
          }
          if (failures.length === 1) {
            throw failures[0];
          }
        }
      );
      completion.catch(admitted.reject);
      const ready = await admitted.promise;
      await (ready.paused ? completion : ready.stop);
    },
    index,
    requestWorkspaceScan: (rootId) => activation.requestWorkspaceScan(rootId),
    rootsChanged: () => {
      // Not awaited, as a client's registration is not: the index status owns the outcome, and
      // the registration reports its own failure.
      registration.rootsRegistered().catch(() => undefined);
    },
    search,
  };
}
