import type { ProviderAuthInput, RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  canonicalToolModelOutput,
  createProductionHostPlatform,
  type HostPlatform,
  type HostPlatformLaunchOptions,
  type HostStartupContext,
  type HostTool,
  type HostToolContext,
  type ProductionHostRunConfiguration,
  platformToolInputSchema,
} from '@brainstrike/agent-host';
import { findProviderDefinition, type SupportedProvider } from '@brainstrike/assistant-contract';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { createHostCapabilities } from '@brainstrike/host-capabilities';
import {
  forgetSharedNativeToolThread,
  ReadWorkspaceFileCursorRegistry,
} from '@brainstrike/host-capabilities/native-tools';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { mainPlatformConnection } from './connection';
import { desktopHostSharedTools } from './desktop-host-shared-tools';
import { createDesktopNodeMcpHost } from './desktop-node-mcp';
import { createDesktopHostMemoryConfiguration } from './memory-model-configuration';
import { parentPlatformPort } from './parent-platform-port';
import { decodePlatformAuth } from './platform-auth';
import {
  PlatformPolicySchema,
  PlatformProgressSchema,
  PlatformSelectionSchema,
} from './platform-wire';
import { createProviderFetchTransport } from './provider-fetch-transport';

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

/** Electron-free production entry: Node owns the model loop, Memory and committed log. */
export async function createHostPlatform(
  _options: HostStartOptions,
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<HostPlatform> {
  // Provider credentials resolve here, in Node, from the profile store Main's
  // Settings writes. Only subscription OAuth still borrows Main's engine.
  const host = await createHostCapabilities({
    env: process.env,
    launch: platformOptions,
    startup,
  });
  const port = await parentPlatformPort();
  const connection = mainPlatformConnection(port);
  const executions = new Map<string, HostToolContext & { readonly toolId: string }>();
  // One host-lifetime registry; its handles are scoped to their thread.
  const readFileCursorRegistry = new ReadWorkspaceFileCursorRegistry();
  const request = async (
    method: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown> => {
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
  connection.onRequest('platform/progress', async (input: unknown) => {
    const progress = PlatformProgressSchema.parse(input);
    const context = executions.get(JSON.stringify([progress.runId, progress.toolCallId]));
    if (!context || context.threadId !== progress.threadId) {
      throw new Error('Platform progress has no admitted execution');
    }
    await context.write?.(progress.chunk);
  });
  connection.listen();
  connection.onClose(() => connection.dispose());
  await startup.register(async () => {
    connection.dispose();
    port.close();
  });
  // The desktop's one MCP runtime: host-thread MCP tools run here, beside Core.
  const mcpHost = await createDesktopNodeMcpHost(connection, request, startup);
  await startup.register(() => mcpHost.close());
  return createProductionHostPlatform({
    close: async () => {
      // MCP cleanup still writes through Main's stores, so it joins before Main closes.
      await mcpHost.close();
      await request('platform/close', {});
    },
    forgetThread: (threadId) => forgetSharedNativeToolThread(threadId, readFileCursorRegistry),
    mcp: mcpHost.services.mcp,
    readConfiguration: async (admission) => {
      const response = await request(
        'platform/admit',
        {
          ...(admission.configuration ? { configuration: admission.configuration } : {}),
          ...(admission.snapshot ? { snapshot: admission.snapshot } : {}),
          ...(admission.workspaceBinding ? { workspaceBinding: admission.workspaceBinding } : {}),
          modelId: admission.modelId,
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
      const fetchScopes = new Map<string, ReturnType<typeof createProviderFetchTransport>>();
      let closing: Promise<void> | undefined;
      const resolveAuth = async (
        selectedProvider: string
      ): Promise<ProviderAuthInput | undefined> => {
        if (closing) {
          throw new Error('Private provider selection is closing');
        }
        if (findProviderDefinition(selectedProvider)?.authType !== 'oauth_subscription') {
          return await host.resolveProviderAuth(selectedProvider);
        }
        // Signed legal gate, constraint 4: subscription auth only for a run a
        // visible desktop client admitted. CLI and other socket clients, and
        // restart recovery with no live client, fail closed.
        if (admission.origin !== 'desktop-ui') {
          throw new Error(
            'The ChatGPT subscription provider is available only to runs started from an interactive desktop window.'
          );
        }
        const response = await request(
          'platform/auth',
          { provider: selectedProvider, threadId: admission.threadId },
          admission.signal
        );
        if (closing) {
          throw new Error('Private provider selection closed during auth lookup');
        }
        let captured = fetchScopes.get(selectedProvider);
        if (!captured) {
          captured = createProviderFetchTransport(connection, {
            provider: selectedProvider,
            threadId: admission.threadId,
          });
          fetchScopes.set(selectedProvider, captured);
        }
        return decodePlatformAuth(response, captured.fetch);
      };
      const closeSelection = (): Promise<void> =>
        (closing ??= (async () => {
          const results = await Promise.allSettled(
            [...fetchScopes.values()].map((captured) => captured.close())
          );
          const failures = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          );
          try {
            await request('platform/release', { threadId: admission.threadId });
          } catch (cause) {
            failures.push(cause);
          }
          if (failures.length > 0) {
            if (failures.length === 1) {
              throw failures[0];
            }
            throw new AggregateError(failures, 'Private provider selection cleanup failed');
          }
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
      const shared = desktopHostSharedTools({
        readFileCursorRegistry,
        request,
        selected,
        threadId: admission.threadId,
      });
      const tools = Object.fromEntries(
        Object.entries(selected.tools)
          .filter(([name]) => !Object.hasOwn(shared, name))
          .map(([name, descriptor]) => [
            name,
            {
              description: descriptor.description,
              identity: descriptor.identity,
              ...(descriptor.interaction
                ? {
                    interaction: {
                      kind: descriptor.interaction.kind,
                      resumeSchema: platformToolInputSchema(
                        descriptor.interaction.resumeSchema,
                        async (input) =>
                          z
                            .discriminatedUnion('success', [
                              z.strictObject({ success: z.literal(true), value: z.json() }),
                              z.strictObject({ error: z.string(), success: z.literal(false) }),
                            ])
                            .parse(
                              await request(
                                'platform/validate',
                                {
                                  input: z.json().parse(input),
                                  resume: true,
                                  threadId: admission.threadId,
                                  toolId: name,
                                },
                                admission.signal
                              )
                            )
                      ),
                    },
                  }
                : {}),
              permissionToolId: descriptor.permissionToolId,
              risk: descriptor.risk,
              ...(descriptor.strict === undefined ? {} : { strict: descriptor.strict }),
              execute: async (input: unknown, context: HostToolContext): Promise<unknown> => {
                const address = JSON.stringify([context.runId, context.toolCallId]);
                if (executions.has(address)) {
                  throw new Error('Platform tool call is already executing');
                }
                executions.set(address, { ...context, toolId: name });
                try {
                  return await request(
                    'platform/execute',
                    {
                      input: z.json().parse(input),
                      ...(context.resumeData === undefined
                        ? {}
                        : { resumeData: z.json().parse(context.resumeData) }),
                      runId: context.runId,
                      threadId: context.threadId,
                      toolCallId: context.toolCallId,
                      toolId: name,
                    },
                    context.signal
                  );
                } finally {
                  executions.delete(address);
                }
              },
              inputSchema: platformToolInputSchema(descriptor.inputSchema, async (input) =>
                z
                  .discriminatedUnion('success', [
                    z.strictObject({ success: z.literal(true), value: z.json() }),
                    z.strictObject({ error: z.string(), success: z.literal(false) }),
                  ])
                  .parse(
                    await request(
                      'platform/validate',
                      { input: z.json().parse(input), threadId: admission.threadId, toolId: name },
                      admission.signal
                    )
                  )
              ),
              toModelOutput: async ({
                input,
                output,
                toolCallId,
              }: Parameters<NonNullable<HostTool['toModelOutput']>>[0]) => {
                const projected = await request('platform/project', {
                  input: z.json().parse(input),
                  output: z.json().parse(output),
                  threadId: admission.threadId,
                  toolCallId,
                  toolId: name,
                });
                return projected === undefined || projected === null
                  ? { type: 'json' as const, value: z.json().parse(output) }
                  : canonicalToolModelOutput(projected, toolCallId, name);
              },
            },
          ])
      );
      Object.assign(tools, shared);
      return {
        close: closeSelection,
        configuration,
        durableConfiguration: selected.durableConfiguration,
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
    startup,
    storeProviderCredential: host.storeProviderCredential,
    validateWorkspaceBinding: async ({ binding, signal, threadId }) => {
      z.strictObject({ accepted: z.literal(true) }).parse(
        await request('platform/workspace/validate', { binding, threadId }, signal)
      );
    },
  });
}
