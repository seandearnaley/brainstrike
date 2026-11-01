import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeWorkspaceRoot, ScannedWorkspaceSkills } from '@brainstrike/agent';
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
  trustedHostWorkspaceRoots,
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
  isSupportedProvider,
  NATIVE_TOOL_ID,
  type ReferencedFileFailure,
  refusalError,
  SKILL_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { createLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import { createHostCapabilities } from './capabilities.ts';
import { commandSessionExecutors } from './command-sessions/executors-sessions.ts';
import {
  disposeHostTools,
  hostCommandSessionManager,
} from './command-sessions/host-tool-process.ts';
import { resolveHostDelegation } from './delegation.ts';
import {
  hostShellCorrelation,
  hostWorktreeToolExecutors,
} from './git-workspace/executors-worktree.ts';
import {
  createWorktreeWorkspace,
  type WorktreeWorkspace,
} from './git-workspace/host-git-workspace.ts';
import { defaultManagedWorktreeDirectory } from './git-workspace/worktree-settings.ts';
import type { HostWorktreeServices } from './git-workspace/worktree-tool-dependencies.ts';
import { getGlobalHooksPath } from './hooks/config.ts';
import { loadHostRunHooks, trustedHookRoots } from './hooks/host-run-hooks.ts';
import {
  type CodeExecutionHost,
  createSharedNativeHostTools,
  createSystemPythonResolver,
  executeCommandExecutor,
  forgetSharedNativeToolThread,
  getEditDiagnostics,
  grepSearchExecutor,
  INSPECTION_TOOL_EXECUTORS,
  ReadWorkspaceFileCursorRegistry,
  runPythonExecutor,
  runSkillScriptExecutor,
  selectHostProjectionRewrites,
  skillToolExecutors,
} from './native-tools/index.ts';
import { closeStandaloneOwners } from './standalone-close.ts';
import { createStandaloneHumanTools, STANDALONE_HUMAN_TOOL_IDS } from './standalone-human-tools.ts';
import { readHostWorkspaceContext } from './workspace-context/host-system-context.ts';
import { prepareAdmittedSkills } from './workspace-context/request-skills.ts';
import { createSecureSkillsFs } from './workspace-context/skills-fs.ts';

const logger = createLogger('StandalonePlatform');

/**
 * The native tools a standalone host runs over its launch roots: the shared
 * ones, grep, language-server inspection, its shell and command sessions, the
 * managed worktrees in its own ledger and the Agent Skills with their scripts.
 * run_python joins them where this machine has the OS fence (`standaloneToolIds`).
 */
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
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.lspInspect,
  NATIVE_TOOL_ID.readToolOutputArtifact,
  NATIVE_TOOL_ID.executeCommand,
  NATIVE_TOOL_ID.inspectCommandSessions,
  NATIVE_TOOL_ID.manageCommandSession,
  NATIVE_TOOL_ID.listWorktrees,
  NATIVE_TOOL_ID.manageWorktree,
  NATIVE_TOOL_ID.runSkillScript,
  ...SKILL_NATIVE_TOOL_IDS,
];

/**
 * BST-2360: run_python runs only inside the OS fence, so a host without one
 * (Windows) leaves it out of every run instead of asking the person to approve
 * a call that cannot run.
 */
function standaloneToolIds(codeFence: boolean): {
  readonly native: string[];
  readonly workspace: string[];
} {
  const workspace: string[] = [
    ...STANDALONE_WORKSPACE_TOOL_IDS,
    ...(codeFence ? [NATIVE_TOOL_ID.runPython] : []),
  ];
  return { native: [...STANDALONE_HUMAN_TOOL_IDS, ...workspace], workspace };
}

function standaloneCapabilities(nativeToolIds: string[], configuredMcp: boolean) {
  return {
    browserOAuth: 'unavailable',
    configuredMcp: configuredMcp ? 'available' : 'unavailable',
    delegation: 'available',
    localInference: 'unavailable',
    mcpAppUi: 'text',
    nativeTools: { available: nativeToolIds, remaining: 'unavailable' },
    skills: 'available',
    tasks: configuredMcp ? 'available' : 'unavailable',
    workspaceInstructions: 'available',
  };
}

/** The same check run_python's executor makes, loaded only when a run asks. */
async function hostFencesCode(): Promise<boolean> {
  const { isFenceSupported } = await import('@brainstrike/agent/fence-executor');
  return isFenceSupported();
}

/** Every run injects each trusted launch root's instructions file that fits the budget. */
const STANDALONE_WORKSPACE_INSTRUCTIONS = { masterEnabled: true, oversizedOptInByRootId: {} };

/**
 * This host ships the package's own Windows command wrapper, as its hooks
 * resolve it.
 */
const standaloneWindowsCommandEntry = (): string =>
  createRequire(import.meta.url).resolve('@brainstrike/host-capabilities/windows-command-entry');

/**
 * Owner decision (2026-11-01): this host runs the system Python 3, where
 * Desktop runs its bundled runtime; it asks for it once per host. sandbox-runtime
 * finds its own Linux seccomp helper from its package.
 */
function standaloneCodeExecution(): CodeExecutionHost {
  return {
    resolvePythonExecutable: createSystemPythonResolver(),
    resolveSeccompApplyPath: () => undefined,
    windowsCommandEntry: standaloneWindowsCommandEntry,
  };
}

/**
 * A run's host executors. executeCommand and the command sessions are composed
 * as Desktop composes them: the same executors, schemas, cwd fence and
 * `execute` risk, with shell commands correlated on this host's own ledger and
 * sessions started only in the run's launch roots.
 */
function standaloneHostExecutors(
  worktrees: HostWorktreeServices,
  threadId: string,
  codeExecution: CodeExecutionHost
) {
  return {
    [NATIVE_TOOL_ID.executeCommand]: executeCommandExecutor({
      correlation: hostShellCorrelation(worktrees, threadId),
      windowsCommandEntry: standaloneWindowsCommandEntry,
    }),
    [NATIVE_TOOL_ID.grepSearch]: grepSearchExecutor(),
    ...INSPECTION_TOOL_EXECUTORS,
    ...commandSessionExecutors(() => ({
      manager: hostCommandSessionManager(),
      rootsFromRuntime: true,
    })),
    ...hostWorktreeToolExecutors(worktrees, threadId),
    [NATIVE_TOOL_ID.runPython]: runPythonExecutor(codeExecution),
  };
}

/**
 * The command trees, command sessions and language servers this host's runs
 * started, and the worktree service with its git-metadata watchers, all retired.
 */
async function disposeStandaloneChildren(worktrees: WorktreeWorkspace): Promise<void> {
  const outcomes = await Promise.allSettled([disposeHostTools(), worktrees.close()]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Standalone child process cleanup failed');
  }
}

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
  const unavailable = configuredMcp ? 'Browser OAuth' : 'Configured MCP/Tasks, browser OAuth';
  return `This standalone host supports the shared persona children with narrowed tools and tree budgets, the canonical askUser and submitPlan tools, workspace file read, write, string-replace, delete, rename and directory listing, file-name glob, content (grep) and symbol search, TypeScript/JavaScript language-server inspection and post-edit diagnostics, the task list, canvases, shell commands and persistent command sessions started in a workspace root, listing and archiving managed git worktrees (a new worktree is created from the desktop host, which opens it as a folder, and a launch root's own worktree is not archived here), Agent Skills from the home directory and trusted workspace roots (activation, reads, search and their scripts, Python ones on the system Python 3), Python code in the OS sandbox where this machine has one, the trusted roots' workspace instructions files and paging of oversized tool results${mcpTools}. Its workspace roots: ${roots.map((root) => root.path).join(', ')}. ${unavailable} and local inference are unavailable. Use an existing desktop host for those capabilities.`;
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
 * The repo context a standalone run reads from its trusted launch roots and
 * the home directory: one skills scan feeding the prompt's catalog and the
 * skill tools, and the run's instructions with the referenced files, activated
 * skills and workspace instructions every host injects. A recovered run (or a
 * wake) reuses the instructions its start committed, without re-reading files.
 */
async function standaloneWorkspaceContext(
  request: {
    readonly prompt?: string | undefined;
    readonly snapshot?: { readonly configuration: Readonly<Record<string, unknown>> } | undefined;
  },
  options: {
    /** ADR-0032: the launch roots the person trusted (`workspace trust`). */
    readonly configurationRoots: readonly RuntimeWorkspaceRoot[];
    readonly runtime: RuntimeData;
    readonly system: string;
  }
): Promise<{
  /** The workspace context a delegated child inherits (`deriveHostChildAdmission`). */
  readonly childFields: { readonly childSystem?: string };
  readonly referencedFileFailures: readonly ReferencedFileFailure[];
  readonly system: string;
  readonly workspaceSkills: ScannedWorkspaceSkills;
}> {
  const roots = options.configurationRoots;
  const { workspaceSkills } = prepareAdmittedSkills({
    fs: createSecureSkillsFs([...roots.map((root) => root.path), homedir()]),
    homedir,
    roots,
    runtimeData: options.runtime,
  });
  if (!workspaceSkills) {
    throw new Error('The standalone host scanned no skills engine');
  }
  if (request.snapshot) {
    const committed = request.snapshot.configuration;
    const childSystem = wireDecoder(Schema.optional(Schema.String), {
      errors: 'all',
      onExcessProperty: 'error',
    })(committed['childSystem']);
    return {
      childFields: childSystem === undefined ? {} : { childSystem },
      referencedFileFailures: [],
      system: wireDecoder(Schema.String, { errors: 'all', onExcessProperty: 'error' })(
        committed['system']
      ),
      workspaceSkills,
    };
  }
  const context = await readHostWorkspaceContext({
    configurationRoots: [...roots],
    prompt: request.prompt ?? '',
    runtime: options.runtime,
    workspaceSkills,
  });
  const joined = (sections: readonly (string | undefined)[]): string =>
    sections.filter((section): section is string => Boolean(section)).join('\n\n');
  // A child runs on its persona's instructions plus this shared workspace
  // context (instructions, skills catalog), never the parent's own prompt.
  const shared = joined([context.skillsCatalog, ...context.injected]);
  return {
    childFields: shared === '' ? {} : { childSystem: shared },
    referencedFileFailures: context.referencedFileFailures,
    system: joined([options.system, shared]),
    workspaceSkills,
  };
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
    ? await (await import('./mcp/cli-mcp-host.ts')).createCliMcpHost({
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
  // Asked once, by the first run: the check loads the sandbox runtime.
  let codeFence: Promise<boolean> | undefined;
  // This host's interpreter, probed by its first Python call and reused after.
  const codeExecution = standaloneCodeExecution();
  // The worktree ledger and settings are this host's state store's; its roots are the launch roots.
  const worktrees = createWorktreeWorkspace({
    logger,
    managedWorktreeDirectory: defaultManagedWorktreeDirectory(homedir()),
    roots: { listRoots: async () => workspaceRoots },
    store: startup.store,
  });
  await startup.register(() => worktrees.close());
  // Its runs hold the launch roots without a workspace binding: archive refuses those checkouts.
  const worktreeTools: HostWorktreeServices = {
    ...worktrees.tools,
    launchRootPaths: workspaceRoots.map((root) => root.path),
  };
  const system = standaloneSystemPrompt(workspaceRoots, mcp !== undefined);
  const subagents = {
    delegationEnabled: true,
    disabledPersonaIds: [],
    settings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  };
  return createProductionHostPlatform({
    attachThreadReads: (reads) => worktrees.attachThreadReads(reads),
    auth: host.auth,
    // Live commands are retired before MCP and the host capabilities close.
    close: () =>
      closeStandaloneOwners({ commands: () => disposeStandaloneChildren(worktrees), host, mcp }),
    forgetThread: (threadId) => forgetSharedNativeToolThread(threadId, readFileCursorRegistry),
    providers: host.providers,
    ...(mcp ? { mcp: mcp.mcp } : {}),
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
      codeFence ??= hostFencesCode();
      const toolIds = standaloneToolIds(await codeFence);
      const capabilities = standaloneCapabilities(toolIds.native, mcp !== undefined);
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
        enabledNativeToolIds: toolIds.native,
        memoryOptions: {
          lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
          workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
        },
        memorySettings: CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
        modelConfiguration: configuration,
        permissionPolicy: { policies: DEFAULT_PERMISSION_POLICIES, yolo: false },
        subagents,
        workspaceInstructionsPreference: STANDALONE_WORKSPACE_INSTRUCTIONS,
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
      // ADR-0032: a launch root's instructions, skills and personas load once the
      // person trusts it (`workspace trust`); the home tiers always load.
      const configurationRoots = await trustedHostWorkspaceRoots(startup.store, workspaceRoots);
      const workspaceContext = await standaloneWorkspaceContext(request, {
        configurationRoots,
        runtime: {
          ...configuration,
          workspaceInstructionsPreference: STANDALONE_WORKSPACE_INSTRUCTIONS,
          workspaceRoots,
        },
        system,
      });
      const bindings = createStandaloneHumanTools(resolvedToolResultBudget);
      const workspaceTools = createSharedNativeHostTools({
        diagnostics: (args) => getEditDiagnostics(args),
        executors: {
          ...standaloneHostExecutors(worktreeTools, request.threadId, codeExecution),
          ...skillToolExecutors(workspaceContext.workspaceSkills),
          [NATIVE_TOOL_ID.runSkillScript]: runSkillScriptExecutor(
            workspaceContext.workspaceSkills,
            codeExecution
          ),
        },
        ids: toolIds.workspace,
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
        windowsCommandEntry: standaloneWindowsCommandEntry,
      });
      return {
        configuration,
        ...workspaceContext.childFields,
        delegation: resolveHostDelegation({ subagents }, configurationRoots, false),
        durableConfiguration: {
          capabilities,
          ...workspaceContext.childFields,
          intent,
          // Recovery and a wake run on the instructions the run started with.
          system: workspaceContext.system,
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
        referencedFileFailures: [...workspaceContext.referencedFileFailures],
        resolvedToolResultBudget,
        ...auth,
        system: standaloneRunSystem(workspaceContext.system, {
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
    resolveProviderAuth: (provider) => host.auth.resolveProviderAuth(provider),
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
