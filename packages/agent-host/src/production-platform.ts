import {
  buildGenerationProviderOptionsOption,
  buildModelSettingsOption,
  type ProviderRequestContext,
} from '@brainstrike/agent/provider-request';
import {
  createProvider,
  type ProviderAuthInput,
  type RuntimeData,
  resolveRuntimeConfiguration,
} from '@brainstrike/agent/provider-runtime';
import type { ScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { createMcpHostToolAdapter } from './adapters/mcp.js';
import {
  StateStoreHostMemory,
  type StateStoreHostMemoryOptions,
} from './adapters/state-store-host-memory.js';
import { materializeHostProviderModel } from './model-router-sdk.js';
import type {
  HostMcpRuntime,
  HostMcpToolSelection,
  HostPlatform,
  HostRunAdmission,
  HostRunAdmissionRequest,
  HostTool,
} from './ports.js';
import type { HostRunSnapshot } from './protocol.js';
import type { HostStartupContext } from './runtime.js';

/** Existing settings/context/native catalog owners resolve this once per admitted run. */
export interface ProductionHostRunConfiguration {
  readonly configuration: RuntimeData;
  readonly durableConfiguration: HostRunSnapshot['configuration'];
  readonly maxSteps: number;
  readonly memory: Omit<StateStoreHostMemoryOptions, 'store' | 'providerRequestContext'>;
  readonly providerRequestContext: ProviderRequestContext;
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  /** Complete shipped native catalog with its canonical schema/output projections. */
  readonly tools: Readonly<Record<string, HostTool>>;
  readonly toolTimeoutMs: number;
}

export interface ProductionHostPlatformOptions {
  close(): Promise<void>;
  readonly mcp: HostMcpRuntime;
  readConfiguration(request: HostRunAdmissionRequest): Promise<ProductionHostRunConfiguration>;
  readPermissionPolicy(): PermissionToolGateSnapshot;
  /** Trusted concrete model seam, including scripted qualification with real IPC/tools/storage. */
  resolveModel?: (
    configuration: RuntimeData,
    auth: ProviderAuthInput | undefined
  ) => Promise<LanguageModel>;
  resolveProviderAuth(provider: string): Promise<ProviderAuthInput | undefined>;
  readonly startup: HostStartupContext;
}

function rootModel(configuration: RuntimeData, auth: ProviderAuthInput | undefined): LanguageModel {
  const selected = resolveRuntimeConfiguration(configuration, auth);
  const model = createProvider(
    selected.provider,
    selected.authInput,
    selected.runtime.model,
    selected.runtime
  );
  return materializeHostProviderModel(model);
}

async function closeMcpAdmission(
  adapter: ReturnType<typeof createMcpHostToolAdapter>,
  borrowed: HostMcpToolSelection
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await adapter.close();
  } catch (cause) {
    failures.push(cause);
  }
  // Adapter close joins execution even when releasing one of its watches fails.
  // The separately borrowed runtime lease still has to be released afterward.
  try {
    await borrowed.close();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Production MCP admission cleanup failed');
  }
}

/** Node-only production composition; Core remains the sole dispatcher and event writer. */
export async function createProductionHostPlatform(
  options: ProductionHostPlatformOptions
): Promise<HostPlatform> {
  const selections = new Set<HostRunAdmission>();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const joined = await Promise.allSettled([
        ...[...selections].map((selection) => selection.close?.()),
        options.close(),
      ]);
      const failures = joined.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Production host cleanup failed'
        );
      }
    })();
    return closing;
  };
  const acquireMcp = async (
    request: HostRunAdmissionRequest,
    selected: ProductionHostRunConfiguration
  ): Promise<{
    borrowed: HostMcpToolSelection;
    mcp: ReturnType<typeof createMcpHostToolAdapter>;
  }> => {
    const borrowed = await options.mcp.executableTools({
      resolvedToolResultBudget: selected.resolvedToolResultBudget,
      toolTimeoutMs: selected.toolTimeoutMs,
    });
    try {
      request.signal.throwIfAborted();
      if (closing) {
        throw new Error('Production host is closing');
      }
      return {
        borrowed,
        mcp: createMcpHostToolAdapter({ bindings: borrowed.bindings, host: options.mcp.authority }),
      };
    } catch (cause) {
      try {
        await borrowed.close();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Production MCP acquisition cleanup failed');
      }
      throw cause;
    }
  };
  // Register ownership before the first provider, Memory or MCP side effect.
  await options.startup.register(close);
  return {
    admitRun: async (request) => {
      if (closing) {
        throw new Error('Production host is closing');
      }
      request.signal.throwIfAborted();
      const selected = await options.readConfiguration(request);
      const auth = await options.resolveProviderAuth(selected.configuration.provider ?? '');
      const model = options.resolveModel
        ? await options.resolveModel(selected.configuration, auth)
        : rootModel(selected.configuration, auth);
      request.signal.throwIfAborted();
      const { borrowed, mcp } = await acquireMcp(request, selected);
      let joined: Promise<void> | undefined;
      const tools = { ...selected.tools };
      const selection: HostRunAdmission = {
        close: () => {
          joined ??= closeMcpAdmission(mcp, borrowed).then(() => {
            selections.delete(selection);
          });
          return joined;
        },
        configuration: selected.configuration,
        model,
        openRun: (context) =>
          StateStoreHostMemory.open(context, {
            ...selected.memory,
            providerRequestContext: () => selected.providerRequestContext,
            store: options.startup.store,
          }),
        provider: {
          prepare: async ({ configuration, messages, signal }) => {
            signal.throwIfAborted();
            const providerOptions =
              buildGenerationProviderOptionsOption(configuration).providerOptions;
            return {
              ...buildModelSettingsOption(configuration).modelSettings,
              ...(providerOptions
                ? {
                    providerOptions: z
                      .record(z.string(), z.record(z.string(), z.json()))
                      .parse(providerOptions),
                  }
                : {}),
              messages: [...messages],
              model,
            };
          },
        },
        snapshot: {
          configuration: selected.durableConfiguration,
          maxSteps: selected.maxSteps,
          toolIdentities: {},
        },
        tools,
      };
      selections.add(selection);
      try {
        for (const [id, binding] of Object.entries(mcp.tools)) {
          if (Object.hasOwn(tools, id)) {
            throw new Error('Native and MCP catalog identities collide');
          }
          tools[id] = binding;
        }
        Object.assign(
          selection.snapshot.toolIdentities,
          Object.fromEntries(Object.entries(tools).map(([id, binding]) => [id, binding.identity]))
        );
        request.signal.throwIfAborted();
        return selection;
      } catch (cause) {
        try {
          await selection.close?.();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Production admission cleanup failed');
        }
        throw cause;
      }
    },
    close,
    readPermissionPolicy: options.readPermissionPolicy,
  };
}
