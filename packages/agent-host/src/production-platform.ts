import {
  buildGenerationProviderOptionsOption,
  buildModelSettingsOption,
  type ProviderRequestContext,
} from '@brainstrike/agent/provider-request';
import {
  createProvider,
  createProviderNativeWebSearchTool,
  type ProviderAuthInput,
  providerSupportsNativeWebSearch,
  type RuntimeData,
  resolveRuntimeConfiguration,
} from '@brainstrike/agent/provider-runtime';
import type { ScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import type { VectorProfile } from '@brainstrike/indexer';
import type { LanguageModel, Tool } from 'ai';
import { z } from 'zod';
import { createMcpHostToolAdapter } from './adapters/mcp.js';
import type { HostMemory } from './adapters/memory.js';
import { hostMemoryTools } from './adapters/memory-tools.js';
import {
  StateStoreHostMemory,
  type StateStoreHostMemoryOptions,
} from './adapters/state-store-host-memory.js';
import type { StateStoreMemoryVector } from './adapters/state-store-memory-vector.js';
import { withHostDelegationTools } from './child-runs.js';
import { type HostStateIndex, openHostStateIndex } from './host-state-index.js';
import { materializeHostProviderModel } from './model-router-sdk.js';
import type {
  HostDelegation,
  HostMcpRuntime,
  HostMcpToolSelection,
  HostPlatform,
  HostRunAdmission,
  HostRunAdmissionRequest,
  HostRunContext,
  HostRunHooks,
  HostTool,
} from './ports.js';
import type { HostRunSnapshot } from './protocol.js';
import { prepareHostProviderTools } from './provider-schema-selection.js';
import type { HostStartupContext } from './runtime.js';

/** Existing settings/context/native catalog owners resolve this once per admitted run. */
export interface ProductionHostRunConfiguration {
  /** BST-1932: the host context a delegated child receives beside its persona instructions. */
  readonly childSystem?: string | undefined;
  /** Borrowed platform capabilities remain owned until every run tail joins. */
  readonly close?: () => Promise<void>;
  readonly configuration: RuntimeData;
  /** BST-1932: the personas and subagent limits this admission may delegate with. */
  readonly delegation?: HostDelegation | undefined;
  readonly durableConfiguration: HostRunSnapshot['configuration'];
  /** The run's lifecycle hooks, when the composition loaded any. */
  readonly hooks?: HostRunHooks;
  readonly maxSteps: number;
  readonly memory: Omit<
    StateStoreHostMemoryOptions,
    'store' | 'providerRequestContext' | 'vectorBridge'
  > & {
    /** Recall/vector-OM embedder and its profile; the host's own state index stores the vectors. */
    readonly vectors?: {
      readonly embedder: NonNullable<StateStoreHostMemoryOptions['native']['embedder']>;
      readonly profile: VectorProfile;
    };
  };
  readonly providerRequestContext: ProviderRequestContext;
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  /** Captured admission auth closure; never part of durable configuration. */
  readonly resolveProviderAuth?: (provider: string) => Promise<ProviderAuthInput | undefined>;
  readonly system?: string;
  /** Complete shipped native catalog with its canonical schema/output projections. */
  readonly tools: Readonly<Record<string, HostTool>>;
  readonly toolTimeoutMs: number;
}

export interface ProductionHostPlatformOptions {
  /** The host's credential authority, where this host owns a credential store. */
  readonly auth?: HostPlatform['auth'];
  close(): Promise<void>;
  /** Purge process-local caches of a deleted thread. */
  readonly forgetThread?: HostPlatform['forgetThread'];
  /** Desktop platform selections already include the existing qualified MCP executors. */
  readonly mcp?: HostMcpRuntime;
  /** Memory resources whose recall/observation vectors the host's state index stores. */
  readonly memoryResourceIds?: readonly string[];
  /** Provider reads from the same credential store. */
  readonly providers?: HostPlatform['providers'];
  readConfiguration(request: HostRunAdmissionRequest): Promise<ProductionHostRunConfiguration>;
  readPermissionPolicy(
    threadId?: string
  ): PermissionToolGateSnapshot | Promise<PermissionToolGateSnapshot>;
  /** Trusted concrete model seam, including scripted qualification with real IPC/tools/storage. */
  resolveModel?: (
    configuration: RuntimeData,
    auth: ProviderAuthInput | undefined
  ) => Promise<Exclude<LanguageModel, string>>;
  resolveProviderAuth(provider: string): Promise<ProviderAuthInput | undefined>;
  /** The live root owner checkpoint revert revalidates against. */
  readonly resolveWorkspaceRoot?: HostPlatform['resolveWorkspaceRoot'];
  /** The native-tool output rewrite policy (host-capabilities). */
  readonly selectProjectionRewrites?: HostPlatform['selectProjectionRewrites'];
  readonly startup: HostStartupContext;
  readonly validateWorkspaceBinding?: HostPlatform['validateWorkspaceBinding'];
}

function rootModel(
  configuration: RuntimeData,
  auth: ProviderAuthInput | undefined
): Exclude<LanguageModel, string> {
  const selected = resolveRuntimeConfiguration(configuration, auth);
  const model = createProvider(
    selected.provider,
    selected.authInput,
    selected.runtime.model,
    selected.runtime
  );
  return materializeHostProviderModel(model);
}

/** The provider's own web search, built with the chat model's auth; Core decides its use. */
function admittedNativeWebSearch(
  provider: string,
  auth: ProviderAuthInput | undefined
): { readonly nativeWebSearch?: Tool } {
  if (!providerSupportsNativeWebSearch(provider)) {
    return {};
  }
  const tool = createProviderNativeWebSearchTool(provider, auth) as unknown as Tool | undefined;
  return tool ? { nativeWebSearch: tool } : {};
}

function unavailableMcpServers(
  borrowed: HostMcpToolSelection | undefined
): Pick<HostRunAdmission, 'unavailableMcpServers'> {
  return borrowed?.unavailable.length ? { unavailableMcpServers: borrowed.unavailable } : {};
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

/** Native catalog, MCP and native Memory tools share one identity namespace. */
function mergeToolCatalogs(
  ...catalogs: readonly Readonly<Record<string, HostTool>>[]
): Record<string, HostTool> {
  const merged: Record<string, HostTool> = {};
  for (const catalog of catalogs) {
    for (const [id, binding] of Object.entries(catalog)) {
      if (Object.hasOwn(merged, id)) {
        throw new Error(`Host tool catalogs collide on ${id}`);
      }
      merged[id] = binding;
    }
  }
  return merged;
}

/**
 * BST-1932: the shipped child Memory. A run that withholds working memory
 * (a read-only persona's child) keeps every other Memory option.
 */
export function hostRunMemoryOptions<Memory extends Pick<StateStoreHostMemoryOptions, 'native'>>(
  memory: Memory,
  context: Pick<HostRunContext, 'workingMemory'>
): Memory {
  if (context.workingMemory !== false) {
    return memory;
  }
  return {
    ...memory,
    native: {
      ...memory.native,
      options: { ...memory.native.options, workingMemory: { enabled: false } },
    },
  };
}

/** Node-only production composition; Core remains the sole dispatcher and event writer. */
export async function createProductionHostPlatform(
  options: ProductionHostPlatformOptions
): Promise<HostPlatform> {
  const selections = new Set<() => Promise<void>>();
  let closing: Promise<void> | undefined;
  let stateIndex: Promise<HostStateIndex> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const joined = await Promise.allSettled([...selections].map((release) => release()));
      // Capability transports remain available until their borrowed selections join.
      joined.push(...(await Promise.allSettled([options.close()])));
      // A failed open already failed startup; only an opened index has a close to join.
      joined.push(
        ...(await Promise.allSettled([
          stateIndex?.then(
            (index) => index.close(),
            () => undefined
          ),
        ]))
      );
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
  ): Promise<
    | {
        borrowed: HostMcpToolSelection;
        mcp: ReturnType<typeof createMcpHostToolAdapter>;
      }
    | undefined
  > => {
    const authority = options.mcp;
    if (!authority) {
      return undefined;
    }
    const borrowed = await authority.executableTools({
      ...(request.snapshot ? { snapshot: request.snapshot } : {}),
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
        mcp: createMcpHostToolAdapter({ bindings: borrowed.bindings, host: authority.authority }),
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
  // Register ownership before the first provider, Memory, MCP or index side effect.
  await options.startup.register(close);
  // The host owns its derived state index: thread deletion, purge and blob GC need it.
  stateIndex = openHostStateIndex(options.startup.store.root, options.memoryResourceIds);
  const index = await stateIndex;
  // One run's captured vector bridge over the host's own state index.
  const runVectorBridge = (
    selected: ProductionHostRunConfiguration,
    threadId: string,
    signal: AbortSignal
  ): StateStoreMemoryVector | undefined => {
    const vectors = selected.memory.vectors;
    return vectors
      ? StateStoreHostMemory.createRunVectorBridge(selected.memory.native, {
          port: index.vectors,
          profile: vectors.profile,
          scope: { resourceId: selected.memory.resourceId, rootId: index.rootId, threadId },
          signal,
        })
      : undefined;
  };
  return {
    ...(options.validateWorkspaceBinding
      ? { validateWorkspaceBinding: options.validateWorkspaceBinding }
      : {}),
    admitRun: async (request) => {
      if (closing) {
        throw new Error('Production host is closing');
      }
      request.signal.throwIfAborted();
      const selected = await options.readConfiguration(request);
      let acquired: Awaited<ReturnType<typeof acquireMcp>>;
      let joined: Promise<void> | undefined;
      const release = (): Promise<void> => {
        joined ??= (async () => {
          const failures: unknown[] = [];
          try {
            if (acquired) {
              await closeMcpAdmission(acquired.mcp, acquired.borrowed);
            }
          } catch (cause) {
            failures.push(cause);
          }
          try {
            await selected.close?.();
          } catch (cause) {
            failures.push(cause);
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, 'Production admission cleanup failed');
          }
          selections.delete(release);
        })();
        return joined;
      };
      selections.add(release);
      try {
        if (closing) {
          throw new Error('Production host is closing');
        }
        const provider = selected.configuration.provider ?? '';
        const auth = selected.resolveProviderAuth
          ? await selected.resolveProviderAuth(provider)
          : await options.resolveProviderAuth(provider);
        const model = options.resolveModel
          ? await options.resolveModel(selected.configuration, auth)
          : rootModel(selected.configuration, auth);
        request.signal.throwIfAborted();
        acquired = await acquireMcp(request, selected);
        // BST-1932: a delegated child opens its own run on this admission, so
        // each run's Memory owner is kept by its run ID.
        const opened = new Map<string, Promise<StateStoreHostMemory>>();
        const runMemory = async (runId: string): Promise<HostMemory> => {
          const owner = await opened.get(runId);
          if (owner?.memory.identity.runId !== runId) {
            throw new Error('Memory tool call has no Memory owner for its run');
          }
          return owner.memory;
        };
        const { vectors, ...memory } = selected.memory;
        const nativeMemory = (
          bridge: StateStoreMemoryVector | undefined,
          native: StateStoreHostMemoryOptions['native'] = memory.native
        ): StateStoreHostMemoryOptions['native'] =>
          bridge && vectors ? { ...native, embedder: vectors.embedder, vector: bridge } : native;
        const authoredTools = mergeToolCatalogs(
          selected.tools,
          acquired?.mcp.tools ?? {},
          // Declarations only: this admission-scoped bridge is never called.
          hostMemoryTools(
            nativeMemory(runVectorBridge(selected, request.threadId, request.signal)),
            runMemory
          )
        );
        // One run-bound registry supplies SDK declarations and approval/restart
        // validation against the concrete resolved model, including MCP opt-out.
        const tools = await prepareHostProviderTools(
          model,
          withHostDelegationTools(authoredTools, selected.delegation)
        );
        request.signal.throwIfAborted();
        const selection: HostRunAdmission = {
          childSystem: selected.childSystem,
          close: release,
          configuration: selected.configuration,
          delegation: selected.delegation,
          // Like the legacy Memory default (`generateTitle: true`).
          generatesThreadTitle: true,
          hooks: selected.hooks,
          inputTokenLimit: selected.providerRequestContext.inputTokenLimit,
          model,
          ...admittedNativeWebSearch(provider, auth),
          openRun: (context) => {
            const bridge = runVectorBridge(selected, context.threadId, context.signal);
            const runOptions = hostRunMemoryOptions(memory, context);
            const owner = StateStoreHostMemory.open(context, {
              ...runOptions,
              native: nativeMemory(bridge, runOptions.native),
              providerRequestContext: () => selected.providerRequestContext,
              store: options.startup.store,
              ...(bridge ? { vectorBridge: bridge } : {}),
            });
            opened.set(context.runId, owner);
            return owner;
          },
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
                ...(selected.system === undefined ? {} : { system: selected.system }),
              };
            },
          },
          snapshot: {
            configuration: selected.durableConfiguration,
            maxSteps: selected.maxSteps,
            toolIdentities: {},
          },
          tools,
          ...unavailableMcpServers(acquired?.borrowed),
        };
        Object.assign(
          selection.snapshot.toolIdentities,
          Object.fromEntries(Object.entries(tools).map(([id, binding]) => [id, binding.identity]))
        );
        request.signal.throwIfAborted();
        return selection;
      } catch (cause) {
        try {
          await release();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Production admission cleanup failed');
        }
        throw cause;
      }
    },
    close,
    readPermissionPolicy: options.readPermissionPolicy,
    ...(options.forgetThread ? { forgetThread: options.forgetThread } : {}),
    ...(options.resolveWorkspaceRoot ? { resolveWorkspaceRoot: options.resolveWorkspaceRoot } : {}),
    ...(options.selectProjectionRewrites
      ? { selectProjectionRewrites: options.selectProjectionRewrites }
      : {}),
    stateIndexer: index.indexer,
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
  };
}
