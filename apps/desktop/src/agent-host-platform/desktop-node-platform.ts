import type {
  LocalEmbeddingHostClient,
  LocalLlmHostClient,
  ProviderAuthInput,
  RuntimeData,
} from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  createProductionHostPlatform,
  type HostPlatform,
  type HostPlatformLaunchOptions,
  type HostStartupContext,
  type ProductionHostRunConfiguration,
} from '@brainstrike/agent-host';
import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import { createHostCapabilities } from '@brainstrike/host-capabilities';
import { createHostRunHooks, getGlobalHooksPath } from '@brainstrike/host-capabilities/hooks';
import { createDesktopNodeMcpHost } from '@brainstrike/host-capabilities/mcp/desktop-node-mcp';
import {
  forgetSharedNativeToolThread,
  ReadWorkspaceFileCursorRegistry,
  selectHostProjectionRewrites,
} from '@brainstrike/host-capabilities/native-tools';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { mainPlatformConnection } from './connection';
import { desktopHostSharedTools } from './desktop-host-shared-tools';
import { disposeHostTools, serveHostCommandSessions } from './host-tool-process';
import { createRemoteLlmHostClient } from './llm-host-port';
import { createDesktopHostMemoryConfiguration } from './memory-model-configuration';
import { parentPlatformPort } from './parent-platform-port';
import {
  PlatformLocalEmbeddingResultSchema,
  PlatformLocalGenerationResultSchema,
  PlatformPolicySchema,
  PlatformSelectionSchema,
} from './platform-wire';

type PlatformSelection = z.output<typeof PlatformSelectionSchema>;

async function parsePlatformSelection(
  response: unknown,
  release: () => Promise<unknown>
): Promise<PlatformSelection> {
  try {
    return PlatformSelectionSchema.parse(response);
  } catch (cause) {
    try {
      await release();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Platform response and cleanup failed');
    }
    throw cause;
  }
}
function desktopRuntimeConfiguration(
  selected: PlatformSelection
): RuntimeData & { readonly provider: SupportedProvider } {
  const provider = selected.configuration.provider;
  if (!isSupportedProvider(provider)) {
    throw new Error('Desktop selected an unsupported provider');
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

type PlatformRequest = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

/**
 * ADR-0007: Node never runs local inference. A thread's admitted local observer
 * and recall embedder borrow Main's hidden hosts; JSON-RPC cancellation carries
 * the caller's signal.
 */
function borrowedLocalInference(
  request: PlatformRequest,
  threadId: string
): { readonly embedding: LocalEmbeddingHostClient; readonly llm: LocalLlmHostClient } {
  return {
    embedding: {
      queryEmbedding: async ({ query }, options) =>
        PlatformLocalEmbeddingResultSchema.parse(
          await request('platform/embedding/query', { query, threadId }, options?.signal)
        ).embedding,
    },
    llm: {
      generate: async (generation, options) =>
        PlatformLocalGenerationResultSchema.parse(
          await request('platform/llm/generate', { ...generation, threadId }, options?.signal)
        ),
      warmup: async (modelId, options) => {
        await request('platform/llm/warmup', { modelId, threadId }, options?.signal);
      },
    },
  };
}

/** Electron-free production entry: Node owns the model loop, Memory and committed log. */
export async function createHostPlatform(
  _options: HostStartOptions,
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<HostPlatform> {
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
  const request: PlatformRequest = async (method, input, signal) => {
    signal?.throwIfAborted();
    const cancellation = new CancellationTokenSource();
    const cancel = (): void => cancellation.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await connection.sendRequest(method, input, cancellation.token);
    } finally {
      signal?.removeEventListener('abort', cancel);
      cancellation.dispose();
    }
  };
  serveHostCommandSessions(connection);
  // ADR-0007: the built-in local model's inference stays in Main's hidden
  // llm-host renderer; this host only relays each generation to it.
  const localLlmHostClient = createRemoteLlmHostClient(connection);
  connection.listen();
  connection.onClose(() => connection.dispose());
  await startup.register(async () => {
    connection.dispose();
    port.close();
  });
  // The desktop's one MCP runtime: host-thread MCP tools run here, beside Core.
  // Its servers connect after readiness, so bearer reads wait for a pending
  // legacy import like every other credential use.
  const mcpHost = await createDesktopNodeMcpHost(connection, request, startup, () =>
    host.auth.secrets()
  );
  await startup.register(() => mcpHost.close());
  return createProductionHostPlatform({
    auth: host.auth,
    close: async () => {
      // MCP cleanup still writes through Main's stores, so it joins before Main closes.
      await mcpHost.close();
      // The language servers, command trees and command sessions this host spawned.
      await disposeHostTools();
      await request('platform/close', {});
    },
    forgetThread: (threadId) => forgetSharedNativeToolThread(threadId, readFileCursorRegistry),
    localLlmHostClient,
    mcp: mcpHost.services.mcp,
    // Main admits every desktop run under the workspace memory resource.
    memoryResourceIds: [WORKSPACE_MEMORY_RESOURCE_ID],
    providers: host.providers,
    readConfiguration: async (admission) => {
      const response = await request(
        'platform/admit',
        {
          ...(admission.configuration ? { configuration: admission.configuration } : {}),
          ...(admission.snapshot ? { snapshot: admission.snapshot } : {}),
          ...(admission.workspaceBinding ? { workspaceBinding: admission.workspaceBinding } : {}),
          modelId: admission.modelId,
          ...(admission.planMode ? { planMode: true } : {}),
          ...(admission.prompt === undefined ? {} : { prompt: admission.prompt }),
          threadId: admission.threadId,
        },
        admission.signal
      );
      const selected = await parsePlatformSelection(response, () =>
        request('platform/release', { threadId: admission.threadId })
      );
      const configuration = desktopRuntimeConfiguration(selected);
      const provider = configuration.provider;
      let closing: Promise<void> | undefined;
      // Every provider resolves here, in Node, for this admission's client origin:
      // subscription auth refuses anything but the private desktop client
      // (signed legal gate, constraint 4), including restart recovery.
      const resolveAuth = (selectedProvider: string): Promise<ProviderAuthInput | undefined> => {
        if (closing) {
          throw new Error('Provider selection is closing');
        }
        return host.auth.resolveProviderAuth(selectedProvider, admission.origin);
      };
      const closeSelection = (): Promise<void> =>
        (closing ??= request('platform/release', { threadId: admission.threadId }).then(
          () => undefined
        ));
      let memory: ProductionHostRunConfiguration['memory'];
      try {
        memory = await createDesktopHostMemoryConfiguration(selected, resolveAuth, {
          ...borrowedLocalInference(request, admission.threadId),
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
        readFileCursorRegistry,
        request,
        resolveTavilyApiKey: host.resolveTavilyApiKey,
        selected,
        threadId: admission.threadId,
      });
      // Global hooks run as configured; a root's project file stays untrusted
      // (and is reported, not run) until the host owns its approval.
      const hooks = createHostRunHooks({
        globalPath: getGlobalHooksPath(),
        maxHookTimeoutMs: selected.toolTimeoutMs,
        roots: (selected.workspace?.roots ?? []).map((root) => ({
          absPath: root.path,
          rootId: root.rootId,
        })),
        sessionId: admission.threadId,
      });
      return {
        close: closeSelection,
        configuration,
        durableConfiguration: selected.durableConfiguration,
        ...(hooks ? { hooks } : {}),
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
    // Main supplies the existing policy owner; Core remains the only gate.
    readPermissionPolicy: async (threadId) => {
      const policy = PlatformPolicySchema.parse(
        await request('platform/policy', { ...(threadId ? { threadId } : {}) })
      );
      return {
        policies: policy.policies,
        yolo: policy.yolo,
        ...(policy.perToolOverrides ? { perToolOverrides: policy.perToolOverrides } : {}),
        ...(policy.sessionGrants ? { sessionGrants: policy.sessionGrants } : {}),
      };
    },
    resolveProviderAuth: async () => {
      throw new Error('Desktop provider auth requires an admitted thread selection');
    },
    resolveWorkspaceRoot: async ({ rootId, signal }) =>
      z
        .string()
        .min(1)
        .parse(await request('platform/workspace/root', { rootId }, signal)),
    selectProjectionRewrites: selectHostProjectionRewrites,
    startup,
    validateWorkspaceBinding: async ({ binding, signal, threadId }) => {
      z.strictObject({ accepted: z.literal(true) }).parse(
        await request('platform/workspace/validate', { binding, threadId }, signal)
      );
    },
  });
}
