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
import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { createHostCapabilities } from '@brainstrike/host-capabilities';
import { createDesktopNodeMcpHost } from '@brainstrike/host-capabilities/mcp/desktop-node-mcp';
import { MCP_STORE_METHODS } from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { mainPlatformConnection } from './connection';
import { createDesktopHostMemoryConfiguration } from './memory-model-configuration';
import { parentPlatformPort } from './parent-platform-port';
import {
  PlatformPolicySchema,
  PlatformProgressSchema,
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

/** Electron-free production entry: Node owns the model loop, Memory and committed log. */
export async function createHostPlatform(
  _options: HostStartOptions,
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<HostPlatform> {
  const port = await parentPlatformPort();
  const connection = mainPlatformConnection(port);
  // The profile's one credential authority: the single writer, token holder and
  // OAuth refresher. Main lends only its validated browser opener.
  const host = await createHostCapabilities({
    env: process.env,
    launch: platformOptions,
    openExternal: async (url) => {
      await request(MCP_STORE_METHODS.openExternal, { url });
    },
    startup,
  });
  const executions = new Map<string, HostToolContext & { readonly toolId: string }>();
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
  const mcpHost = await createDesktopNodeMcpHost(connection, request, startup, () =>
    host.credentials.secrets()
  );
  await startup.register(() => mcpHost.close());
  return createProductionHostPlatform({
    auth: host.auth,
    close: async () => {
      // MCP cleanup still writes through Main's stores, so it joins before Main closes.
      await mcpHost.close();
      await request('platform/close', {});
    },
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
        memory = await createDesktopHostMemoryConfiguration(selected, resolveAuth);
      } catch (cause) {
        try {
          await closeSelection();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Memory model admission and cleanup failed');
        }
        throw cause;
      }
      const tools = Object.fromEntries(
        Object.entries(selected.tools).map(([name, descriptor]) => [
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
    startup,
    validateWorkspaceBinding: async ({ binding, signal, threadId }) => {
      z.strictObject({ accepted: z.literal(true) }).parse(
        await request('platform/workspace/validate', { binding, threadId }, signal)
      );
    },
  });
}
