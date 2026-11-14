import {
  buildModelSettingsOption,
  type ProviderRequestContext,
} from '@brainstrike/agent/provider-request';
import {
  createProvider,
  createProviderNativeWebSearchTool,
  materializeHostProviderModel,
  type ProviderAuthInput,
  providerSupportsNativeWebSearch,
  type RuntimeData,
  resolveRuntimeConfiguration,
} from '@brainstrike/agent/provider-runtime';
import { startTokenCounter } from '@brainstrike/agent/token-counter';
import type { ScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  AUTO_REVIEW_MODEL_AUTO,
  CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP,
  type PermissionToolGateSnapshot,
  resolveQuickModelTarget,
} from '@brainstrike/assistant-contract';
import { resolveTokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import type { LanguageModel, Tool } from 'ai';
import { Schema } from 'effect';
import { committedRunMessages, createHostToolDiscovery } from './adapters/host-tool-discovery.ts';
import { createMcpHostToolAdapter } from './adapters/mcp.ts';
import { withHostDelegationTools } from './child-runs.ts';
import { type HostStateIndex, openHostStateIndex } from './host-state-index.ts';
import { catalogModel } from './ledger-projection.ts';
import type {
  HostDelegation,
  HostMcpRuntime,
  HostMcpToolSelection,
  HostPlatform,
  HostReviewModel,
  HostRunAdmission,
  HostRunAdmissionRequest,
  HostRunHooks,
  HostTool,
} from './ports.ts';
import type { HostRunSnapshot } from './protocol.ts';
import { prepareHostProviderTools } from './provider-schema-selection.ts';
import type { HostStartupContext } from './runtime.ts';
/** Existing settings/context/native catalog owners resolve this once per admitted run. */
export interface ProductionHostRunConfiguration {
  /** The platform's workspace snapshot owner, for each run's turn boundaries. */
  readonly captureTurnBoundary?: HostRunAdmission['captureTurnBoundary'];
  /** BST-1932: the host context a delegated child receives beside its persona instructions. */
  readonly childSystem?: string | undefined;
  /** Borrowed platform capabilities remain owned until every run tail joins. */
  readonly close?: () => Promise<void>;
  readonly configuration: RuntimeData;
  /** BST-1932: the personas and subagent limits this admission may delegate with. */
  readonly delegation?: HostDelegation | undefined;
  readonly durableConfiguration: HostRunSnapshot['configuration'];
  /** The hook files the composition did not load; Core commits them visibly. */
  readonly hookSkips?: HostRunAdmission['hookSkips'];
  /** The run's lifecycle hooks, when the composition loaded any. */
  readonly hooks?: HostRunHooks;
  readonly maxSteps: number;
  readonly providerRequestContext: ProviderRequestContext;
  readonly readPromptContext?: HostRunAdmission['readPromptContext'];
  readonly referencedFileFailures?: HostRunAdmission['referencedFileFailures'];
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  /** Captured admission auth closure; never part of durable configuration. */
  readonly resolveProviderAuth?: (provider: string) => Promise<ProviderAuthInput | undefined>;
  readonly system?: string;
  /** Complete shipped native catalog with its canonical schema/output projections. */
  readonly tools: Readonly<Record<string, HostTool>>;
  readonly toolTimeoutMs: number;
}
export interface ProductionHostPlatformOptions {
  /** Core's thread reads, for the platform services that ask which runs are live. */
  readonly attachThreadReads?: HostPlatform['attachThreadReads'];
  /** The host's credential authority, where this host owns a credential store. */
  readonly auth?: HostPlatform['auth'];
  /** ADR-0034 Automatic isolation: a checkout's git facts and the worktree tool's create-and-open. */
  readonly checkoutIsolation?: HostPlatform['checkoutIsolation'];
  /** ADR-0037: a delegated child's run configuration on another model. */
  readonly childConfiguration?: HostPlatform['childConfiguration'];
  close(): Promise<void>;
  /** The command sessions this host's runs start that end by themselves. */
  readonly commandSessionExits?: HostPlatform['commandSessionExits'];
  /** ADR-0029 stage 4: the desktop Explorer's reads. */
  readonly fileReads?: HostPlatform['fileReads'];
  /** ADR-0035: the desktop Explorer's Search tab. */
  readonly fileSearch?: HostPlatform['fileSearch'];
  /** ADR-0029 stage 4: the desktop Explorer's root watches. */
  readonly fileWatches?: HostPlatform['fileWatches'];
  /** Purge process-local caches of a deleted thread. */
  readonly forgetThread?: HostPlatform['forgetThread'];
  /** ADR-0029 stage 2: the desktop's git cluster. */
  readonly gitWorkspace?: HostPlatform['gitWorkspace'];
  /** ADR-0034 decision 7: the idle worktrees the cap archives, which Core tells their thread. */
  readonly idleWorktreeArchives?: HostPlatform['idleWorktreeArchives'];
  /** Desktop platform selections already include the existing qualified MCP executors. */
  readonly mcp?: HostMcpRuntime;
  /** The desktop's MCP content browsing (BST-1930 c5d). */
  readonly mcpContent?: HostPlatform['mcpContent'];
  /** The desktop's MCP Tasks cards and server input (BST-1930 c5c). */
  readonly mcpPresentation?: HostPlatform['mcpPresentation'];
  /** The desktop's MCP settings authority (BST-1930 c5a). */
  readonly mcpSettings?: HostPlatform['mcpSettings'];
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
  /** The snapshot owner's rewind restores; absent where none exists (the CLI). */
  readonly rewindFiles?: HostPlatform['rewindFiles'];
  /** ADR-0029 stage 4: the desktop workspace's open folders. */
  readonly rootRegistry?: HostPlatform['rootRegistry'];
  /** ADR-0034 scratch threads: the folders the host makes for threads with none. */
  readonly scratchFolders?: HostPlatform['scratchFolders'];
  /** The native-tool output rewrite policy (host-capabilities). */
  readonly selectProjectionRewrites?: HostPlatform['selectProjectionRewrites'];
  readonly startup: HostStartupContext;
  /** ADR-0029 stage 3: the desktop's Terminal panel. */
  readonly terminals?: HostPlatform['terminals'];
  readonly validateWorkspaceBinding?: HostPlatform['validateWorkspaceBinding'];
  /** ADR-0029 stage 2: skills and user slash commands on the live roots. */
  readonly workspaceDiscovery?: HostPlatform['workspaceDiscovery'];
}
function rootModel(
  configuration: RuntimeData,
  auth: ProviderAuthInput | undefined
): Exclude<LanguageModel, string> {
  const selected = resolveRuntimeConfiguration(configuration, auth);
  const model = createProvider(selected.provider, selected.authInput, selected.runtime.model);
  return materializeHostProviderModel(model);
}
/** What the admission read for its own prompt, and how it reads a later message's. */
function admittedPromptFields(
  selected: ProductionHostRunConfiguration
): Pick<HostRunAdmission, 'readPromptContext' | 'referencedFileFailures'> {
  return {
    ...(selected.readPromptContext ? { readPromptContext: selected.readPromptContext } : {}),
    ...(selected.referencedFileFailures
      ? { referencedFileFailures: selected.referencedFileFailures }
      : {}),
  };
}
/** The provider's own web search, built with the chat model's auth; Core decides its use. */
function admittedNativeWebSearch(
  provider: string,
  auth: ProviderAuthInput | undefined
): {
  readonly nativeWebSearch?: Tool;
} {
  if (!providerSupportsNativeWebSearch(provider)) {
    return {};
  }
  const tool = createProviderNativeWebSearchTool(provider, auth);
  return tool ? { nativeWebSearch: tool } : {};
}
/** The provider's auth: the admission's own resolver when it brings one, else the host's. */
async function admittedProviderAuth(
  options: Pick<ProductionHostPlatformOptions, 'resolveProviderAuth'>,
  selected: Pick<ProductionHostRunConfiguration, 'resolveProviderAuth'>,
  provider: string
): Promise<ProviderAuthInput | undefined> {
  return selected.resolveProviderAuth
    ? await selected.resolveProviderAuth(provider)
    : await options.resolveProviderAuth(provider);
}
/** The run's concrete model. */
async function admittedModel(
  options: Pick<ProductionHostPlatformOptions, 'resolveModel'>,
  selected: Pick<ProductionHostRunConfiguration, 'configuration' | 'providerRequestContext'>,
  auth: ProviderAuthInput | undefined
): Promise<Exclude<LanguageModel, string>> {
  const { configuration } = selected;
  return options.resolveModel
    ? await options.resolveModel(configuration, auth)
    : rootModel(configuration, auth);
}
/**
 * Auto access mode's review model: `auto` is the chat provider's quick model
 * (never another provider), else a `provider/model` target, each built with
 * its provider's auth as the run's own model is.
 */
function admittedReviewModel(
  options: Pick<ProductionHostPlatformOptions, 'resolveModel' | 'resolveProviderAuth'>,
  selected: Pick<ProductionHostRunConfiguration, 'resolveProviderAuth'>,
  chatProvider: string
): (target: string) => Promise<HostReviewModel> {
  return async (target) => {
    const resolved =
      target === AUTO_REVIEW_MODEL_AUTO ? resolveQuickModelTarget(chatProvider) : target;
    const separator = resolved?.indexOf('/') ?? -1;
    if (resolved === undefined || separator <= 0 || separator === resolved.length - 1) {
      throw new Error(
        resolved === undefined
          ? `No quick model is known for ${chatProvider}; choose an auto-review model`
          : 'An auto-review model must use provider/model format'
      );
    }
    const configuration = {
      model: resolved.slice(separator + 1),
      provider: resolved.slice(0, separator),
    };
    const auth = await admittedProviderAuth(options, selected, configuration.provider);
    return {
      model: options.resolveModel
        ? await options.resolveModel(configuration, auth)
        : rootModel(configuration, auth),
      modelId: `${configuration.provider}::${configuration.model}`,
    };
  };
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
/** Native catalog and MCP tools share one identity namespace. */
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
type ProductionClientService =
  | 'auth'
  | 'fileReads'
  | 'fileSearch'
  | 'rootRegistry'
  | 'fileWatches'
  | 'gitWorkspace'
  | 'mcpContent'
  | 'mcpPresentation'
  | 'mcpSettings'
  | 'providers'
  | 'terminals'
  | 'workspaceDiscovery';
/** The services clients call on the host directly; each is absent where the platform has none. */
function productionClientServices(
  options: Pick<ProductionHostPlatformOptions, ProductionClientService>
): Pick<HostPlatform, ProductionClientService> {
  return {
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.fileReads ? { fileReads: options.fileReads } : {}),
    ...(options.fileSearch ? { fileSearch: options.fileSearch } : {}),
    ...(options.rootRegistry ? { rootRegistry: options.rootRegistry } : {}),
    ...(options.fileWatches ? { fileWatches: options.fileWatches } : {}),
    ...(options.gitWorkspace ? { gitWorkspace: options.gitWorkspace } : {}),
    ...(options.mcpContent ? { mcpContent: options.mcpContent } : {}),
    ...(options.mcpPresentation ? { mcpPresentation: options.mcpPresentation } : {}),
    ...(options.mcpSettings ? { mcpSettings: options.mcpSettings } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.terminals ? { terminals: options.terminals } : {}),
    ...(options.workspaceDiscovery ? { workspaceDiscovery: options.workspaceDiscovery } : {}),
  };
}
/**
 * The host learns a thread's model from the run's admission. A model measured
 * with a local tokenizer starts the token counter worker then, so the worker's
 * start and encoder load run beside the admission, not inside the first
 * provider request (BST-2437, BST-2438).
 */
function startModelTokenCounter(modelId: string): void {
  const selected = catalogModel(modelId);
  if (
    selected &&
    resolveTokenMeasurementCapability(selected.provider, selected.model).mode !==
      'deterministic-serialized-character-backstop'
  ) {
    startTokenCounter();
  }
}
type ProductionConfiguration = Omit<ProductionHostPlatformOptions, 'startup'>;
interface StagedProductionOptions<Configuration extends ProductionConfiguration> {
  readonly configure: (startup: HostStartupContext) => Promise<Configuration>;
  readonly startup: HostStartupContext;
}
interface StagedProductionPlatform<Configuration extends ProductionConfiguration> {
  readonly configuration: Configuration;
  readonly platform: HostPlatform;
}
/** Node-only production composition; Core remains the sole dispatcher and event writer. */
export function createProductionHostPlatform(
  options: ProductionHostPlatformOptions
): Promise<HostPlatform>;
export function createProductionHostPlatform<Configuration extends ProductionConfiguration>(
  options: StagedProductionOptions<Configuration>
): Promise<StagedProductionPlatform<Configuration>>;
export async function createProductionHostPlatform<Configuration extends ProductionConfiguration>(
  input: ProductionHostPlatformOptions | StagedProductionOptions<Configuration>
): Promise<HostPlatform | StagedProductionPlatform<ProductionConfiguration>> {
  let configuration: PromiseSettledResult<ProductionConfiguration> | undefined =
    'configure' in input ? undefined : { status: 'fulfilled', value: input };
  let options: ProductionHostPlatformOptions;
  const selections = new Set<() => Promise<void>>();
  let closing: Promise<void> | undefined;
  let stateIndex: Promise<HostStateIndex> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const joined = await Promise.allSettled([...selections].map((release) => release()));
      // Capability transports remain available until their borrowed selections join.
      if (configuration?.status === 'fulfilled') {
        const configured = configuration.value;
        joined.push(
          ...(await Promise.allSettled([Promise.resolve().then(() => configured.close())]))
        );
      }
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
      if (closing !== undefined) {
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
  // Register ownership before the first provider, MCP or index side effect.
  await input.startup.register(close);
  // The same owner starts the worker before evaluating desktop configuration.
  stateIndex = openHostStateIndex(input.startup.store.root, input.startup);
  const configuring =
    'configure' in input
      ? Promise.resolve().then(() =>
          input.configure({
            ...input.startup,
            register: (release) =>
              input.startup.register(async () => {
                // Effect may release inline when registration races a closed Scope.
                // Never await incomplete configuration from its own registration.
                if (configuration?.status === 'fulfilled') {
                  // The earliest production finalizer reports this same close failure.
                  // This barrier only preserves transport lifetime; release still runs.
                  await Promise.allSettled([close()]);
                }
                await release();
              }),
          })
        )
      : Promise.resolve(input);
  const [indexed, configured] = await Promise.allSettled([
    stateIndex,
    configuring.then(
      (value) => {
        configuration = { status: 'fulfilled', value };
        return value;
      },
      (reason: unknown) => {
        configuration = { reason, status: 'rejected' };
        throw reason;
      }
    ),
  ]);
  // Both acquisitions remain owned through cancellation or either failure.
  if (indexed.status === 'rejected' && configured.status === 'rejected') {
    throw new AggregateError(
      [indexed.reason, configured.reason],
      'Production host acquisition failed'
    );
  }
  if (indexed.status === 'rejected') {
    throw indexed.reason;
  }
  if (configured.status === 'rejected') {
    throw configured.reason;
  }
  input.startup.signal.throwIfAborted();
  const index = indexed.value;
  options = { ...configured.value, startup: input.startup };
  const platform: HostPlatform = {
    ...(options.validateWorkspaceBinding
      ? { validateWorkspaceBinding: options.validateWorkspaceBinding }
      : {}),
    admitRun: async (request) => {
      if (closing !== undefined) {
        throw new Error('Production host is closing');
      }
      request.signal.throwIfAborted();
      startModelTokenCounter(request.modelId);
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
        if (closing !== undefined) {
          throw new Error('Production host is closing');
        }
        const provider = selected.configuration.provider ?? '';
        const auth = await admittedProviderAuth(options, selected, provider);
        const model = await admittedModel(options, selected, auth);
        request.signal.throwIfAborted();
        acquired = await acquireMcp(request, selected);
        const authoredTools = mergeToolCatalogs(selected.tools, acquired?.mcp.tools ?? {});
        const admittedTools = withHostDelegationTools(authoredTools, selected.delegation);
        // Hosted providers defer tools behind the legacy catalog search, over this run's committed steps.
        const discovery = await createHostToolDiscovery({
          modelId: request.modelId,
          provider: selected.providerRequestContext.provider,
          readRunMessages: (run) => committedRunMessages(options.startup.store, run),
          tools: admittedTools,
        });
        // One run-bound registry supplies SDK declarations and approval/restart
        // validation against the concrete resolved model, including MCP opt-out.
        const tools = await prepareHostProviderTools(
          model,
          discovery ? mergeToolCatalogs(admittedTools, discovery.tools) : admittedTools
        );
        request.signal.throwIfAborted();
        const selection: HostRunAdmission = {
          ...(selected.captureTurnBoundary
            ? { captureTurnBoundary: selected.captureTurnBoundary }
            : {}),
          childSystem: selected.childSystem,
          close: release,
          // Both hosts' runs compact at the default cap beside their input budget (BST-2526).
          compactionTokenCap: CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP,
          configuration: selected.configuration,
          delegation: selected.delegation,
          ...(discovery ? { discovery: discovery.discovery } : {}),
          generatesThreadTitle: true,
          hookSkips: selected.hookSkips,
          hooks: selected.hooks,
          inputTokenLimit: selected.providerRequestContext.inputTokenLimit,
          model,
          ...admittedPromptFields(selected),
          resolvedToolResultBudget: selected.resolvedToolResultBudget,
          reviewModel: admittedReviewModel(options, selected, provider),
          ...admittedNativeWebSearch(provider, auth),
          provider: {
            prepare: async ({ configuration, messages, signal }) => {
              signal.throwIfAborted();
              const providerOptions = configuration.providerOptions;
              return {
                ...buildModelSettingsOption(configuration).modelSettings,
                ...(providerOptions
                  ? {
                      providerOptions: Schema.decodeUnknownSync(
                        Schema.Record(
                          Schema.String,
                          Schema.Record(Schema.String, Schema.MutableJson)
                        ),
                        { errors: 'all', onExcessProperty: 'error' }
                      )(providerOptions),
                    }
                  : {}),
                messages: [...messages],
                model,
                ...(selected.system === undefined ? {} : { system: selected.system }),
              };
            },
          },
          providerRequest: selected.providerRequestContext,
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
    ...(options.mcp?.attachTaskOwner
      ? { attachMcpTaskOwner: options.mcp.attachTaskOwner.bind(options.mcp) }
      : {}),
    ...(options.attachThreadReads ? { attachThreadReads: options.attachThreadReads } : {}),
    ...(options.checkoutIsolation ? { checkoutIsolation: options.checkoutIsolation } : {}),
    ...(options.scratchFolders ? { scratchFolders: options.scratchFolders } : {}),
    ...(options.childConfiguration ? { childConfiguration: options.childConfiguration } : {}),
    ...(options.commandSessionExits ? { commandSessionExits: options.commandSessionExits } : {}),
    ...(options.idleWorktreeArchives ? { idleWorktreeArchives: options.idleWorktreeArchives } : {}),
    readPermissionPolicy: options.readPermissionPolicy,
    ...(options.mcp ? { mcp: options.mcp } : {}),
    searchState: (request) => index.search(request),
    ...(options.forgetThread ? { forgetThread: options.forgetThread } : {}),
    ...(options.resolveWorkspaceRoot ? { resolveWorkspaceRoot: options.resolveWorkspaceRoot } : {}),
    ...(options.rewindFiles ? { rewindFiles: options.rewindFiles } : {}),
    ...(options.selectProjectionRewrites
      ? { selectProjectionRewrites: options.selectProjectionRewrites }
      : {}),
    stateIndexer: index.indexer,
    ...productionClientServices(options),
  };
  return 'configure' in input ? { configuration: configured.value, platform } : platform;
}
