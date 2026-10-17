import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { buildModelSettingsOption } from '@brainstrike/agent/provider-request';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import {
  buildToolDiscoveryNote,
  DEFAULT_AGENT_MAX_STEPS,
  resolveAssistantResilienceConfig,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import {
  createProductionHostPlatform,
  type HostPlatform,
  type HostPlatformLaunchOptions,
  type HostStartupContext,
  hostToolDiscoveryEnabled,
  type ProductionHostPlatformOptions,
  type ProductionHostRunConfiguration,
} from '@brainstrike/agent-host';
import {
  readCliWorkspaceRunInput,
  STANDALONE_WORKSPACE_CAPABILITY_ERROR,
} from '@brainstrike/agent-host/standalone-workspace-input';
import {
  CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  deriveAgentLoopInputTokenLimit,
  findLlmModelDefinition,
  findProviderDefinition,
  isSupportedProvider,
  NATIVE_TOOL_ID,
  refusalError,
} from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { Schema } from 'effect';
import { createHostCapabilities } from './capabilities.js';
import { resolveHostDelegation } from './delegation.js';
import { getGlobalHooksPath } from './hooks/config.js';
import { loadHostRunHooks, trustedHookRoots } from './hooks/host-run-hooks.js';
import {
  createSharedNativeHostTools,
  forgetSharedNativeToolThread,
  ReadWorkspaceFileCursorRegistry,
  selectHostProjectionRewrites,
} from './native-tools/index.js';
import { createStandaloneHumanTools, STANDALONE_HUMAN_TOOL_IDS } from './standalone-human-tools.js';

/** The shared native tools a standalone host runs over its launch roots. */
const STANDALONE_WORKSPACE_TOOL_IDS = [
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.readWorkspaceDirectory,
  NATIVE_TOOL_ID.writeWorkspaceFile,
  NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
  NATIVE_TOOL_ID.deleteWorkspaceFile,
  NATIVE_TOOL_ID.renameWorkspaceFile,
  NATIVE_TOOL_ID.manageTaskList,
  NATIVE_TOOL_ID.manageCanvas,
  NATIVE_TOOL_ID.globWorkspace,
  NATIVE_TOOL_ID.findWorkspaceSymbol,
  NATIVE_TOOL_ID.readToolOutputArtifact,
] as const;
const STANDALONE_NATIVE_TOOL_IDS = [...STANDALONE_HUMAN_TOOL_IDS, ...STANDALONE_WORKSPACE_TOOL_IDS];

const standaloneCapabilities = {
  browserOAuth: 'unavailable',
  configuredMcp: 'unavailable',
  delegation: 'available',
  localInference: 'unavailable',
  mcpAppUi: 'text',
  nativeTools: { available: STANDALONE_NATIVE_TOOL_IDS, remaining: 'unavailable' },
  skills: 'unavailable',
  tasks: 'unavailable',
  vectorMemory: 'unavailable',
  workspaceInstructions: 'unavailable',
};

/** The standalone host has no plan mode; it refuses one rather than run unplanned. */
function refuseStandalonePlanMode(request: { readonly planMode?: true }): void {
  if (request.planMode) {
    throw new Error(
      'Plan mode is unavailable on the standalone host. Use the desktop host for plan mode.'
    );
  }
}

function selection(modelId: string) {
  const separator = modelId.indexOf('::');
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 2);
  if (separator < 1 || !model || !isSupportedProvider(provider)) {
    throw refusalError(
      'configuration',
      'model.selection-invalid',
      'Standalone --model requires an explicit canonical provider::model',
      'Choose a supported provider and model from the canonical catalog.'
    );
  }
  const source = findProviderDefinition(provider);
  if (source?.runtime === 'on-device' || source?.runtime === 'local') {
    throw refusalError(
      'availability',
      'model.runtime-unavailable',
      'The selected provider requires an unavailable headless local-runtime capability',
      'Use the desktop host for local inference, or select a hosted model.'
    );
  }
  const definition = findLlmModelDefinition(provider, model);
  if (!definition) {
    throw refusalError(
      'configuration',
      'model.catalog-unavailable',
      'The selected model has no canonical runtime catalog definition',
      'Choose a model from the canonical catalog.'
    );
  }
  return { definition, model, provider };
}

/**
 * The launch roots this host was started with (`--workspace`, cwd by default).
 * The launch option owns their identity: a root's id is its canonical path.
 */
async function standaloneWorkspaceRoots(
  paths: readonly string[] | undefined
): Promise<RuntimeWorkspaceRoot[]> {
  if (!paths) {
    throw new Error('A standalone host requires its launch workspace roots');
  }
  const roots: RuntimeWorkspaceRoot[] = [];
  for (const path of paths) {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error('A standalone workspace root must be a directory');
    }
    if (roots.some((root) => root.rootId === canonical)) {
      throw new Error('A standalone workspace root was given twice');
    }
    roots.push({
      displayName: basename(canonical) || canonical,
      path: canonical,
      rootId: canonical,
    });
  }
  return roots;
}

/** What this standalone host can do, for the model. */
function standaloneSystemPrompt(
  roots: readonly RuntimeWorkspaceRoot[],
  configuredMcp: boolean
): string {
  const mcpTools = configuredMcp
    ? ', and the configured MCP servers with their Tasks (text Apps only)'
    : '';
  const unavailableMcp = configuredMcp ? '' : 'configured MCP/Tasks, ';
  return `This standalone host supports the shared persona children with narrowed tools and tree budgets, the canonical askUser and submitPlan tools, workspace file read, write, string-replace, delete, rename and directory listing, file-name glob and symbol search, the task list, canvases and paging of oversized tool results${mcpTools}. Its workspace roots: ${roots.map((root) => root.path).join(', ')}. Content search, language-server inspection and shell tools, ${unavailableMcp}Skills/workspace instructions, browser OAuth, local inference and vector Memory are unavailable. Use an existing desktop host for those capabilities.`;
}

/**
 * The run's instructions: with the legacy discovery guidance when hosted
 * discovery defers part of its catalog.
 */
function standaloneRunSystem(
  system: string,
  catalog: Parameters<typeof hostToolDiscoveryEnabled>[0]
): string {
  if (!hostToolDiscoveryEnabled(catalog)) {
    return system;
  }
  const names = new Map(
    Object.entries(catalog.tools).map(([name, tool]) => [name, tool.permissionToolId ?? name])
  );
  return `${system}\n\n${buildToolDiscoveryNote(names)}`;
}

/**
 * A model a trusted `--platform` module runs instead of a hosted one (an eval's
 * scripted model). A run selects it by its own `provider::modelId`, so the
 * committed run names the model that ran; `budgets` names the catalog model
 * whose context window and output cap it runs under. It reads no credential.
 */
export interface StandaloneTrustedModel {
  readonly budgets: string;
  readonly model: Awaited<ReturnType<NonNullable<ProductionHostPlatformOptions['resolveModel']>>>;
}

/** Trusted models by `provider::modelId`, each with its own identity and catalog budgets. */
function trustedModelIndex(
  models: readonly StandaloneTrustedModel[]
): ReadonlyMap<string, StandaloneTrustedModel> {
  const index = new Map(
    models.map((entry) => [`${entry.model.provider}::${entry.model.modelId}`, entry])
  );
  if (models.length === 0 || index.size !== models.length) {
    throw new Error('A trusted composition supplies one or more models, each under its own id');
  }
  for (const [id, entry] of index) {
    // A trusted model never answers for a catalog model, so no log names a model that did not run.
    if (isSupportedProvider(entry.model.provider)) {
      throw new Error(`Trusted model ${id} must not claim a catalog provider's identity`);
    }
    selection(entry.budgets);
  }
  return index;
}

/**
 * A run's selection: the catalog model it names, or (on a trusted host, which
 * runs only its own) a trusted model under its catalog budgets.
 */
function runSelection(
  modelId: string,
  trusted: ReadonlyMap<string, StandaloneTrustedModel> | undefined
) {
  const trustedModel = trusted?.get(modelId);
  if (trusted && !trustedModel) {
    throw refusalError(
      'configuration',
      'model.selection-invalid',
      'This host runs only the models its trusted composition supplies',
      'Select one of the trusted provider::model ids this host was composed with.'
    );
  }
  const catalog = selection(trustedModel?.budgets ?? modelId);
  const provider = trustedModel ? trustedModel.model.provider : catalog.provider;
  const selected: RuntimeData = {
    model: trustedModel ? trustedModel.model.modelId : catalog.model,
    provider,
  };
  // A trusted model holds no provider credential, so none is read for it.
  const auth: Pick<ProductionHostRunConfiguration, 'resolveProviderAuth'> = trustedModel
    ? { resolveProviderAuth: async () => undefined }
    : {};
  return { auth, catalog, provider, selected };
}

/**
 * Root and its canonical writer have already been acquired by startAgentHost.
 * `trusted` is reachable only from a module composing this function: the CLI's
 * process entry passes three arguments, and no flag, env var or run input
 * names a trusted model. With trusted models, the host runs only those.
 */
export async function createHostPlatform(
  options: HostStartOptions,
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions,
  trusted?: { readonly models: readonly StandaloneTrustedModel[] }
): Promise<HostPlatform> {
  if (options.root !== startup.store.root) {
    throw new Error('Standalone platform must borrow its acquired canonical Root');
  }
  const trustedModels = trusted && trustedModelIndex(trusted.models);
  const workspaceRoots = await standaloneWorkspaceRoots(platformOptions?.workspaceRoots);
  // One host-lifetime registry; its handles are scoped to their thread.
  const readFileCursorRegistry = new ReadWorkspaceFileCursorRegistry();
  const host = await createHostCapabilities({
    env: process.env,
    launch: platformOptions,
    startup,
  });
  // Configured MCP servers run in this host's own MCP runtime, Tasks in its StateStore.
  // The MCP client stack loads only for a configured host: imported eagerly it
  // added ~200 ms to every CLI host start, pushing cold starts past `host start`.
  const mcpConfig = platformOptions?.mcpConfig;
  const mcp = mcpConfig
    ? await (await import('./mcp/cli-mcp-host.js')).createCliMcpHost({
        configPath: mcpConfig.path,
        credentials: host.credentials,
        startup,
      })
    : undefined;
  if (mcp) {
    await startup.register(async () => {
      await mcp.close();
    });
  }
  const capabilities = mcp
    ? { ...standaloneCapabilities, configuredMcp: 'available', tasks: 'available' }
    : standaloneCapabilities;
  const system = standaloneSystemPrompt(workspaceRoots, mcp !== undefined);
  const subagents = {
    delegationEnabled: true,
    disabledPersonaIds: [],
    settings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  };
  return createProductionHostPlatform({
    auth: host.auth,
    close: async () => {
      // MCP cleanup can still write OAuth records through the credential store.
      await mcp?.close();
      await host.close();
    },
    forgetThread: (threadId) => forgetSharedNativeToolThread(threadId, readFileCursorRegistry),
    providers: host.providers,
    ...(mcp ? { mcp: mcp.mcp } : {}),
    // The same memory resource as the desktop host, so one state root keeps one
    // derived identity whichever host opens it. Vector Memory stays unavailable here.
    memoryResourceIds: [WORKSPACE_MEMORY_RESOURCE_ID],
    readConfiguration: async (request): Promise<ProductionHostRunConfiguration> => {
      request.signal.throwIfAborted();
      if (readCliWorkspaceRunInput(request.configuration)) {
        throw refusalError(
          'availability',
          'workspace.capabilities-unavailable',
          `[${STANDALONE_WORKSPACE_CAPABILITY_ERROR}] Standalone workspace input requires the existing profile/catalog and pinned workspace service capabilities`,
          'Attach to the desktop host that owns the selected workspace.'
        );
      }
      const { auth, catalog, provider, selected } = runSelection(request.modelId, trustedModels);
      const modelSettings = buildModelSettingsOption(selected).modelSettings;
      const configuration: RuntimeData = {
        ...selected,
        ...(modelSettings ? { modelSettings } : {}),
      };
      const inputTokenLimit = deriveAgentLoopInputTokenLimit(
        catalog.definition,
        provider,
        configuration.modelSettings?.maxOutputTokens
      );
      if (!inputTokenLimit) {
        throw new Error('The selected model has no canonical input token budget');
      }
      // Coordinator-approved stateless CLI policy: explicit selection is separate
      // from Main's saved enabled-model preference. Existing hosts keep their owner.
      const intent = wireDecoder(Schema.Record(Schema.String, Schema.MutableJson), {
        errors: 'all',
        onExcessProperty: 'error',
      })({
        agentLoop: { inputTokenLimit, maxSteps: DEFAULT_AGENT_MAX_STEPS },
        enabledNativeToolIds: STANDALONE_NATIVE_TOOL_IDS,
        memoryOptions: {
          lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
          workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
        },
        memorySettings: CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
        modelConfiguration: configuration,
        permissionPolicy: { policies: DEFAULT_PERMISSION_POLICIES, yolo: false },
        subagents,
        workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
      });
      refuseStandalonePlanMode(request);
      const captured = request.configuration ?? request.snapshot?.configuration['intent'];
      if (
        request.snapshot &&
        (captured === undefined ||
          !isDeepStrictEqual(request.snapshot.configuration['capabilities'], capabilities))
      ) {
        throw new Error('Captured run has no compatible standalone platform capabilities');
      }
      if (captured !== undefined && !isDeepStrictEqual(captured, intent)) {
        throw refusalError(
          'configuration',
          'run.capabilities-unavailable',
          'Captured run intent requires capabilities unavailable on this standalone host',
          'Start a new run using this host’s supported capabilities.'
        );
      }
      if (
        request.snapshot &&
        !isDeepStrictEqual(request.snapshot.configuration['workspaceRoots'], workspaceRoots)
      ) {
        throw new Error("Captured run workspace roots differ from this host's launch roots");
      }
      const resolvedToolResultBudget = resolveScaledToolResultBudget(
        catalog.definition.contextWindow
      );
      const bindings = createStandaloneHumanTools(resolvedToolResultBudget);
      const workspaceTools = createSharedNativeHostTools({
        ids: STANDALONE_WORKSPACE_TOOL_IDS,
        readFileCursorRegistry,
        resolvedToolResultBudget,
        runtime: { ...configuration, workspaceRoots },
      });
      const tools = { ...bindings.tools, ...workspaceTools };
      const toolTimeoutMs = resolveAssistantResilienceConfig().toolTimeoutMs;
      // Global hooks run as configured; a launch root's project file runs only
      // at the hash the host trusted it at, and is reported, not run, otherwise.
      const { hooks, skipped } = loadHostRunHooks({
        globalPath: getGlobalHooksPath(),
        maxHookTimeoutMs: toolTimeoutMs,
        roots: await trustedHookRoots(startup.store, workspaceRoots),
        sessionId: request.threadId,
      });
      return {
        configuration,
        delegation: resolveHostDelegation({ subagents }, provider, workspaceRoots, false),
        durableConfiguration: {
          capabilities,
          intent,
          workspaceRoots: workspaceRoots.map(({ displayName, path, rootId }) => ({
            displayName,
            path,
            rootId,
          })),
        },
        ...(hooks ? { hooks } : {}),
        // Core commits the hook files this run did not load (`hooks.skipped`).
        hookSkips: skipped,
        maxSteps: DEFAULT_AGENT_MAX_STEPS,
        memory: {
          native: {
            options: {
              lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
              observationalMemory: false,
              semanticRecall: false,
              workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
            },
          },
          // Core already commits the final prepared request accounting before this observer.
          recordPrompt: async () => undefined,
          resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        },
        // A trusted model's request is shaped as its budgets model's provider shapes it.
        providerRequestContext: {
          inputTokenLimit,
          provider: catalog.provider,
          runtimeData: configuration,
        },
        resolvedToolResultBudget,
        ...auth,
        system: standaloneRunSystem(system, {
          modelId: request.modelId,
          provider: catalog.provider,
          tools,
        }),
        tools,
        toolTimeoutMs,
      };
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    ...(trustedModels
      ? {
          resolveModel: async ({ model, provider }: RuntimeData) => {
            const entry = trustedModels.get(`${provider}::${model}`);
            if (!entry) {
              throw new Error(`No trusted model ${provider}::${model} on this host`);
            }
            return entry.model;
          },
        }
      : {}),
    // The standalone host has no private desktop client: subscription auth refuses.
    resolveProviderAuth: (provider) => host.auth.resolveProviderAuth(provider, undefined),
    resolveWorkspaceRoot: async ({ rootId }) => {
      const root = workspaceRoots.find((candidate) => candidate.rootId === rootId);
      if (!root) {
        throw new Error("The workspace root is not one of this host's launch roots");
      }
      return root.path;
    },
    selectProjectionRewrites: selectHostProjectionRewrites,
    startup,
  });
}
