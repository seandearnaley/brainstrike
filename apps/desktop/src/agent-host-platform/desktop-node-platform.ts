import { randomUUID } from 'node:crypto';
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
  hostPermissionGate,
  type ProductionHostPlatformOptions,
  type ProductionHostRunConfiguration,
  readHostPermissionPolicy,
} from '@brainstrike/agent-host';
import { fromBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
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
import { mainPlatformConnection } from './connection';
import { desktopHostSharedTools } from './desktop-host-shared-tools';
import {
  createDesktopRunAdmission,
  type DesktopAdmissionReads,
  type DesktopRunSelection,
} from './desktop-run-admission';
import { mainQueryEmbedding } from './host-retrieval-clients';
import { disposeHostTools, serveHostCommandSessions } from './host-tool-process';
import { createDesktopHostMemoryConfiguration } from './memory-model-configuration';
import { desktopMemoryPreconditions } from './memory-readiness';
import { parentPlatformPort } from './parent-platform-port';
import {
  PlatformCatalogModelResultSchema,
  PlatformMemoryVectorsResultSchema,
  PlatformObserverCandidatesResultSchema,
  PlatformRewindConflictsSchema,
  PlatformRewindOutcomesSchema,
  PlatformRewindPreviewResultSchema,
  PlatformTurnSnapshotResultSchema,
  PlatformWorkspaceAcquireResultSchema,
} from './platform-wire';
import { IndexSearchResultSchema } from './retrieval-wire';

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
export type PlatformRequest = (
  method: string,
  input: unknown,
  signal?: AbortSignal
) => Promise<unknown>;
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
export function borrowedLocalInference(
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
 * BST-1930 stage e: Main's facts, read over the private connection for the
 * host's run admission. A workspace borrow is Main's until the host releases
 * the lease it named.
 */
export function mainAdmissionReads(request: PlatformRequest): DesktopAdmissionReads {
  return {
    acquireWorkspace: async ({ binding, signal, threadId }) => {
      const leaseId = randomUUID();
      const { roots } = Schema.decodeUnknownSync(PlatformWorkspaceAcquireResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(
        await request(
          'platform/admission/workspace/acquire',
          { binding, leaseId, threadId },
          signal
        )
      );
      let closing: Promise<void> | undefined;
      return {
        close: () =>
          (closing ??= request('platform/admission/workspace/release', { leaseId }).then(
            () => undefined
          )),
        revalidate: async (revalidation) => {
          await request('platform/admission/workspace/revalidate', { leaseId }, revalidation);
        },
        roots,
      };
    },
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
    memoryVectors: async (settings, signal) => {
      const resolved = Schema.decodeUnknownSync(PlatformMemoryVectorsResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/admission/memory-vectors', { settings }, signal));
      return resolved
        ? { profile: resolved.profile, ...(resolved.local ? { local: resolved.local } : {}) }
        : undefined;
    },
    worktreesAvailable: async (signal) =>
      wireDecoder(Schema.Boolean, { errors: 'all', onExcessProperty: 'error' })(
        await request('platform/admission/worktrees', {}, signal)
      ),
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
  const connection = mainPlatformConnection(port);
  // The profile's one credential authority: the single writer, token holder and
  // OAuth refresher. Sign-in pages open through the requesting desktop client.
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
  serveHostCommandSessions(connection);
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
  // The desktop's one MCP runtime: host-thread MCP tools run here, beside Core.
  // Its servers connect after readiness, so bearer reads wait for a pending
  // legacy import like every other credential use. Its OAuth records live in
  // this host's profile store, which Main never writes.
  const userDataDir = platformOptions?.appPaths?.userDataPath;
  if (!userDataDir) {
    throw new Error('The desktop agent host needs its app paths for MCP settings');
  }
  // BST-1930 stage e: each run's admission is composed here, from Main's reads and
  // the policy the user saved, which this host keeps in its StateStore.
  const runAdmission = createDesktopRunAdmission(mainAdmissionReads(request), async () => {
    const saved = await readHostPermissionPolicy(startup.store);
    return saved ? hostPermissionGate(saved) : undefined;
  });
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
    auth: host.auth,
    close: async () => {
      // The MCP runtime joins while Main's platform connection is still open.
      await mcpHost.close();
      // The language servers, command trees and command sessions this host spawned.
      await disposeHostTools();
      await request('platform/close', {});
    },
    confirmMainReady: async () => {
      wireDecoder(Schema.Null, { errors: 'all', onExcessProperty: 'error' })(
        await request('platform/ready', {}, startup.signal)
      );
    },
    forgetThread: (threadId) => forgetSharedNativeToolThread(threadId, readFileCursorRegistry),
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
      // Every provider resolves here, in Node, for this admission's client origin:
      // subscription auth refuses anything but the private desktop client
      // (signed legal gate, constraint 4), including restart recovery.
      const resolveAuth = (selectedProvider: string): Promise<ProviderAuthInput | undefined> => {
        if (closing) {
          throw refusalError(
            'availability',
            'provider.selection-closing',
            'Provider selection is closing.',
            'Retry after selecting a model.'
          );
        }
        return host.auth.resolveProviderAuth(selectedProvider, admission.origin);
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
      });
      return {
        // Main's shadow-git owner brackets each run's turn for its Changes
        // review. Unsignalled: a stopped run's turn still ends with snapshots.
        // A turn starts on the roots this admission holds, revalidated.
        captureTurnBoundary: async (boundary) =>
          Schema.decodeUnknownSync(PlatformTurnSnapshotResultSchema, {
            errors: 'all',
            onExcessProperty: 'error',
          })(
            await request(
              'platform/snapshot/capture',
              boundary.boundary === 'turn-start'
                ? {
                    ...boundary,
                    roots: (await selected.freshWorkspaceRoots()).map(({ path, rootId }) => ({
                      rootId,
                      rootPath: path,
                    })),
                  }
                : boundary
            )
          ),
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
          provider,
          runtimeData: configuration,
        },
        resolvedToolResultBudget: resolveScaledToolResultBudget(selected.contextWindow),
        resolveProviderAuth: resolveAuth,
        tools,
        toolTimeoutMs: selected.toolTimeoutMs,
      };
    },
    // The admission's preconditions, then the memory credentials, nothing acquired.
    readMemoryPreconditions: async (admission) => {
      const readiness = await runAdmission.readMemoryReadiness(admission);
      return readiness.ready
        ? await desktopMemoryPreconditions(readiness, (provider) =>
            host.auth.resolveProviderAuth(provider, admission.origin)
          )
        : readiness;
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
    // Main's shadow-git owner restores a host thread's rewind and its redo.
    rewindFiles: {
      apply: async (input) =>
        Schema.decodeUnknownSync(PlatformRewindOutcomesSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(await request('platform/rewind/apply', input)),
      drift: async (input) =>
        Schema.decodeUnknownSync(PlatformRewindConflictsSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(await request('platform/rewind/drift', input)),
      preview: async (input) =>
        Schema.decodeUnknownSync(PlatformRewindPreviewResultSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(await request('platform/rewind/preview', input)),
      redo: async (input) =>
        Schema.decodeUnknownSync(PlatformRewindOutcomesSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(await request('platform/rewind/redo', input)),
      redoConflicts: async (input) =>
        Schema.decodeUnknownSync(PlatformRewindConflictsSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(await request('platform/rewind/redo-conflicts', input)),
    },
    searchWorkspace: async (input, signal) => {
      const result = Schema.decodeUnknownSync(IndexSearchResultSchema, {
        errors: 'all',
        onExcessProperty: 'ignore',
      })(
        await request(
          'desktop-read/index/search',
          {
            request: {
              limit: input.limit,
              mode: input.mode,
              rootIds: [input.rootId],
              text: input.query,
            },
            threadId: input.threadId,
          },
          signal
        )
      );
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
    validateWorkspaceBinding: async ({ binding, runId, signal, threadId }) => {
      // An admission's check revalidates the binding that run itself holds.
      const admitted = runId ? admittedRuns.get(runId) : undefined;
      if (admitted?.selection.revalidateWorkspace && isDeepStrictEqual(admitted.binding, binding)) {
        await admitted.selection.revalidateWorkspace(signal);
        signal.throwIfAborted();
        return;
      }
      wireDecoder(Schema.Struct({ accepted: Schema.Literal(true) }), {
        errors: 'all',
        onExcessProperty: 'error',
      })(await request('platform/workspace/validate', { binding, threadId }, signal));
    },
  };
}
