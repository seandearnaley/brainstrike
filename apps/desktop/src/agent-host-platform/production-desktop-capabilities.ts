import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  createAssistantSkillTools,
  isSupportedProvider,
  type RuntimeData,
  resolveAssistantResilienceConfig,
} from '@brainstrike/agent';
import {
  DEFAULT_AGENT_MAX_STEPS,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import type { HostRunAdmissionRequest, HostToolContext } from '@brainstrike/agent-host';
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
  resolveAutoObservationalMemoryModelTarget,
  resolveToolRiskCategory,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { listEmbeddingModels } from '@brainstrike/assistant-contract/provider-metadata';
import { changesThreadWorkspaceScope } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-repository';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/stream-init';
import type { SelectedEmbeddingRequestPlan } from '@brainstrike/embeddings/inference-plan';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/native-tools';
import { z } from 'zod';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';
import {
  buildDesktopAssistantTools,
  type DesktopAssistantToolDependencies,
} from '../assistant-server/assistant-tools';
import { prepareRequestSkills } from '../assistant-server/request-skills';
import { createSecureSkillsFs } from '../assistant-server/skills-fs-deps';
import { loadWorkspaceRootsFromDatabase } from '../assistant-server/workspace-roots';
import { getDatabase } from '../db-main';
import { readDesktopHostSystemContext } from './desktop-host-context';
import type {
  DesktopWorkspaceBindingAuthority,
  DesktopWorkspaceBindingBorrow,
} from './desktop-workspace-binding';
import type { DesktopPlatformCapabilities, DesktopPlatformSelection } from './main-platform';
import { resolveDesktopMemoryVectors } from './memory-vector-selection';
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
  system: string | undefined,
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

function resolveDesktopMemorySettings(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  provider: string
): {
  memorySettings: z.output<typeof PlatformClientConfigurationSchema>['memorySettings'];
  observerTarget: string | null;
} {
  const observation = intent.memorySettings.observationalMemory;
  const observerTarget =
    observation.modelTarget === 'auto'
      ? resolveAutoObservationalMemoryModelTarget({
          chatProvider: provider,
          providersWithKeys: [provider],
        })
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
  dependencies: DesktopAssistantToolDependencies,
  budget: ReturnType<typeof resolveScaledToolResultBudget>,
  request: HostRunAdmissionRequest,
  workspace?: DesktopWorkspaceBindingBorrow
): Promise<{
  readonly freshRoots: () => Promise<NonNullable<RuntimeData['workspaceRoots']>>;
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
  const readWorkspaceFile = desktopContextReader(
    request,
    freshRoots,
    selection !== undefined || workspace !== undefined
  );
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
  if (selection && (intent.skillsPreference?.masterEnabled ?? true)) {
    throw new Error('CLI Skills require an explicit existing home-tier read authority');
  }
  const { workspaceSkills } = selection
    ? {}
    : prepareRequestSkills({
        fs: createSecureSkillsFs([...roots.map((root) => root.path), homedir()]),
        homedir,
        runtimeData: runtime,
      });
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
            ...desktopRetrievalScopeFields(
              selection !== undefined || workspace !== undefined,
              currentRoots
            ),
            ...(workspaceSkills ? { skillScriptResolver: workspaceSkills } : {}),
            resolvedToolResultBudget: budget,
          }
        ),
        ...skillTools,
      },
    });
  const native = build();
  const tools = Object.fromEntries(
    Object.entries(native.tools).map(([name, tool]) => [
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
    freshRoots,
    readWorkspaceFile,
    revalidateWorkspace,
    runtime,
    tools,
    ...(workspaceSkills ? { workspaceSkills } : {}),
  };
}

/** What the host's shared native tools need from this admission; roots come back per call. */
function desktopNativeRuntime(runtime: RuntimeData): DesktopPlatformSelection['nativeRuntime'] {
  if (typeof runtime.provider !== 'string' || !runtime.workspaceRoots) {
    throw new Error('Desktop admission has no native tool runtime');
  }
  return {
    ...(runtime.boundWorkspaceRootId ? { boundWorkspaceRootId: runtime.boundWorkspaceRootId } : {}),
    provider: runtime.provider,
    ...(runtime.selectionFolderId ? { selectionFolderId: runtime.selectionFolderId } : {}),
    ...(runtime.workspaceRootPath ? { workspaceRootPath: runtime.workspaceRootPath } : {}),
    workspaceRoots: runtime.workspaceRoots.map(({ displayName, path, rootId }) => ({
      displayName,
      path,
      rootId,
    })),
  };
}

/** Lazy borrows: Root/New Thread never waits for indexing or credential initialization. */
export function productionDesktopCapabilities(
  dependencies: DesktopAssistantToolDependencies,
  readPersistedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>,
  readCliOwnerIntent?: DesktopCliOwnerIntentReader,
  workspaceAuthority?: DesktopWorkspaceBindingAuthority,
  readLocalEmbeddingSelection?: () => Promise<SelectedEmbeddingRequestPlan | undefined>
): Omit<DesktopPlatformCapabilities, 'mcp'> {
  const policies = new Map<string, PermissionToolGateSnapshot>();
  const readConfiguration = async (
    request: HostRunAdmissionRequest,
    workspace?: DesktopWorkspaceBindingBorrow
  ): Promise<DesktopPlatformSelection> => {
    const db = await getDatabase();
    request.signal.throwIfAborted();
    const catalog = await readDesktopCatalogSelection(db, request.modelId);
    const { definition } = catalog;
    const intent = await readDesktopIntent(
      request,
      catalog,
      readPersistedPolicy,
      readCliOwnerIntent
    );
    const configuration = PlatformModelConfigurationSchema.parse(intent.modelConfiguration);
    const permissionPolicy = platformPermissionPolicy(intent.permissionPolicy);
    if (configuration.provider !== catalog.provider || configuration.model !== catalog.model) {
      throw new Error('Captured settings do not belong to the selected catalog model');
    }
    const inputTokenLimit = desktopInputTokenLimit(definition, intent, configuration);
    const { memorySettings, observerTarget } = resolveDesktopMemorySettings(
      intent,
      configuration.provider
    );
    const memoryVectors = await resolveDesktopMemoryVectors(memorySettings, {
      readDimensions: (provider, modelId) => readEmbeddingDimensions(db, provider, modelId),
      readLocalSelection: async () => {
        if (!readLocalEmbeddingSelection) {
          throw new Error('Local Memory vectors require the saved local execution selection');
        }
        return await readLocalEmbeddingSelection();
      },
    });
    request.signal.throwIfAborted();
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
    const { tools } = native;
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
      const system = await readDesktopHostSystemContext({
        inputTokenLimit,
        ...desktopContextReaderFields(
          intent.cliWorkspace !== undefined || workspace !== undefined,
          native.readWorkspaceFile
        ),
        request,
        runtime: native.runtime,
        tools,
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
          system,
          intent.cliWorkspace ? native.runtime.workspaceRoots : undefined,
          desktopWorkspaceRootObservation(workspace)
        ),
        freshWorkspaceRoots: native.freshRoots,
        inputTokenLimit,
        maxSteps: intent.agentLoop?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
        memory: {
          options: intent.memoryOptions,
          settings: memorySettings,
          ...(memoryVectors ? { vectorProfile: memoryVectors.profile } : {}),
        },
        ...(memoryVectors?.local ? { localEmbedding: memoryVectors.local } : {}),
        nativeRuntime: desktopNativeRuntime(native.runtime),
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
    readPermissionPolicy: async (threadId) => {
      const captured = threadId ? policies.get(threadId) : undefined;
      const persisted = await readPersistedPolicy?.();
      return platformPermissionPolicy(
        persisted
          ? {
              ...persisted,
              ...(captured?.sessionGrants ? { sessionGrants: captured.sessionGrants } : {}),
            }
          : (captured ?? { policies: DEFAULT_PERMISSION_POLICIES, yolo: false })
      );
    },
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
