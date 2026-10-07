import type { ProviderAuthInput, RuntimeData } from '@brainstrike/agent/provider-runtime';
import { createLanguageModelProvider } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  canonicalToolModelOutput,
  createProductionHostPlatform,
  type HostPlatform,
  type HostStartupContext,
  type HostTool,
  type HostToolContext,
  type ProductionHostRunConfiguration,
  platformToolInputSchema,
} from '@brainstrike/agent-host';
import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { mainPlatformConnection } from './connection';
import { parentPlatformPort } from './parent-platform-port';
import { decodePlatformAuth } from './platform-auth';
import {
  PlatformPolicySchema,
  PlatformProgressSchema,
  PlatformSelectionSchema,
} from './platform-wire';

type PlatformSelection = z.output<typeof PlatformSelectionSchema>;
type ResolvePlatformAuth = (provider: string) => Promise<ProviderAuthInput | undefined>;

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
async function resolveObserverModel(
  observation: PlatformSelection['memory']['settings']['observationalMemory'],
  resolveAuth: ResolvePlatformAuth
): Promise<ReturnType<typeof createLanguageModelProvider> | undefined> {
  if (!observation.enabled) {
    return undefined;
  }
  const target = parseObservationalMemoryModelTarget(observation.modelTarget);
  const auth = await resolveAuth(target.provider);
  if (auth?.kind !== 'api_key') {
    throw new Error('Observational Memory requires the configured concrete provider credential');
  }
  return createLanguageModelProvider(target.provider, auth.apiKey, target.model);
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
  };
}

function desktopMemoryConfiguration(
  selected: PlatformSelection,
  observerModel: ReturnType<typeof createLanguageModelProvider> | undefined
): ProductionHostRunConfiguration['memory'] {
  const observation = selected.memory.settings.observationalMemory;
  return {
    native: {
      options: {
        ...selected.memory.options,
        observationalMemory: observerModel
          ? {
              model: observerModel,
              scope: observation.scope,
              ...(observation.retrievalMode === 'messages'
                ? { retrieval: { scope: observation.scope } }
                : {}),
              observation: { messageTokens: observation.messageTokens },
              reflection: { observationTokens: observation.observationTokens },
            }
          : false,
        semanticRecall: false,
      },
    },
    recordPrompt: async () => undefined,
    resourceId: selected.resourceId,
  };
}

/** Electron-free production entry: Node owns the model loop, Memory and committed log. */
export async function createHostPlatform(
  _options: HostStartOptions,
  startup: HostStartupContext
): Promise<HostPlatform> {
  const port = await parentPlatformPort();
  const connection = mainPlatformConnection(port);
  const executions = new Map<string, HostToolContext>();
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
  const resolveAuth = async (provider: string) =>
    decodePlatformAuth(await request('platform/auth', { provider }));
  return createProductionHostPlatform({
    close: async () => {
      await request('platform/close', {});
    },
    readConfiguration: async (admission) => {
      const response = await request(
        'platform/admit',
        {
          ...(admission.configuration ? { configuration: admission.configuration } : {}),
          ...(admission.snapshot ? { snapshot: admission.snapshot } : {}),
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
      const observation = selected.memory.settings.observationalMemory;
      let observerModel: ReturnType<typeof createLanguageModelProvider> | undefined;
      try {
        observerModel = await resolveObserverModel(observation, resolveAuth);
      } catch (cause) {
        try {
          await request('platform/release', { threadId: admission.threadId });
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
            permissionToolId: descriptor.permissionToolId,
            risk: descriptor.risk,
            ...(descriptor.strict === undefined ? {} : { strict: descriptor.strict }),
            execute: async (input: unknown, context: HostToolContext): Promise<unknown> => {
              const address = JSON.stringify([context.runId, context.toolCallId]);
              if (executions.has(address)) {
                throw new Error('Platform tool call is already executing');
              }
              executions.set(address, context);
              try {
                return await request(
                  'platform/execute',
                  {
                    input: z.json().parse(input),
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
        close: async () => {
          await request('platform/release', { threadId: admission.threadId });
        },
        configuration,
        durableConfiguration: selected.durableConfiguration,
        ...(selected.system === undefined ? {} : { system: selected.system }),
        maxSteps: selected.maxSteps,
        memory: desktopMemoryConfiguration(selected, observerModel),
        providerRequestContext: {
          inputTokenLimit: selected.inputTokenLimit,
          provider,
          runtimeData: configuration,
        },
        resolvedToolResultBudget: resolveScaledToolResultBudget(selected.contextWindow),
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
    resolveProviderAuth: resolveAuth,
    startup,
  });
}
