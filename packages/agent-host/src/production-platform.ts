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
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { createMcpHostToolAdapter } from './adapters/mcp.js';
import {
  StateStoreHostMemory,
  type StateStoreHostMemoryOptions,
} from './adapters/state-store-host-memory.js';
import type {
  HostMcpRuntime,
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
  /** Complete shipped native catalog with its canonical schema/output projections. */
  readonly tools: Readonly<Record<string, HostTool>>;
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
  if (typeof model === 'string' || !('doStream' in model)) {
    throw new Error('The configured provider requires a concrete SDK host model adapter');
  }
  // The existing provider package pins its own SDK declaration closure. The
  // root uses the same public model object, without a second loop or resolver.
  return model as unknown as LanguageModel;
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
      const mcp = createMcpHostToolAdapter({
        bindings: await options.mcp.executableTools(),
        host: options.mcp.authority,
      });
      let joined: Promise<void> | undefined;
      const tools = { ...selected.tools };
      const selection: HostRunAdmission = {
        close: () => {
          joined ??= mcp.close().then(() => {
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
