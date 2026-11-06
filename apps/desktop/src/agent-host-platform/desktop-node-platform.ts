import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ProviderAuthInput, RuntimeData } from '@brainstrike/agent/provider-runtime';
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
  trustedHostWorkspaceRoots,
} from '@brainstrike/agent-host';
import { fromBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { BoundaryFailureError, refusalError } from '@brainstrike/assistant-contract';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { loadWorkspaceRootsFromCatalog } from '@brainstrike/assistant-service/node-workspace-services';
import { createHostCapabilities } from '@brainstrike/host-capabilities';
import {
  createPtyTerminals,
  disposeHostTools,
  hostCommandSessionManager,
} from '@brainstrike/host-capabilities/command-sessions';
import { createGitWorkspace } from '@brainstrike/host-capabilities/git-workspace';
import {
  getGlobalHooksPath,
  loadHostRunHooks,
  trustedHookRoots,
} from '@brainstrike/host-capabilities/hooks';
import { createDesktopNodeMcpHost } from '@brainstrike/host-capabilities/mcp/desktop-node-mcp';
import {
  evictLspServersForRoot,
  forgetSharedNativeToolThread,
  ReadWorkspaceFileCursorRegistry,
  selectHostProjectionRewrites,
} from '@brainstrike/host-capabilities/native-tools';
import { createProviderCredentialReader } from '@brainstrike/host-capabilities/provider-credentials';
import { hostWorkspaceDiscovery } from '@brainstrike/host-capabilities/workspace-context';
import {
  createHostFileReads,
  createHostFileSearch,
  createHostFileWatches,
  createWorkspaceRootPins,
} from '@brainstrike/host-capabilities/workspace-files';
import { createHostRootRegistry } from '@brainstrike/host-capabilities/workspace-roots';
import { createLogger } from '@brainstrike/logging';
import { type NativeChild, observeNativeChildren } from '@brainstrike/state-store/native-children';
import { Schema } from 'effect';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';
import { isElectronE2ETestMode } from '../electron-e2e-test-mode';
import { mainPlatformConnection } from './connection';
import { desktopChildConfiguration } from './desktop-child-configuration';
import { desktopHostSharedTools } from './desktop-host-shared-tools';
import {
  createDesktopRunAdmission,
  type DesktopAdmissionReads,
  type DesktopRunSelection,
} from './desktop-run-admission';
import { DesktopWorkspaceBindingAuthority } from './desktop-workspace-binding';
import { desktopManagedWorktreeDirectory } from './desktop-worktree-directory';
import { forwardHostDiagnostics } from './host-diagnostics';
import { lentCredentialCipher } from './lent-credential-cipher';
import {
  createDesktopHostMemoryConfiguration,
  desktopMemoryModels,
} from './memory-model-configuration';
import { desktopMemoryPreconditions } from './memory-readiness';
import { parentPlatformPort } from './parent-platform-port';
import {
  PLATFORM_DIAGNOSTICS_RECORD_METHOD,
  PlatformCatalogModelResultSchema,
  PlatformObserverCandidatesResultSchema,
  PlatformPickFolderResultSchema,
} from './platform-wire';

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
/** A host service's answer as its caller's value; its typed failure continues to that caller. */
function settled<T>(result: BoundaryResult<T>): T {
  if (!result.ok) {
    throw new BoundaryFailureError(result.error);
  }
  return result.value;
}
type PlatformRequest = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
/**
 * BST-1930 stage e: Main's facts, read over the private connection for the
 * host's run admission. The workspace borrow is this host's own (ADR-0029 stage 4).
 */
function mainAdmissionReads(
  request: PlatformRequest
): Omit<DesktopAdmissionReads, 'acquireWorkspace'> {
  return {
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
    liveWorkspaceRoots: async (signal) =>
      Schema.decodeUnknownSync(CliWorkspaceRootsSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/admission/roots', {}, signal)),
  };
}
interface DesktopHostConfiguration extends Omit<ProductionHostPlatformOptions, 'startup'> {
  confirmMainReady(): Promise<void>;
}
export async function createDesktopHostConfiguration(
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<DesktopHostConfiguration> {
  const port = await parentPlatformPort();
  const connection = mainPlatformConnection(port);
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
  // The profile's one credential authority: the single writer and token holder.
  // ADR-0029: its sealed file borrows Main's safeStorage for every value.
  const host = await createHostCapabilities({
    credentialCipher: lentCredentialCipher(request),
    env: process.env,
    launch: platformOptions,
    startup,
  });
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
  // ADR-0029 stage 4: the workspace's open folders. The registry writes their records and the
  // recent-folders ledger; Main keeps only the picker.
  const rootRegistry = createHostRootRegistry({
    disposeCommandSessionsForRoot: (rootId) => hostCommandSessionManager().disposeRoot(rootId),
    e2e: isElectronE2ETestMode(),
    evictLspServersForRoot,
    managedWorktreeAuthorizer: async (candidate) =>
      (await gitWorkspace.service['worktrees/classify-path']({ path: candidate }, startup.signal))
        .classification,
    pickFolder: async () => {
      const picked = wireDecoder(PlatformPickFolderResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/workspace/pick-folder', {}));
      return 'path' in picked ? picked.path : null;
    },
    publishRootsChanged: async (change) => {
      wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
        await request('platform/workspace/roots-changed', change)
      );
    },
    store: startup.store,
  });
  await startup.register(() => rootRegistry.close());
  // ADR-0029 stage 2: the git cluster, over this host's own catalog, ledger and settings.
  const roots = rootRegistry.roots;
  const gitWorkspace = createGitWorkspace({
    logger,
    managedWorktreeDirectory: desktopManagedWorktreeDirectory({
      e2e: isElectronE2ETestMode(),
      env: process.env,
      homeDirectory: homedir(),
    }),
    // The ledger authorizes a managed worktree's mount; the focused window is then asked to show it.
    openWorktreeFolder: async (folder) => {
      const root = await rootRegistry.service['workspace/roots/add']({ path: folder });
      wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
        await request('platform/workspace/show-folder', { path: root.path })
      );
      return {
        displayName: path.basename(root.path) || root.path,
        path: root.path,
        rootId: root.rootId,
      };
    },
    roots,
    // The shadow-git snapshot backbone, under `userData/snapshots/<rootId>/git`;
    // the factory reset's userData wipe covers it.
    snapshotsBaseDir: path.join(userDataDir, 'snapshots'),
    store: startup.store,
  });
  await startup.register(() => gitWorkspace.close());
  // The open folders mount before any client reads the catalog's live roots.
  await rootRegistry.start();
  // A run's workspace borrow holds the registry's mounts; removing a folder ends it.
  const workspace = new DesktopWorkspaceBindingAuthority({
    borrowRoot: (root) => rootRegistry.registry.borrowSourceRootForPath(root.path),
    readLiveWorktreePath: async (id) =>
      settled(await gitWorkspace.service['worktrees/managed-paths']({}, startup.signal)).find(
        (worktree) => worktree.id === id
      )?.path ?? null,
    // BST-1990: names a removed folder in the refusal, whatever its status now.
    readRootNames: async (ids) => {
      const { roots: records } = await startup.store.workspaceRoots({ operation: 'list' });
      return new Map(
        records.filter((root) => ids.includes(root.id)).map((root) => [root.id, root.displayName])
      );
    },
    readRoots: () => loadWorkspaceRootsFromCatalog(startup.store),
  });
  await startup.register(() => workspace.close());
  // ADR-0029 stage 3: the Terminal panel's terminals and command-session inventory.
  const terminals = createPtyTerminals({
    commandSessions: hostCommandSessionManager(),
    resolver: roots,
  });
  await startup.register(() => terminals.close());
  // ADR-0029 stage 4: the Explorer's reads of, and root watches on, live workspace roots,
  // borrowing the root registry's one pinned handle per folder, which it closes after them.
  // ADR-0035: its Search tab borrows the same handles for the length of one search, which
  // the connection's retirement cancels.
  const rootPins = createWorkspaceRootPins({ mounts: rootRegistry.registry });
  const fileReads = createHostFileReads({ pins: rootPins });
  const fileSearch = createHostFileSearch({ pins: rootPins });
  const fileWatches = createHostFileWatches({ pins: rootPins });
  const closeWorkspaceFiles = async (): Promise<void> => {
    const owners = await Promise.allSettled([fileReads.close(), fileWatches.close()]);
    await rootPins.close();
    const failures = owners.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Workspace file reads or watches did not stop');
    }
  };
  await startup.register(closeWorkspaceFiles);
  // BST-1930 stage e: each run's admission is composed here, from Main's reads and
  // the policy the user saved, which this host keeps in its StateStore.
  const admissionReads: DesktopAdmissionReads = {
    ...mainAdmissionReads(request),
    acquireWorkspace: (binding) => workspace.acquire(binding),
  };
  const runAdmission = createDesktopRunAdmission(
    admissionReads,
    async () => {
      const saved = await readHostPermissionPolicy(startup.store);
      return saved ? hostPermissionGate(saved) : undefined;
    },
    // ADR-0032: the roots whose instructions, skills and personas a run may load.
    (roots) => trustedHostWorkspaceRoots(startup.store, roots)
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
    attachThreadReads: (reads) => {
      gitWorkspace.attachThreadReads(reads);
      rootRegistry.attachThreadReads(reads);
    },
    auth: host.auth,
    childConfiguration: desktopChildConfiguration,
    close: async () => {
      // Runs' workspace borrows end, then admitted folder changes finish while the store is open.
      await workspace.close();
      await rootRegistry.prepareClose();
      // The MCP runtime joins while Main's platform connection is still open.
      await mcpHost.close();
      // The terminals, Explorer reads and root watches, language servers, command trees and
      // command sessions this host started.
      const reaped = await Promise.allSettled([
        terminals.close(),
        closeWorkspaceFiles(),
        disposeHostTools(),
      ]);
      const reapFailures = reaped.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : []
      );
      if (reapFailures.length > 0) {
        throw new AggregateError(reapFailures, 'Host process cleanup failed');
      }
      await rootRegistry.close();
      // The git cluster retires while Main can still refresh a rewound root's index.
      await gitWorkspace.close();
      // Accepted error records are delivered while Main's connection is open.
      const [delivered] = await Promise.allSettled([diagnostics.close()]);
      await request('platform/close', {});
      if (delivered.status === 'rejected') {
        throw delivered.reason;
      }
    },
    commandSessionExits: { subscribe: (listener) => hostCommandSessionManager().onExit(listener) },
    confirmMainReady: async () => {
      wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
        await request('platform/ready', {}, startup.signal)
      );
    },
    fileReads: fileReads.service,
    fileSearch,
    fileWatches: fileWatches.service,
    forgetThread: (threadId) => forgetSharedNativeToolThread(threadId, readFileCursorRegistry),
    gitWorkspace: gitWorkspace.service,
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
      let memory: ProductionHostRunConfiguration['memory'];
      try {
        memory = await createDesktopHostMemoryConfiguration(selected, resolveAuth);
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
        readPromptContext: selected.readPromptContext,
        referencedFileFailures: selected.referencedFileFailures,
        ...(selected.system === undefined ? {} : { system: selected.system }),
        maxSteps: selected.maxSteps,
        memory,
        providerRequestContext: {
          inputTokenLimit: selected.inputTokenLimit,
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
    // once they pass, the observer that admission would use.
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
    resolveProviderAuth: async () => {
      throw refusalError(
        'authorization',
        'provider.not-admitted',
        'Provider access requires an admitted thread selection.',
        'Select a model for this thread and retry.'
      );
    },
    resolveWorkspaceRoot: async ({ rootId, signal }) =>
      wireDecoder(Schema.String.check(Schema.isMinCodePoints(1)), {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/workspace/root', { rootId }, signal)),
    // The shadow-git owner restores a host thread's rewind and its redo.
    rewindFiles: gitWorkspace.rewindFiles,
    rootRegistry: rootRegistry.service,
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
    workspaceDiscovery: hostWorkspaceDiscovery({
      // Settings' persona checks read Main's model catalog, this host's MCP tools and its store.
      personaAvailability: {
        catalogModel: async (target, signal) => await admissionReads.catalogModel(target, signal),
        mcpTools: async () =>
          new Map(
            Object.values(await mcpHost.settings.tools())
              .flat()
              .map((tool) => [tool.id, tool.enabled])
          ),
        readCredential: createProviderCredentialReader(
          { getCredential: (provider) => host.auth.secrets().getCredential(provider) },
          process.env
        ),
      },
      roots: (signal) => admissionReads.liveWorkspaceRoots(signal),
      trust: startup.store,
    }),
  };
}
