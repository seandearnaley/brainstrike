import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  createAssistantSkillTools,
  type RuntimeData,
  resolveAssistantResilienceConfig,
  type ScopedToolOutputArtifactReader,
} from '@brainstrike/agent';
import {
  DEFAULT_AGENT_MAX_STEPS,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import type {
  HostDelegation,
  HostRunAdmissionRequest,
  HostTool,
  HostToolContext,
} from '@brainstrike/agent-host';
import {
  CliWorkspaceRootsSchema,
  materializeCliWorkspaceIntent,
  readCliWorkspaceRunInput,
  revalidateCliWorkspaceRoots,
  selectCliWorkspaceRoots,
} from '@brainstrike/agent-host/standalone-workspace-input';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  DESKTOP_NATIVE_TOOLS,
  deriveAgentLoopInputTokenLimit,
  findLlmModelDefinition,
  findProviderDefinition,
  isPermissionDenied,
  isSupportedProvider,
  listAutoObservationalMemoryCandidates,
  NATIVE_TOOL_ID,
  resolveToolRiskCategory,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW } from '@brainstrike/assistant-contract/context-budget';
import { listEmbeddingModels } from '@brainstrike/assistant-contract/provider-metadata';
import { changesThreadWorkspaceScope } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-repository';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/stream-init';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/native-tools';
import { z } from 'zod';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';
import {
  buildDesktopAssistantTools,
  type DesktopAssistantToolDependencies,
} from '../assistant-server/assistant-tools';
import {
  type PreparedAdmittedSkills,
  prepareAdmittedSkills,
} from '../assistant-server/request-skills';
import { createSecureSkillsFs } from '../assistant-server/skills-fs-deps';
import { loadWorkspaceRootsFromDatabase } from '../assistant-server/workspace-roots';
import {
  type DesktopWorktreeServices,
  desktopWorktreeToolDependencies,
} from '../assistant-server/worktree-tool-dependencies';
import { getDatabase } from '../db-main';
import {
  type DesktopHostSystemContext,
  desktopPlanModeTools,
  readDesktopHostSystemContext,
} from './desktop-host-context';
import { resolveDesktopHostDelegation } from './desktop-host-delegation';
import { desktopHostToolServices, desktopNativeRuntime } from './desktop-host-tool-runtime';
import type {
  DesktopWorkspaceBindingAuthority,
  DesktopWorkspaceBindingBorrow,
} from './desktop-workspace-binding';
import type { DesktopPlatformCapabilities, DesktopPlatformSelection } from './main-platform';
import {
  type DesktopMemoryVectorSelection,
  resolveDesktopMemoryVectors,
} from './memory-vector-selection';
import {
  PlatformClientConfigurationSchema,
  PlatformModelConfigurationSchema,
  platformPermissionPolicy,
} from './platform-wire';

interface DesktopCatalogSelection {
  readonly definition: NonNullable<ReturnType<typeof findLlmModelDefinition>>;
  readonly model: string;
  readonly provider: SupportedProvider;
}

/** Supplied by the existing settings owner, never parsed from client configuration. */
export type DesktopCliOwnerIntentReader = (request: HostRunAdmissionRequest) => Promise<unknown>;

function desktopSystemFields(system: string | undefined): { readonly system?: string } {
  return system === undefined ? {} : { system };
}

function desktopContextReaderFields(
  restricted: boolean,
  readWorkspaceFile: WorkspaceFileReader
): { readonly readWorkspaceFile?: WorkspaceFileReader } {
  return restricted ? { readWorkspaceFile } : {};
}

function desktopWorkspaceSelectionFields(
  request: HostRunAdmissionRequest,
  workspace: DesktopWorkspaceBindingBorrow | undefined
): Pick<DesktopPlatformSelection, 'workspace'> {
  return request.workspaceBinding?.operatingRootId && workspace
    ? {
        workspace: {
          boundWorkspaceRootId: request.workspaceBinding.operatingRootId,
          roots: [...workspace.roots],
        },
      }
    : {};
}

function desktopWorkspaceRootObservation(
  workspace: DesktopWorkspaceBindingBorrow | undefined
): RuntimeData['workspaceRoots'] {
  return workspace ? [...workspace.roots] : undefined;
}

function desktopRetrievalScopeFields(
  restricted: boolean,
  roots: NonNullable<RuntimeData['workspaceRoots']>
): Pick<DesktopAssistantToolDependencies, 'admittedWorkspaceRootIds'> {
  return restricted ? { admittedWorkspaceRootIds: roots.map((root) => root.rootId) } : {};
}

function desktopDurableConfiguration(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  observerTarget: string | null,
  { childSystem, system }: DesktopHostSystemContext,
  cliWorkspaceRoots?: RuntimeData['workspaceRoots'],
  boundWorkspaceRoots?: RuntimeData['workspaceRoots']
): DesktopPlatformSelection['durableConfiguration'] {
  return z.record(z.string(), z.json()).parse(
    JSON.parse(
      JSON.stringify({
        intent,
        ...(cliWorkspaceRoots ? { cliWorkspaceRoots } : {}),
        ...(boundWorkspaceRoots ? { boundWorkspaceRoots } : {}),
        ...desktopSystemFields(system),
        ...(childSystem === undefined ? {} : { childSystem }),
        memoryResolution: {
          observationalMemory: desktopObservationResolution(
            intent.memorySettings.observationalMemory.enabled,
            observerTarget
          ),
          observerTarget,
        },
      })
    )
  );
}

function desktopInputTokenLimit(
  definition: DesktopCatalogSelection['definition'],
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  configuration: z.output<typeof PlatformModelConfigurationSchema>
): number {
  const limit =
    intent.agentLoop?.inputTokenLimit ??
    deriveAgentLoopInputTokenLimit(
      definition,
      configuration.provider,
      configuration.modelSettings?.maxOutputTokens
    );
  if (!limit) {
    throw new Error('The selected model has no resolved input token budget');
  }
  return limit;
}

function desktopObservationResolution(enabled: boolean, observerTarget: string | null): string {
  if (!enabled) {
    return 'disabled';
  }
  return observerTarget === null ? 'waiting-for-eligible-model' : 'resolved';
}
/**
 * Ollama and LM Studio models are discovered live from the local server: the
 * picker offers exactly what the runtime lists, and neither the models table
 * nor the static catalog holds them. A run on one is budgeted at the
 * conservative window the picker declares for every discovered model.
 */
function localRuntimeModelDefinition(model: string): DesktopCatalogSelection['definition'] {
  if (model.length === 0) {
    throw new Error('The selected local runtime model has no id');
  }
  return {
    contextWindow: DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW,
    id: model,
    supportsStreaming: true,
    type: 'llm',
    vision: 'unknown',
  };
}

async function readDesktopCatalogSelection(
  db: Awaited<ReturnType<typeof getDatabase>>,
  modelId: string
): Promise<DesktopCatalogSelection> {
  const separator = modelId.indexOf('::');
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 2);
  if (separator < 1 || !isSupportedProvider(provider)) {
    throw new Error('The selected model has no supported catalog identity');
  }
  if (findProviderDefinition(provider)?.runtime === 'local') {
    return { definition: localRuntimeModelDefinition(model), model, provider };
  }
  // The UI composite is a selection key. The existing catalog owns the pair.
  const result = await db.query(
    'SELECT provider_id AS "providerId", is_enabled AS "isEnabled" FROM models WHERE id = $1 AND provider_id = $2',
    [model, provider]
  );
  const row = z
    .strictObject({ isEnabled: z.boolean(), providerId: z.string() })
    .parse(result.rows[0]);
  if (!row.isEnabled) {
    throw new Error('The selected catalog model is disabled');
  }
  if (row.providerId !== provider) {
    throw new Error('The selected model identity does not match its catalog provider');
  }
  const definition = findLlmModelDefinition(provider, model);
  if (!definition) {
    throw new Error('The selected catalog model has no resolved runtime budget');
  }
  return { definition, model, provider };
}

async function readDesktopIntent(
  request: HostRunAdmissionRequest,
  catalog: DesktopCatalogSelection,
  readPersistedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>,
  readCliOwnerIntent?: DesktopCliOwnerIntentReader
): Promise<z.output<typeof PlatformClientConfigurationSchema>> {
  const workspaceInput = readCliWorkspaceRunInput(request.configuration);
  if (workspaceInput) {
    if (request.snapshot) {
      const committed = PlatformClientConfigurationSchema.parse(
        request.snapshot.configuration['intent']
      );
      if (!isDeepStrictEqual(committed.cliWorkspace, workspaceInput.workspace)) {
        throw new Error('CLI workspace recovery does not match its committed selection');
      }
      return committed;
    }
    // BST-1943: a subset envelope previously replaced settings with construction defaults.
    if (!readCliOwnerIntent) {
      throw new Error(
        '[ERR_CLI_WORKSPACE_OWNER_INTENT_UNAVAILABLE] CLI workspace reduction requires the existing full intent owner'
      );
    }
    request.signal.throwIfAborted();
    const ownerIntent = await readCliOwnerIntent(request);
    request.signal.throwIfAborted();
    if (ownerIntent === undefined || ownerIntent === null) {
      throw new Error(
        '[ERR_CLI_WORKSPACE_OWNER_INTENT_UNAVAILABLE] The full intent owner supplied no CLI intent'
      );
    }
    return PlatformClientConfigurationSchema.parse(
      materializeCliWorkspaceIntent(
        PlatformClientConfigurationSchema.parse(ownerIntent),
        workspaceInput.workspace
      )
    );
  }
  const captured = request.configuration ?? request.snapshot?.configuration['intent'];
  return PlatformClientConfigurationSchema.parse(
    captured ?? {
      enabledNativeToolIds: DESKTOP_NATIVE_TOOLS.map((tool) => tool.id),
      memoryOptions: {
        lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
        workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
      },
      memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      modelConfiguration: { model: catalog.model, provider: catalog.provider },
      permissionPolicy: (await readPersistedPolicy?.()) ?? {
        policies: DEFAULT_PERMISSION_POLICIES,
        yolo: false,
      },
      workspaceInstructionsPreference: { masterEnabled: true, oversizedOptInByRootId: {} },
    }
  );
}

/** The chat provider's own auto-observer candidates, in preference order (never another provider). */
function autoObserverCandidates(provider: string): readonly string[] {
  return listAutoObservationalMemoryCandidates({
    chatProvider: provider,
    providersWithKeys: [provider],
  });
}

/**
 * The auto-observer candidates the model catalog has enabled: provider and
 * model rows enabled and the model an LLM, the gate the memory settings
 * dropdown applies (main's resolveEffectiveObservationalMemorySettings).
 */
async function readEnabledObserverCandidates(
  db: Awaited<ReturnType<typeof getDatabase>>,
  candidates: readonly string[]
): Promise<ReadonlySet<string>> {
  if (candidates.length === 0) {
    return new Set();
  }
  const pairs = candidates.map((candidate) => {
    const separator = candidate.indexOf('/');
    return { modelId: candidate.slice(separator + 1), provider: candidate.slice(0, separator) };
  });
  const result = await db.query(
    `SELECT m.provider_id AS "providerId", m.id AS "modelId"
       FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE p.is_enabled = true AND m.is_enabled = true
        AND (m.capabilities::jsonb)->>'type' = 'llm'
        AND m.provider_id = ANY($1) AND m.id = ANY($2)`,
    [[...new Set(pairs.map((pair) => pair.provider))], pairs.map((pair) => pair.modelId)]
  );
  const rows = z
    .array(z.strictObject({ modelId: z.string(), providerId: z.string() }))
    .parse(result.rows);
  return new Set(rows.map((row) => `${row.providerId}/${row.modelId}`));
}

/** A disabled observer resolves no target, so the catalog is read only for an enabled auto one. */
function readEnabledObservers(
  db: Awaited<ReturnType<typeof getDatabase>>,
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  provider: string
): Promise<ReadonlySet<string>> {
  const observation = intent.memorySettings.observationalMemory;
  return observation.enabled && observation.modelTarget === 'auto'
    ? readEnabledObserverCandidates(db, autoObserverCandidates(provider))
    : Promise.resolve(new Set());
}

function resolveDesktopMemorySettings(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  provider: string,
  enabledObservers: ReadonlySet<string>
): {
  memorySettings: z.output<typeof PlatformClientConfigurationSchema>['memorySettings'];
  observerTarget: string | null;
} {
  const observation = intent.memorySettings.observationalMemory;
  // Auto picks the first enabled candidate of the chat provider; none waits, disabled.
  const observerTarget =
    observation.modelTarget === 'auto'
      ? (autoObserverCandidates(provider).find((candidate) => enabledObservers.has(candidate)) ??
        null)
      : observation.modelTarget;
  const memorySettings = {
    ...intent.memorySettings,
    observationalMemory:
      observerTarget === null
        ? { ...observation, enabled: false }
        : { ...observation, modelTarget: observerTarget },
  };
  return { memorySettings, observerTarget };
}

/** The admitted Memory selection; observations wait when 'auto' found no candidate. */
function desktopMemorySelection(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  settings: z.output<typeof PlatformClientConfigurationSchema>['memorySettings'],
  observerTarget: string | null,
  vectors: DesktopMemoryVectorSelection | undefined
): DesktopPlatformSelection['memory'] {
  return {
    ...(intent.memorySettings.observationalMemory.enabled && observerTarget === null
      ? { observerAwaiting: 'no-hosted-chat-provider' as const }
      : {}),
    options: intent.memoryOptions,
    settings,
    ...(vectors ? { vectorProfile: vectors.profile } : {}),
  };
}

/** Catalog dimensions of the recall embedder: hosted from the registry, local from the DB catalog. */
async function readEmbeddingDimensions(
  db: Awaited<ReturnType<typeof getDatabase>>,
  provider: string,
  modelId: string
): Promise<number> {
  if (provider !== 'local') {
    const model = isSupportedProvider(provider)
      ? listEmbeddingModels(provider).find((candidate) => candidate.id === modelId)
      : undefined;
    if (!model) {
      throw new Error(`Embedding model "${provider}/${modelId}" is not in the provider catalog.`);
    }
    return model.defaultDimension;
  }
  // The same catalog row the legacy local recall embedder read its dimensions from.
  const result = await db.query(
    'SELECT capabilities FROM models WHERE id = $1 AND provider_id = $2 LIMIT 1',
    [modelId, 'local']
  );
  const row = z
    .object({ capabilities: z.union([z.string(), z.record(z.string(), z.unknown())]) })
    .optional()
    .parse(result.rows[0]);
  if (!row) {
    throw new Error(`Local embedding model "${modelId}" is not in the model catalog.`);
  }
  return z
    .object({ defaultDimension: z.number().int().positive() })
    .parse(typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities)
    .defaultDimension;
}

function desktopContextReader(
  request: HostRunAdmissionRequest,
  readRoots: () => Promise<NonNullable<RuntimeData['workspaceRoots']>>,
  restricted: boolean
): WorkspaceFileReader {
  // BST-1943: final context validation allowed a later read after revocation.
  return async (args) => {
    request.signal.throwIfAborted();
    const currentRoots = await readRoots();
    if (restricted && !currentRoots.some((root) => root.path === args.rootPath)) {
      throw new Error('Context reader root is outside the admitted workspace selection');
    }
    request.signal.throwIfAborted();
    const result = await readWorkspaceTextFile(args);
    await readRoots();
    request.signal.throwIfAborted();
    return result;
  };
}

async function createDesktopNativeTools(
  db: Awaited<ReturnType<typeof getDatabase>>,
  configuration: z.output<typeof PlatformModelConfigurationSchema>,
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  { resolveForgeService, resolveWorktreeService, ...dependencies }: DesktopHostToolServices,
  budget: ReturnType<typeof resolveScaledToolResultBudget>,
  request: HostRunAdmissionRequest,
  workspace?: DesktopWorkspaceBindingBorrow
): Promise<{
  /** The enabled skills of the run's one scan, admitted to the host. */
  readonly admittedSkills: readonly import('@brainstrike/agent').ScannedSkill[] | undefined;
  readonly freshRoots: () => Promise<NonNullable<RuntimeData['workspaceRoots']>>;
  /** Retrieval is admitted to the thread's own roots (a CLI selection or a binding). */
  readonly retrievalRootsOnly: boolean;
  readonly readWorkspaceFile: WorkspaceFileReader;
  readonly revalidateWorkspace: () => Promise<void>;
  readonly runtime: RuntimeData;
  readonly tools: Record<string, import('@brainstrike/agent-host').HostTool>;
  readonly workspaceSkills?: import('@brainstrike/agent').ScannedWorkspaceSkills;
}> {
  request.signal.throwIfAborted();
  const liveRoots = await loadWorkspaceRootsFromDatabase(db);
  request.signal.throwIfAborted();
  const selection = intent.cliWorkspace;
  const bindingRoots = workspace ? [...workspace.roots] : liveRoots;
  const roots = selection ? selectCliWorkspaceRoots(bindingRoots, selection) : bindingRoots;
  if (selection && request.snapshot) {
    const capturedRoots = CliWorkspaceRootsSchema.parse(
      request.snapshot.configuration['cliWorkspaceRoots']
    );
    revalidateCliWorkspaceRoots(capturedRoots, liveRoots, selection);
  }
  const freshRoots = async (): Promise<typeof roots> => {
    await workspace?.revalidate(request.signal);
    if (!selection) {
      return roots;
    }
    request.signal.throwIfAborted();
    const current = await loadWorkspaceRootsFromDatabase(db);
    request.signal.throwIfAborted();
    return revalidateCliWorkspaceRoots(roots, current, selection);
  };
  const revalidateWorkspace = async (): Promise<void> => {
    await freshRoots();
  };
  const retrievalRootsOnly = selection !== undefined || workspace !== undefined;
  const readWorkspaceFile = desktopContextReader(request, freshRoots, retrievalRootsOnly);
  const focused = roots.find((root) => root.rootId === intent.selectionFolderId);
  if (intent.selectionFolderId && !focused) {
    throw new Error('The selected workspace root is no longer mounted');
  }
  const runtime: RuntimeData = {
    model: configuration.model,
    provider: configuration.provider,
    ...(configuration.modelSettings ? { modelSettings: configuration.modelSettings } : {}),
    ...(configuration.providerOptions ? { providerOptions: configuration.providerOptions } : {}),
    enabledNativeToolIds: intent.enabledNativeToolIds,
    ...(intent.workspaceContext
      ? {
          workspaceContext: JSON.parse(JSON.stringify(intent.workspaceContext)) as NonNullable<
            RuntimeData['workspaceContext']
          >,
        }
      : {}),
    workspaceInstructionsPreference: intent.workspaceInstructionsPreference,
    workspaceRoots: roots,
    ...(request.workspaceBinding?.operatingRootId
      ? { boundWorkspaceRootId: request.workspaceBinding.operatingRootId }
      : {}),
    ...(focused
      ? {
          selectionFilePaths:
            intent.workspaceContext?.files
              .filter((file) => file.rootId === focused.rootId)
              .map((file) => file.path) ?? [],
          selectionFolderId: focused.rootId,
          workspaceRootPath: focused.path,
        }
      : {}),
    ...(intent.skillsPreference ? { skillsPreference: intent.skillsPreference } : {}),
  };
  const { skills: admittedSkills, workspaceSkills } = desktopRunSkills(
    selection !== undefined,
    intent,
    runtime,
    roots
  );
  const skillTools = workspaceSkills ? createAssistantSkillTools(workspaceSkills) : {};
  const nativeBindings = Object.fromEntries(
    [
      ...DESKTOP_NATIVE_TOOLS,
      ...Object.keys(skillTools).map(
        (id) => NATIVE_TOOL_REGISTRIES.byId[id as 'skill' | 'skill_read' | 'skill_search']
      ),
    ].map((tool) => [tool.id, { identity: tool.id, risk: resolveToolRiskCategory(tool.defaults) }])
  );
  const build = (context?: HostToolContext, currentRoots = roots) =>
    createAgentHostToolBindings({
      bindings: nativeBindings,
      resolvedToolResultBudget: budget,
      tools: {
        ...buildDesktopAssistantTools(
          {
            ...runtime,
            workspaceRoots: currentRoots,
            ...(context
              ? {
                  memory: {
                    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
                    runId: context.runId,
                    threadId: context.threadId,
                  },
                }
              : {}),
          },
          {
            ...dependencies,
            ...desktopWorktreeToolDependencies(
              { resolveForgeService, resolveWorktreeService },
              { runId: context?.runId, threadId: context?.threadId }
            ),
            ...desktopRetrievalScopeFields(retrievalRootsOnly, currentRoots),
            ...(workspaceSkills ? { skillScriptResolver: workspaceSkills } : {}),
            resolvedToolResultBudget: budget,
            // The host owns committed outputs: it executes the artifact reader.
            toolOutputArtifactReader: HOST_EXECUTED_ARTIFACT_READER,
          }
        ),
        ...skillTools,
      },
    });
  const native = build();
  const tools = Object.fromEntries(
    advertisedNativeTools(native.tools, resolveWorktreeService).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: async (input: unknown, context: HostToolContext): Promise<unknown> => {
          context.signal.throwIfAborted();
          const currentRoots = await freshRoots();
          context.signal.throwIfAborted();
          const executor = build(context, currentRoots).tools[name];
          if (!executor || executor.identity !== tool.identity) {
            throw new Error('Native executor changed after admission');
          }
          const result = await executor.execute(input, context);
          if (selection || workspace) {
            await revalidateWorkspace();
            context.signal.throwIfAborted();
          }
          return result;
        },
      },
    ])
  );
  return {
    admittedSkills,
    freshRoots,
    readWorkspaceFile,
    retrievalRootsOnly,
    revalidateWorkspace,
    runtime,
    tools,
    ...(workspaceSkills ? { workspaceSkills } : {}),
  };
}

/** A CLI selection runs without skills; otherwise one scan feeds the prompt and the host's skill tools. */
function desktopRunSkills(
  cliSelection: boolean,
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  runtime: RuntimeData,
  roots: readonly { readonly path: string }[]
): PreparedAdmittedSkills {
  if (!cliSelection) {
    return prepareAdmittedSkills({
      fs: createSecureSkillsFs([...roots.map((root) => root.path), homedir()]),
      homedir,
      runtimeData: runtime,
    });
  }
  if (intent.skillsPreference?.masterEnabled ?? true) {
    throw new Error('CLI Skills require an explicit existing home-tier read authority');
  }
  return {};
}

/** Main's tool services for host threads, resolved per run (the worktree services lazily). */
export type DesktopHostToolServices = DesktopAssistantToolDependencies & DesktopWorktreeServices;

const WORKTREE_TOOL_IDS: ReadonlySet<string> = new Set([
  NATIVE_TOOL_ID.listWorktrees,
  NATIVE_TOOL_ID.manageWorktree,
]);

/** A worktree tool without Main's worktree service cannot run, so it is not advertised. */
function advertisedNativeTools(
  tools: Readonly<Record<string, HostTool>>,
  resolveWorktreeService: DesktopWorktreeServices['resolveWorktreeService']
): [string, HostTool][] {
  const entries = Object.entries(tools);
  if (resolveWorktreeService?.()) {
    return entries;
  }
  return entries.filter(([, tool]) => !WORKTREE_TOOL_IDS.has(tool.permissionToolId ?? ''));
}

/** Main only describes the host's artifact reader; the host executes it over its own log. */
const HOST_EXECUTED_ARTIFACT_READER: ScopedToolOutputArtifactReader = {
  readRange: () => {
    throw new Error('The tool output artifact reader executes in the agent host');
  },
};

/** Plan mode admits only the plan-mode tool set; the built-in local provider has no plan mode. */
function desktopRunTools(
  tools: Readonly<Record<string, HostTool>>,
  request: HostRunAdmissionRequest,
  provider: string
): Readonly<Record<string, HostTool>> {
  if (!request.planMode) {
    return tools;
  }
  if (provider === 'local') {
    throw new Error('Plan mode is unavailable for the built-in local provider');
  }
  return desktopPlanModeTools(tools);
}

async function readLocalEmbeddingHostDevice(
  read: ((signal: AbortSignal) => Promise<'webgpu' | 'wasm'>) | undefined,
  signal: AbortSignal
): Promise<'webgpu' | 'wasm'> {
  if (!read) {
    throw new Error('Local Memory vectors require the embedding host');
  }
  return await read(signal);
}

/** BST-1932: the supervisor instructions name only the personas this run may delegate to. */
function desktopPersonaFields(delegation: HostDelegation | undefined): {
  readonly personas?: HostDelegation['personas'];
} {
  return delegation ? { personas: delegation.personas } : {};
}

/** BST-1932: the child context and personas a run delegates with, when it may delegate. */
function desktopDelegationFields(
  childSystem: string | undefined,
  delegation: HostDelegation | undefined
): Pick<DesktopPlatformSelection, 'childSystem' | 'delegation'> {
  return {
    ...(childSystem === undefined ? {} : { childSystem }),
    ...(delegation ? { delegation } : {}),
  };
}

/** Lazy borrows: Root/New Thread never waits for indexing or credential initialization. */
export function productionDesktopCapabilities(
  dependencies: DesktopHostToolServices,
  readPersistedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>,
  readCliOwnerIntent?: DesktopCliOwnerIntentReader,
  workspaceAuthority?: DesktopWorkspaceBindingAuthority,
  readLocalEmbeddingDevice?: (signal: AbortSignal) => Promise<'webgpu' | 'wasm'>
): Omit<DesktopPlatformCapabilities, 'mcp' | 'readLegacyMemory'> {
  const policies = new Map<string, PermissionToolGateSnapshot>();
  // A host thread's session grants are the host's own (permission.granted);
  // no renderer store reaches its decisions.
  const readHostPermissionPolicy = async (threadId?: string) => {
    const captured = threadId ? policies.get(threadId) : undefined;
    const persisted = await readPersistedPolicy?.();
    const { sessionGrants: _sessionGrants, ...policy } = platformPermissionPolicy(
      persisted ?? captured ?? { policies: DEFAULT_PERMISSION_POLICIES, yolo: false }
    );
    return policy;
  };
  /**
   * The admission's pure preconditions: the catalog model and captured
   * settings, observer resolution and the recall-embedder plan. A run
   * admission and thread/memory/read both start here; nothing is acquired.
   */
  const readPreconditions = async (request: HostRunAdmissionRequest) => {
    const db = await getDatabase();
    request.signal.throwIfAborted();
    const catalog = await readDesktopCatalogSelection(db, request.modelId);
    const intent = await readDesktopIntent(
      request,
      catalog,
      readPersistedPolicy,
      readCliOwnerIntent
    );
    const configuration = PlatformModelConfigurationSchema.parse(intent.modelConfiguration);
    if (configuration.provider !== catalog.provider || configuration.model !== catalog.model) {
      throw new Error('Captured settings do not belong to the selected catalog model');
    }
    const inputTokenLimit = desktopInputTokenLimit(catalog.definition, intent, configuration);
    const { memorySettings, observerTarget } = resolveDesktopMemorySettings(
      intent,
      configuration.provider,
      await readEnabledObservers(db, intent, configuration.provider)
    );
    const memoryVectors = await resolveDesktopMemoryVectors(memorySettings, {
      readDimensions: (provider, modelId) => readEmbeddingDimensions(db, provider, modelId),
      readLocalDevice: () => readLocalEmbeddingHostDevice(readLocalEmbeddingDevice, request.signal),
    });
    request.signal.throwIfAborted();
    const memory = desktopMemorySelection(intent, memorySettings, observerTarget, memoryVectors);
    return {
      catalog,
      configuration,
      db,
      inputTokenLimit,
      intent,
      memory,
      memoryVectors,
      observerTarget,
    };
  };
  const readConfiguration = async (
    request: HostRunAdmissionRequest,
    workspace?: DesktopWorkspaceBindingBorrow
  ): Promise<DesktopPlatformSelection> => {
    const {
      catalog,
      configuration,
      db,
      inputTokenLimit,
      intent,
      memory,
      memoryVectors,
      observerTarget,
    } = await readPreconditions(request);
    const { definition } = catalog;
    const permissionPolicy = platformPermissionPolicy(intent.permissionPolicy);
    const budget = resolveScaledToolResultBudget(definition.contextWindow);
    const native = await createDesktopNativeTools(
      db,
      configuration,
      intent,
      dependencies,
      budget,
      request,
      workspace
    );
    const tools = desktopRunTools(native.tools, request, configuration.provider);
    const resilience = resolveAssistantResilienceConfig();
    // MCP tools are composed and executed by the Node host's own MCP runtime.
    const close = (): Promise<void> => {
      if (policies.get(request.threadId) === permissionPolicy) {
        policies.delete(request.threadId);
      }
      return Promise.resolve();
    };
    try {
      policies.set(request.threadId, permissionPolicy);
      const delegation = resolveDesktopHostDelegation(
        intent,
        configuration.provider,
        native.runtime.workspaceRoots ?? [],
        request.planMode === true
      );
      // The host never offers what the saved policy denies; the instructions never name it.
      const policy = await readHostPermissionPolicy(request.threadId);
      const { childSystem, system } = await readDesktopHostSystemContext({
        inputTokenLimit,
        ...desktopPersonaFields(delegation),
        ...desktopContextReaderFields(
          intent.cliWorkspace !== undefined || workspace !== undefined,
          native.readWorkspaceFile
        ),
        planMode: request.planMode === true,
        request,
        runtime: native.runtime,
        tools: Object.fromEntries(
          Object.entries(tools).filter(
            ([name, tool]) => !isPermissionDenied(policy, tool.risk, tool.permissionToolId ?? name)
          )
        ),
        ...(native.workspaceSkills ? { workspaceSkills: native.workspaceSkills } : {}),
      });
      await native.revalidateWorkspace();
      return {
        close,
        configuration,
        contextWindow: definition.contextWindow,
        durableConfiguration: desktopDurableConfiguration(
          intent,
          observerTarget,
          { childSystem, system },
          intent.cliWorkspace ? native.runtime.workspaceRoots : undefined,
          desktopWorkspaceRootObservation(workspace)
        ),
        ...desktopDelegationFields(childSystem, delegation),
        freshWorkspaceRoots: native.freshRoots,
        inputTokenLimit,
        maxSteps: intent.agentLoop?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
        memory,
        ...(memoryVectors?.local ? { localEmbedding: memoryVectors.local } : {}),
        nativeRuntime: desktopNativeRuntime(
          native.runtime,
          native.retrievalRootsOnly,
          native.admittedSkills
        ),
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        ...desktopSystemFields(system),
        tools,
        toolTimeoutMs: resilience.toolTimeoutMs,
        ...desktopWorkspaceSelectionFields(request, workspace),
      };
    } catch (cause) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Desktop configuration and cleanup failed');
      }
      throw cause;
    }
  };
  return {
    ...(workspaceAuthority
      ? { validateWorkspaceBinding: workspaceAuthority.validateWorkspaceBinding }
      : {}),
    hostTools: desktopHostToolServices(dependencies),
    readConfiguration: async (request) => {
      let workspace: DesktopWorkspaceBindingBorrow | undefined;
      if (request.workspaceBinding && changesThreadWorkspaceScope(request.workspaceBinding)) {
        if (!workspaceAuthority) {
          throw new Error('Desktop run has no live workspace binding owner');
        }
        workspace = await workspaceAuthority.acquire({
          binding: request.workspaceBinding,
          signal: request.signal,
          threadId: request.threadId,
        });
      }
      try {
        if (workspace && request.snapshot) {
          const captured = CliWorkspaceRootsSchema.parse(
            request.snapshot.configuration['boundWorkspaceRoots']
          );
          revalidateCliWorkspaceRoots(captured, [...workspace.roots], {
            instructions: 'off',
            rootIds: captured.map((root) => root.rootId),
            skills: 'off',
          });
          if (captured.length !== workspace.roots.length) {
            throw new Error(
              'Recovered workspace binding cannot widen its committed root observation'
            );
          }
        }
        const selected = await readConfiguration(request, workspace);
        let closing: Promise<void> | undefined;
        return {
          ...selected,
          ...(workspace
            ? { revalidateWorkspace: (signal: AbortSignal) => workspace.revalidate(signal) }
            : {}),
          close: () =>
            (closing ??= (async () => {
              const results = await Promise.allSettled([
                selected.close(),
                ...(workspace ? [workspace.close()] : []),
              ]);
              const failures = results.flatMap((result) =>
                result.status === 'rejected' ? [result.reason] : []
              );
              if (failures.length > 0) {
                throw new AggregateError(
                  failures,
                  'Desktop selection and workspace retirement failed'
                );
              }
            })()),
        };
      } catch (cause) {
        try {
          await workspace?.close();
        } catch (cleanup) {
          throw new AggregateError(
            [cause, cleanup],
            'Desktop selection and workspace acquisition failed'
          );
        }
        throw cause;
      }
    },
    // A precondition failure is the reason run/start would fail with.
    readMemoryReadiness: async (request) => {
      try {
        const { memory } = await readPreconditions(request);
        return { memory, ready: true, resourceId: WORKSPACE_MEMORY_RESOURCE_ID };
      } catch (cause) {
        request.signal.throwIfAborted();
        return { ready: false, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    readPermissionPolicy: readHostPermissionPolicy,
    ...(dependencies.embeddingHostManager
      ? { localEmbedding: dependencies.embeddingHostManager }
      : {}),
    resolveWorkspaceRoot: async (rootId) => {
      const root = (await loadWorkspaceRootsFromDatabase(await getDatabase())).find(
        (candidate) => candidate.rootId === rootId
      );
      if (!root) {
        throw new Error('The workspace root is no longer mounted');
      }
      return root.path;
    },
  };
}
