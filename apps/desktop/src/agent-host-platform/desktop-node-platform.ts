import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  LocalEmbeddingHostClient,
  ProviderAuthInput,
  RuntimeData,
} from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  type HostPlatformLaunchOptions,
  type HostRunAdmissionRequest,
  type HostStartupContext,
  type HostTurnSnapshotRoot,
  hostPermissionGate,
  type ProductionHostPlatformOptions,
  type ProductionHostRunConfiguration,
  readHostPermissionPolicy,
} from '@brainstrike/agent-host';
import { fromBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { refusalError } from '@brainstrike/assistant-contract';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createHostCapabilities } from '@brainstrike/host-capabilities';
import {
  getGlobalHooksPath,
  loadHostRunHooks,
  trustedHookRoots,
} from '@brainstrike/host-capabilities/hooks';
import { createDesktopNodeMcpHost } from '@brainstrike/host-capabilities/mcp/desktop-node-mcp';
import {
  forgetSharedNativeToolThread,
  ReadWorkspaceFileCursorRegistry,
  selectHostProjectionRewrites,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import { type NativeChild, observeNativeChildren } from '@brainstrike/state-store/native-children';
import { Schema } from 'effect';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import {
  agentHostLifecycleDelaySeam,
  agentHostLifecycleDelays,
} from '../agent-host-lifecycle-delays';
import { createCatalogRetrievalStore } from '../assistant-server/retrieval-store-catalog';
import { loadWorkspaceRootsFromCatalog } from '../assistant-server/workspace-roots';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';
import { createWorkspaceRootResolver } from '../git-ipc-handlers';
import { mainPlatformConnection } from './connection';
import { createDesktopGitWorkspace } from './desktop-git-workspace';
import { desktopHostSharedTools } from './desktop-host-shared-tools';
import {
  createDesktopRunAdmission,
  type DesktopAdmissionReads,
  type DesktopRunSelection,
} from './desktop-run-admission';
import { createDesktopTerminals } from './desktop-terminals';
import { DesktopWorkspaceBindingAuthority } from './desktop-workspace-binding';
import { desktopWorkspaceDiscovery } from './desktop-workspace-discovery';
import { createDesktopWorkspaceFiles } from './desktop-workspace-files';
import { createDesktopWorkspaceIndex } from './desktop-workspace-index';
import { createDesktopWorkspaceRoots } from './desktop-workspace-roots';
import { createE2eSyntheticFiles } from './e2e-synthetic-files';
import { forwardHostDiagnostics } from './host-diagnostics';
import { PLATFORM_FOLDER_GRANTED, PLATFORM_FOLDER_OPENED } from './host-folders-wire';
import { PLATFORM_EMBEDDING_STOP, PLATFORM_RUNTIME_PREFERENCES_READ } from './host-index-wire';
import { createHostUtilityLending, serveUtilityReports } from './host-lent-utility';
import { serveMainRequests } from './host-main-requests';
import { mainQueryEmbedding } from './host-retrieval-clients';
import { disposeHostTools, hostCommandSessionManager } from './host-tool-process';
import {
  createDesktopHostMemoryConfiguration,
  desktopMemoryModels,
} from './memory-model-configuration';
import { desktopMemoryPreconditions } from './memory-readiness';
import { resolveDesktopMemoryEmbedderProbe } from './memory-vector-configuration';
import { parentPlatformPort } from './parent-platform-port';
import {
  PLATFORM_DIAGNOSTICS_RECORD_METHOD,
  PLATFORM_EMBEDDING_DOCUMENTS,
  PLATFORM_EMBEDDING_RESTART,
  PlatformCatalogModelResultSchema,
  PlatformEmbeddingDocumentsResultSchema,
  PlatformLocalModelResultSchema,
  PlatformMemoryVectorsResultSchema,
  PlatformObserverCandidatesResultSchema,
} from './platform-wire';
import { PLATFORM_UTILITY_FORK, PLATFORM_UTILITY_KILL } from './utility-lending-wire';

const logger = createLogger('DesktopNodePlatform');
function desktopRuntimeConfiguration(selected: DesktopRunSelection): RuntimeData & {
  readonly provider: SupportedProvider;
} {
  const provider = selected.configuration.provider;
  if (!isSupportedProvider(provider)) {
    throw refusalError(
      'configuration',
      'provider.unsupported',
      'Desktop selected an unsupported provider'
    );
  }
  return {
    model: selected.configuration.model,
    provider,
    ...(selected.configuration.modelSettings
      ? { modelSettings: selected.configuration.modelSettings }
      : {}),
    ...(selected.configuration.providerOptions
      ? { providerOptions: selected.configuration.providerOptions }
      : {}),
    ...(selected.workspace
      ? {
          boundWorkspaceRootId: selected.workspace.boundWorkspaceRootId,
          workspaceRoots: selected.workspace.roots,
        }
      : {}),
  };
}
/** A turn ends on the roots it started with; a turn that started on none has nothing to end. */
function turnEndRoots(
  roots: readonly HostTurnSnapshotRoot[] | undefined
): readonly HostTurnSnapshotRoot[] {
  if (!roots || roots.length === 0) {
    throw new Error('A turn end needs the roots its start captured');
  }
  return roots;
}
type PlatformRequest = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
/**
 * ADR-0007: Node never runs local inference. A thread's admitted recall
 * embedder borrows Main's hidden embedding host; JSON-RPC cancellation carries
 * the caller's signal.
 *
 * It used to lend local GENERATION too, from Main's hidden llm-host, under an
 * admission gate (only this thread's admitted chat model or observer could
 * borrow it). The built-in local provider is embeddings-only now, so there is
 * no generation to lend.
 */
function borrowedLocalInference(
  request: PlatformRequest,
  selected: DesktopRunSelection
): {
  readonly embedding: LocalEmbeddingHostClient;
} {
  return {
    embedding: {
      queryEmbedding: async ({ query }, options) => {
        const local = selected.localEmbedding;
        if (!local) {
          throw refusalError(
            'configuration',
            'embedding.not-configured',
            'Local embedding is not part of this admitted thread selection',
            'Select a local embedding model in Settings.'
          );
        }
        const { workerPlan } = local;
        return await mainQueryEmbedding(
          request,
          {
            dimensions: workerPlan.dimensions,
            inferencePlan: workerPlan,
            modelId: workerPlan.modelId,
            modelKey: local.modelKey,
            query,
          },
          options?.signal
        );
      },
    },
  };
}
/**
 * BST-1930 stage e: the host's run admission reads Main's settings over the private
 * connection; the folders, their binding and the index are this host's own.
 */
function desktopAdmissionReads(
  request: PlatformRequest,
  local: Pick<DesktopAdmissionReads, 'acquireWorkspace' | 'indexStatus' | 'liveWorkspaceRoots'>
): DesktopAdmissionReads {
  return {
    ...local,
    catalogModel: async (target, signal) =>
      Schema.decodeUnknownSync(PlatformCatalogModelResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/admission/catalog-model', target, signal)),
    enabledObservers: async (candidates, signal) =>
      Schema.decodeUnknownSync(PlatformObserverCandidatesResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/admission/observers', { candidates }, signal)),
    localRuntimeModel: async (target, signal) =>
      Schema.decodeUnknownSync(PlatformLocalModelResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/admission/local-model', target, signal)),
    memoryVectors: async (settings, signal) => {
      const resolved = Schema.decodeUnknownSync(PlatformMemoryVectorsResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/admission/memory-vectors', { settings }, signal));
      return resolved
        ? { profile: resolved.profile, ...(resolved.local ? { local: resolved.local } : {}) }
        : undefined;
    },
  };
}
interface DesktopHostConfiguration
  extends Omit<ProductionHostPlatformOptions, 'startup' | 'memoryResourceIds'> {
  confirmMainReady(): Promise<void>;
}
export async function createDesktopHostConfiguration(
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<DesktopHostConfiguration> {
  const port = await parentPlatformPort();
  // ADR-0030 decision 1: Main forks this host's index utilities and lends their channels.
  const lending = createHostUtilityLending({
    fork: async (forkRequest) => {
      wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
        await request(PLATFORM_UTILITY_FORK, forkRequest)
      );
    },
    kill: async (utilityId) => {
      wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
        await request(PLATFORM_UTILITY_KILL, { utilityId })
      );
    },
  });
  const connection = mainPlatformConnection(port, lending.attachPort);
  serveUtilityReports(connection, lending);
  // The profile's one credential authority: the single writer and token holder.
  const host = await createHostCapabilities({
    env: process.env,
    launch: platformOptions,
    startup,
  });
  // One host-lifetime registry; its handles are scoped to their thread.
  const readFileCursorRegistry = new ReadWorkspaceFileCursorRegistry();
  // The runs this host admitted and the bindings they hold, for their own revalidation.
  const admittedRuns = new Map<
    string,
    {
      readonly binding?: HostRunAdmissionRequest['workspaceBinding'];
      readonly selection: DesktopRunSelection;
    }
  >();
  const request: PlatformRequest = async (method, input, signal) => {
    signal?.throwIfAborted();
    const cancellation = new CancellationTokenSource();
    const cancel = (): void => cancellation.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await connection.sendRequest(method, input, cancellation.token);
    } catch (cause) {
      // Main's typed failure (or the internal fault) continues to this host's caller.
      throw fromBoundaryResponseError(cause, (message, fields) =>
        logger.error(message, { ...fields, method })
      );
    } finally {
      signal?.removeEventListener('abort', cancel);
      cancellation.dispose();
    }
  };
  const notifyMain = (method: string, params: unknown): void => {
    connection.sendNotification(method, params).catch((cause: unknown) => {
      logger.warn('Main did not receive a host notification', { cause, method });
    });
  };
  // ADR-0017: Main supervises the native processes this host starts, and ends their
  // process groups if the host dies. Windows reports none: the host's kill-on-close Job
  // ends them with it.
  if (process.platform !== 'win32') {
    const notify = (method: string, child: NativeChild): void => {
      const failed = (cause: unknown): void =>
        logger.error('Main did not learn of a native process', { cause, method, pid: child.pid });
      try {
        connection.sendNotification(method, child).catch(failed);
      } catch (cause) {
        failed(cause);
      }
    };
    const unobserve = observeNativeChildren({
      exited: (child) => notify('platform/native-child/exited', child),
      started: (child) => notify('platform/native-child/started', child),
    });
    await startup.register(async () => unobserve());
  }
  connection.listen();
  connection.onClose(() => connection.dispose());
  await startup.register(async () => {
    connection.dispose();
    port.close();
  });
  // BST-2202: this host's error records reach Main's diagnostics with their correlation ids.
  const diagnostics = forwardHostDiagnostics((record) =>
    connection.sendRequest(PLATFORM_DIAGNOSTICS_RECORD_METHOD, record)
  );
  await startup.register(() => diagnostics.close());
  // The desktop's one MCP runtime: host-thread MCP tools run here, beside Core.
  // Its servers connect after readiness, so bearer reads wait for a pending
  // legacy import like every other credential use. Its OAuth records live in
  // this host's profile store, which Main never writes.
  const userDataDir = platformOptions?.appPaths?.userDataPath;
  if (!userDataDir) {
    throw new Error('The desktop agent host needs its app paths for MCP settings');
  }
  // ADR-0029 stage 2: the git cluster, over this host's own catalog, ledger and settings.
  const gitWorkspace = createDesktopGitWorkspace({
    homePath: homedir(),
    logger,
    // The ledger authorizes a managed worktree's mount; no picker grant is needed. Main's
    // window is then asked to show it, as for any folder Main opens.
    openWorktreeFolder: async (path) => {
      const root = await folders.roots.addRootByPath(path);
      notifyMain(PLATFORM_FOLDER_OPENED, { path: root.handle.path });
      return { displayName: root.displayName, path: root.handle.path, rootId: root.rootId };
    },
    refreshWorkspaceIndex: (rootId) => workspaceIndex.requestWorkspaceScan(rootId),
    store: startup.store,
    userDataDir,
  });
  await startup.register(() => gitWorkspace.close());
  // ADR-0029 stage 4: the desktop's folders, their one watcher each, and the Explorer's reads.
  const synthetic = platformOptions?.e2e
    ? createE2eSyntheticFiles(platformOptions.e2e.fileSystemFixturePath)
    : undefined;
  const folders = createDesktopWorkspaceRoots({
    lifecycleDelays: agentHostLifecycleDelays,
    managedWorktreeAuthorizer: async (candidate) =>
      (await gitWorkspace.service['worktrees/classify-path']({ path: candidate }, startup.signal))
        .classification,
    // Only the index borrows restored folders, so it exists by the time a restore reports one.
    onRestoredRootsChanged: () => workspaceIndex.rootsChanged(),
    // Main lists a granted folder in the OS recent documents and the File menu.
    onRootGranted: (grantedPath) => notifyMain(PLATFORM_FOLDER_GRANTED, { path: grantedPath }),
    store: startup.store,
    synthetic,
  });
  await startup.register(() => folders.close());
  // The registry lives and dies with this host. A replacement mounts the saved folders before
  // any client asks for one, whatever the index mode, since a surviving window does not restore.
  // The window's own restore still owns the saved preferences, so a read-only store starts too.
  await folders.roots.restoreRoots({ persistPreferences: false });
  // ADR-0029 stage 4: the native search index, over this host's store and folders. Main lends
  // it the index utilities and the embedding renderer.
  let closing = false;
  const workspaceIndex = createDesktopWorkspaceIndex({
    databasePath: path.join(startup.store.root, 'index.sqlite'),
    embedding: {
      destroyAndRestart: async () => {
        wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
          await request(PLATFORM_EMBEDDING_RESTART, {})
        );
      },
      documentEmbeddings: async (payload, options) =>
        wireDecoder(PlatformEmbeddingDocumentsResultSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(await request(PLATFORM_EMBEDDING_DOCUMENTS, { request: payload }, options?.signal)).map(
          (vector) => [...vector]
        ),
    },
    folders,
    forkLentUtility: lending.fork,
    hostedCredentials: {
      readRuntimePreferences: async () =>
        wireDecoder(Schema.NullOr(Schema.String), { errors: 'all', onExcessProperty: 'error' })(
          await request(PLATFORM_RUNTIME_PREFERENCES_READ, {})
        ),
      readSecret: (provider) => host.auth.secrets().getKey(provider),
    },
    isClosing: () => closing || startup.signal.aborted,
    lifecycleDelays: agentHostLifecycleDelaySeam,
    signal: startup.signal,
    store: startup.store,
  });
  await startup.register(() => workspaceIndex.close());
  serveMainRequests(connection, {
    // Main's embedding Stop: the index pauses before the renderer stops.
    embeddingStop: () =>
      workspaceIndex.embeddingStop(async () => {
        wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
          await request(PLATFORM_EMBEDDING_STOP, {})
        );
      }),
    folders,
  });
  // A run's workspace binding borrows this host's own mounted folders.
  const workspace = new DesktopWorkspaceBindingAuthority({
    borrowRoot: (root) =>
      folders.roots.borrowSourceRootForPath(
        root.path,
        folders.watches.subscribe.bind(folders.watches)
      ),
    // BST-1990: names a removed folder in the refusal, whatever its status now.
    readRootNames: async (ids) => {
      const { roots } = await startup.store.workspaceRoots({ operation: 'list' });
      return new Map(
        roots.filter((root) => ids.includes(root.id)).map((root) => [root.id, root.displayName])
      );
    },
    readRoots: () => loadWorkspaceRootsFromCatalog(startup.store),
    readWorktree: (id) => gitWorkspace.readWorktree(id),
  });
  await startup.register(() => workspace.close());
  const files = createDesktopWorkspaceFiles({
    deleteRootData: (rootId) => workspaceIndex.deleteRootData(rootId),
    folders,
    onRootsChanged: () => workspaceIndex.rootsChanged(),
    synthetic,
  });
  // ADR-0029 stage 3: the Terminal panel's terminals and command-session inventory.
  const terminals = createDesktopTerminals({
    commandSessions: hostCommandSessionManager(),
    resolver: createWorkspaceRootResolver(startup.store),
  });
  await startup.register(() => terminals.close());
  // BST-1930 stage e: each run's admission is composed here, from Main's reads and
  // the policy the user saved, which this host keeps in its StateStore.
  const admissionReads = desktopAdmissionReads(request, {
    acquireWorkspace: (borrow) => workspace.acquire(borrow),
    indexStatus: () => workspaceIndex.search.status(),
    liveWorkspaceRoots: () => loadWorkspaceRootsFromCatalog(startup.store),
  });
  const retrieval = {
    indexSearch: workspaceIndex.search,
    store: createCatalogRetrievalStore(startup.store),
  };
  const runAdmission = createDesktopRunAdmission(
    admissionReads,
    async () => {
      const saved = await readHostPermissionPolicy(startup.store);
      return saved ? hostPermissionGate(saved) : undefined;
    },
    (provider) => host.auth.resolveProviderAuth(provider)
  );
  const mcpHost = await createDesktopNodeMcpHost({
    connection,
    credentials: {
      secrets: () => host.auth.secrets(),
      store: () => host.credentials.store(),
    },
    request,
    startup,
    userDataDir,
  });
  await startup.register(() => mcpHost.close());
  return {
    attachThreadReads: (reads) => gitWorkspace.attachThreadReads(reads),
    auth: host.auth,
    // A content clear retires the index and the folders' bookkeeping before the store clears.
    clearRetainedContent: () => workspaceIndex.clearForContent(),
    close: async () => {
      // The MCP runtime joins while Main's platform connection is still open.
      await mcpHost.close();
      // The terminals, language servers, command trees and command sessions this host spawned.
      const reaped = await Promise.allSettled([terminals.close(), disposeHostTools()]);
      const reapFailures = reaped.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : []
      );
      if (reapFailures.length > 0) {
        throw new AggregateError(reapFailures, 'Host process cleanup failed');
      }
      // The git cluster retires before the index it refreshes.
      await gitWorkspace.close();
      // The index, its run bindings and the folders it borrows, while Main still lends the
      // index's utilities and embedding renderer.
      closing = true;
      await workspace.close();
      await workspaceIndex.close();
      await folders.close();
      // Accepted error records are delivered while Main's connection is open.
      const [delivered] = await Promise.allSettled([diagnostics.close()]);
      await request('platform/close', {});
      if (delivered.status === 'rejected') {
        throw delivered.reason;
      }
    },
    confirmMainReady: async () => {
      wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
        await request('platform/ready', {}, startup.signal)
      );
    },
    files,
    forgetThread: (threadId) => forgetSharedNativeToolThread(threadId, readFileCursorRegistry),
    gitWorkspace: gitWorkspace.service,
    index: workspaceIndex.index,
    mcp: mcpHost.services.mcp,
    mcpContent: mcpHost.content,
    mcpPresentation: mcpHost.presentation,
    mcpSettings: mcpHost.settings,
    providers: host.providers,
    readConfiguration: async (admission) => {
      const selected = await runAdmission.readConfiguration(admission);
      admittedRuns.set(admission.runId, {
        ...(admission.workspaceBinding ? { binding: admission.workspaceBinding } : {}),
        selection: selected,
      });
      const configuration = desktopRuntimeConfiguration(selected);
      const provider = configuration.provider;
      let closing: Promise<void> | undefined;
      // Every provider resolves here, in Node.
      const resolveAuth = (selectedProvider: string): Promise<ProviderAuthInput | undefined> => {
        if (closing) {
          throw refusalError(
            'availability',
            'provider.selection-closing',
            'Provider selection is closing.',
            'Retry after selecting a model.'
          );
        }
        return host.auth.resolveProviderAuth(selectedProvider);
      };
      const closeSelection = (): Promise<void> =>
        (closing ??= (async () => {
          if (admittedRuns.get(admission.runId)?.selection === selected) {
            admittedRuns.delete(admission.runId);
          }
          await selected.close();
        })());
      const local = borrowedLocalInference(request, selected);
      let memory: ProductionHostRunConfiguration['memory'];
      try {
        memory = await createDesktopHostMemoryConfiguration(selected, resolveAuth, {
          ...local,
          signal: admission.signal,
        });
      } catch (cause) {
        try {
          await closeSelection();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Memory model admission and cleanup failed');
        }
        throw cause;
      }
      // Every admitted tool runs here; Main executes none of them.
      const tools = desktopHostSharedTools({
        appPaths: platformOptions?.appPaths,
        freshRoots: () => selected.freshWorkspaceRoots(),
        gitWorkspace: gitWorkspace.tools,
        readFileCursorRegistry,
        request,
        resolveTavilyApiKey: host.resolveTavilyApiKey,
        retrieval,
        selected,
        threadId: admission.threadId,
      });
      // Global hooks run as configured; a root's project file runs only at the
      // hash the host trusted it at, and is reported, not run, otherwise.
      const { hooks, skipped } = loadHostRunHooks({
        globalPath: getGlobalHooksPath(),
        maxHookTimeoutMs: selected.toolTimeoutMs,
        // The run's admitted roots, bound or live: the roots its tools use.
        roots: await trustedHookRoots(startup.store, selected.nativeRuntime.workspaceRoots),
        sessionId: admission.threadId,
        // Desktop's own bundled wrapper, as for executeCommand.
        windowsCommandEntry: () =>
          resolveBundledSiblingPath('Windows command', 'windows-command-entry.cjs'),
      });
      return {
        // The shadow-git owner brackets each run's turn for its Changes review.
        // Unsignalled: a stopped run's turn still ends with snapshots. A turn
        // starts on the roots this admission holds, revalidated.
        captureTurnBoundary: async (boundary) =>
          await gitWorkspace.captureTurnBoundary({
            ...boundary,
            roots:
              boundary.boundary === 'turn-start'
                ? (await selected.freshWorkspaceRoots()).map(({ path, rootId }) => ({
                    rootId,
                    rootPath: path,
                  }))
                : turnEndRoots(boundary.roots),
          }),
        childSystem: selected.childSystem,
        close: closeSelection,
        configuration,
        delegation: selected.delegation,
        durableConfiguration: selected.durableConfiguration,
        ...(hooks ? { hooks } : {}),
        // Core commits the hook files this run did not load (`hooks.skipped`).
        hookSkips: skipped,
        referencedFileFailures: selected.referencedFileFailures,
        ...(selected.system === undefined ? {} : { system: selected.system }),
        maxSteps: selected.maxSteps,
        memory,
        providerRequestContext: {
          inputTokenLimit: selected.inputTokenLimit,
          ...(selected.localModel ? { localModel: selected.localModel } : {}),
          provider,
          runtimeData: configuration,
        },
        resolvedToolResultBudget: resolveScaledToolResultBudget(selected.contextWindow),
        resolveProviderAuth: resolveAuth,
        tools,
        toolTimeoutMs: selected.toolTimeoutMs,
      };
    },
    // The admission's preconditions, then the memory credentials, nothing acquired;
    // once they pass, the observer and embedder that admission would use.
    readMemoryPreconditions: async (admission) => {
      const readiness = await runAdmission.readMemoryReadiness(admission);
      if (!readiness.ready) {
        return readiness;
      }
      const preconditions = await desktopMemoryPreconditions(readiness, (provider) =>
        host.auth.resolveProviderAuth(provider)
      );
      return preconditions.ready
        ? { ...preconditions, models: desktopMemoryModels(readiness.memory) }
        : preconditions;
    },
    // The saved policy, else the admitted run's; Core remains the only gate.
    readPermissionPolicy: (threadId) => runAdmission.readPermissionPolicy(threadId),
    // BST-2227: Settings' Test embedder, resolved as a run's admission resolves its embedder.
    resolveMemoryEmbedder: ({ memorySettings, signal }) =>
      resolveDesktopMemoryEmbedderProbe(
        memorySettings,
        admissionReads.memoryVectors,
        (provider) => host.auth.resolveProviderAuth(provider),
        signal
      ),
    resolveProviderAuth: async () => {
      throw refusalError(
        'authorization',
        'provider.not-admitted',
        'Provider access requires an admitted thread selection.',
        'Select a model for this thread and retry.'
      );
    },
    resolveWorkspaceRoot: async ({ rootId }) => {
      const root = (await loadWorkspaceRootsFromCatalog(startup.store)).find(
        (candidate) => candidate.rootId === rootId
      );
      if (!root) {
        throw new Error('The workspace root is no longer mounted');
      }
      return root.path;
    },
    // The shadow-git owner restores a host thread's rewind and its redo.
    rewindFiles: gitWorkspace.rewindFiles,
    searchWorkspace: async (input, signal) => {
      signal.throwIfAborted();
      const result = await workspaceIndex.search.search({
        limit: input.limit,
        mode: input.mode,
        rootIds: [input.rootId],
        text: input.query,
      });
      signal.throwIfAborted();
      return {
        candidateCount: result.candidateCount,
        candidatesTruncated: result.candidatesTruncated,
        hits: result.hits.map((hit) => {
          if (hit.rootId !== input.rootId || !hit.relativePath) {
            throw new Error('Native text search returned a file outside the requested root');
          }
          return {
            chunkId: hit.chunkId,
            content: hit.content,
            endLine: hit.endLine,
            fileId: hit.fileId,
            path: hit.relativePath,
            rootId: hit.rootId,
            score: hit.score,
            startLine: hit.startLine,
          };
        }),
        scanLimited: result.scanLimited,
        storeId: result.storeId,
        truncated: result.truncated,
      };
    },
    selectProjectionRewrites: selectHostProjectionRewrites,
    terminals: terminals.service,
    validateWorkspaceBinding: async ({ binding, runId, signal, threadId }) => {
      // An admission's check revalidates the binding that run itself holds.
      const admitted = runId ? admittedRuns.get(runId) : undefined;
      if (admitted?.selection.revalidateWorkspace && isDeepStrictEqual(admitted.binding, binding)) {
        await admitted.selection.revalidateWorkspace(signal);
        signal.throwIfAborted();
        return;
      }
      await workspace.validateWorkspaceBinding({ binding, signal, threadId });
    },
    // ADR-0029 stage 2: Settings and the "/" menu read these here, not from Main.
    workspaceDiscovery: desktopWorkspaceDiscovery((signal) =>
      admissionReads.liveWorkspaceRoots(signal)
    ),
  };
}
