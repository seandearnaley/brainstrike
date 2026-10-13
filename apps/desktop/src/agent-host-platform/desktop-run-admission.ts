import { homedir } from 'node:os';
import { type RuntimeData, resolveAssistantResilienceConfig } from '@brainstrike/agent';
import { DEFAULT_AGENT_MAX_STEPS } from '@brainstrike/agent/tool-runtime';
import type {
  HostDelegation,
  HostRunAdmissionRequest,
  HostRunIntentRequest,
} from '@brainstrike/agent-host';
import {
  CliWorkspaceRootsSchema,
  revalidateCliWorkspaceRoots,
  selectCliWorkspaceRoots,
} from '@brainstrike/agent-host/standalone-workspace-input';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import {
  DEFAULT_PERMISSION_POLICIES,
  isPermissionDenied,
  refusalError,
} from '@brainstrike/assistant-contract';
import { changesThreadWorkspaceScope } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/ports';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/workspace-text-file-reader';
import { z } from 'zod';
import {
  type PreparedAdmittedSkills,
  prepareAdmittedSkills,
} from '../assistant-server/request-skills';
import { createSecureSkillsFs } from '../assistant-server/skills-fs-deps';
import {
  type DesktopHostSystemContext,
  desktopPlanModeTools,
  readDesktopHostSystemContext,
} from './desktop-host-context';
import { resolveDesktopHostDelegation } from './desktop-host-delegation';
import {
  desktopInputTokenLimit,
  desktopMemorySelection,
  readDesktopCatalogSelection,
  readDesktopIntent,
  readEnabledObservers,
  resolveDesktopMemorySettings,
} from './desktop-run-preconditions';
import { type DesktopToolDescriptor, desktopToolDescriptors } from './desktop-tool-descriptors';
import type { DesktopWorkspaceBindingBorrow } from './desktop-workspace-binding';
import type { DesktopMemoryVectorSelection } from './memory-vector-selection';
import {
  PlatformAdmittedSkillSchema,
  type PlatformClientConfigurationSchema,
  type PlatformMemoryReadinessSchema,
  PlatformModelConfigurationSchema,
  type PlatformSelection,
  PlatformWorkspaceContextSchema,
  platformPermissionPolicy,
} from './platform-wire';

type RuntimeWorkspaceRoots = NonNullable<RuntimeData['workspaceRoots']>;

/**
 * What a desktop run's admission reads from the facts Main owns (BST-1930
 * stage e): the model catalog, live roots and their binding leases, the
 * worktree service, and the recall embedder Main's embedding host resolves. The agent host composes the admission from them;
 * Main serves each read and holds no selection.
 */
export interface DesktopAdmissionReads {
  /** Borrows a thread's bound workspace for the run; close returns it. */
  acquireWorkspace(request: {
    readonly binding: NonNullable<HostRunAdmissionRequest['workspaceBinding']>;
    readonly signal: AbortSignal;
    readonly threadId: string;
  }): Promise<DesktopWorkspaceBindingBorrow>;
  /** The selected model's catalog row; null when the catalog has no such model. */
  catalogModel(
    target: { readonly model: string; readonly provider: string },
    signal: AbortSignal
  ): Promise<{ readonly isEnabled: boolean; readonly providerId: string } | null>;
  /** The full intent a CLI workspace selection reduces; absent where no owner supplies one. */
  cliOwnerIntent?(request: HostRunIntentRequest): Promise<unknown>;
  /** The candidates whose provider and model rows are enabled and whose model is an LLM. */
  enabledObservers(candidates: readonly string[], signal: AbortSignal): Promise<readonly string[]>;
  /** The profile's mounted workspace roots. */
  liveWorkspaceRoots(signal: AbortSignal): Promise<RuntimeWorkspaceRoots>;
  /** The recall embedder the memory settings select, resolved by Main's embedding host. */
  memoryVectors(
    settings: PlatformSelection['memory']['settings'],
    signal: AbortSignal
  ): Promise<DesktopMemoryVectorSelection | undefined>;
  /** Whether the desktop's worktree service is running. */
  worktreesAvailable(signal: AbortSignal): Promise<boolean>;
}

/** One admitted desktop run: the selection, its live roots and its release. */
export interface DesktopRunSelection extends Omit<PlatformSelection, 'delegation'> {
  close(): Promise<void>;
  /** BST-1932: the personas and subagent limits this run may delegate with. */
  readonly delegation?: HostDelegation | undefined;
  /** The admitted roots revalidated against their live owners, for the host's shared tools. */
  freshWorkspaceRoots(): Promise<RuntimeWorkspaceRoots>;
  /** An admitted local recall embedder's exact plan, sent with each borrowed query. */
  readonly localEmbedding?: DesktopMemoryVectorSelection['local'];
  revalidateWorkspace?(signal: AbortSignal): Promise<void>;
}

export interface DesktopRunAdmission {
  readConfiguration(request: HostRunAdmissionRequest): Promise<DesktopRunSelection>;
  /** thread/memory/read: the preconditions an admission starts with, nothing acquired. */
  readMemoryReadiness(
    request: HostRunIntentRequest
  ): Promise<z.input<typeof PlatformMemoryReadinessSchema>>;
  readPermissionPolicy(threadId?: string): Promise<PermissionToolGateSnapshot>;
}

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
): Pick<DesktopRunSelection, 'workspace'> {
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

function desktopDurableConfiguration(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  observerTarget: string | null,
  { childSystem, system }: DesktopHostSystemContext,
  cliWorkspaceRoots?: RuntimeData['workspaceRoots'],
  boundWorkspaceRoots?: RuntimeData['workspaceRoots']
): DesktopRunSelection['durableConfiguration'] {
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

function desktopObservationResolution(enabled: boolean, observerTarget: string | null): string {
  if (!enabled) {
    return 'disabled';
  }
  return observerTarget === null ? 'waiting-for-eligible-model' : 'resolved';
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
      throw refusalError(
        'authorization',
        'workspace.root-not-admitted',
        'This folder is outside the thread workspace.',
        'Choose a folder connected to this thread.'
      );
    }
    request.signal.throwIfAborted();
    const result = await readWorkspaceTextFile(args);
    await readRoots();
    request.signal.throwIfAborted();
    return result;
  };
}

async function readDesktopNativeAdmission(
  reads: DesktopAdmissionReads,
  configuration: z.output<typeof PlatformModelConfigurationSchema>,
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  worktrees: boolean,
  request: HostRunAdmissionRequest,
  workspace?: DesktopWorkspaceBindingBorrow
): Promise<{
  /** The enabled skills of the run's one scan, admitted to the host. */
  readonly admittedSkills: readonly import('@brainstrike/agent').ScannedSkill[] | undefined;
  /** The admission's tools, described from the catalog; the host executes every one. */
  readonly descriptors: Record<string, DesktopToolDescriptor>;
  readonly freshRoots: () => Promise<NonNullable<RuntimeData['workspaceRoots']>>;
  /** Retrieval is admitted to the thread's own roots (a CLI selection or a binding). */
  readonly retrievalRootsOnly: boolean;
  readonly readWorkspaceFile: WorkspaceFileReader;
  readonly revalidateWorkspace: () => Promise<void>;
  readonly runtime: RuntimeData;
  readonly workspaceSkills?: import('@brainstrike/agent').ScannedWorkspaceSkills;
}> {
  request.signal.throwIfAborted();
  const liveRoots = await reads.liveWorkspaceRoots(request.signal);
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
    const current = await reads.liveWorkspaceRoots(request.signal);
    request.signal.throwIfAborted();
    return revalidateCliWorkspaceRoots(roots, current, selection);
  };
  const revalidateWorkspace = async (): Promise<void> => {
    await freshRoots();
  };
  const retrievalRootsOnly = selection !== undefined || workspace !== undefined;
  const readWorkspaceFile = desktopContextReader(request, freshRoots, retrievalRootsOnly);
  // The thread's binding owns the roots a run executes in; the explorer's focus
  // only scopes the user's selection, so a focus outside the thread selects nothing.
  const focused = roots.find((root) => root.rootId === intent.selectionFolderId);
  if (
    intent.selectionFolderId &&
    !liveRoots.some((root) => root.rootId === intent.selectionFolderId)
  ) {
    throw refusalError(
      'conflict',
      'workspace.selection-unmounted',
      'The selected workspace root is no longer mounted'
    );
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
  const descriptors = await desktopToolDescriptors({
    enabledNativeToolIds: intent.enabledNativeToolIds,
    localProvider: configuration.provider.trim().toLowerCase() === 'local',
    skills: workspaceSkills !== undefined,
    worktrees,
  });
  return {
    admittedSkills,
    descriptors,
    freshRoots,
    readWorkspaceFile,
    retrievalRootsOnly,
    revalidateWorkspace,
    runtime,
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
    throw refusalError(
      'authorization',
      'skills.home-not-admitted',
      'Skills need permission to read the home skills folder.',
      'Grant access to the skills folder or turn Skills off.'
    );
  }
  return {};
}

/** Plan mode admits only the plan-mode tool set; the built-in local provider has no plan mode. */
function desktopRunTools(
  tools: Readonly<Record<string, DesktopToolDescriptor>>,
  request: HostRunAdmissionRequest,
  provider: string
): Readonly<Record<string, DesktopToolDescriptor>> {
  if (!request.planMode) {
    return tools;
  }
  if (provider === 'local') {
    throw refusalError(
      'configuration',
      'run.plan-mode-unavailable',
      'Plan mode is unavailable for the built-in local provider'
    );
  }
  return desktopPlanModeTools(tools);
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
): Pick<DesktopRunSelection, 'childSystem' | 'delegation'> {
  return {
    ...(childSystem === undefined ? {} : { childSystem }),
    ...(delegation ? { delegation } : {}),
  };
}

/** What the host's shared native tools need from this admission; roots come back per call. */
function desktopNativeRuntime(
  runtime: RuntimeData,
  retrievalRootsOnly: boolean,
  skills: readonly import('@brainstrike/agent').ScannedSkill[] | undefined
): DesktopRunSelection['nativeRuntime'] {
  if (typeof runtime.provider !== 'string' || !runtime.workspaceRoots) {
    throw new Error('Desktop admission has no native tool runtime');
  }
  return {
    ...(runtime.boundWorkspaceRootId ? { boundWorkspaceRootId: runtime.boundWorkspaceRootId } : {}),
    provider: runtime.provider,
    ...(retrievalRootsOnly ? { retrievalRootsOnly: true as const } : {}),
    ...(runtime.selectionFilePaths ? { selectionFilePaths: [...runtime.selectionFilePaths] } : {}),
    ...(runtime.selectionFolderId ? { selectionFolderId: runtime.selectionFolderId } : {}),
    ...(skills ? { skills: z.array(PlatformAdmittedSkillSchema).parse(skills) } : {}),
    ...(runtime.workspaceContext
      ? { workspaceContext: PlatformWorkspaceContextSchema.parse(runtime.workspaceContext) }
      : {}),
    ...(runtime.workspaceRootPath ? { workspaceRootPath: runtime.workspaceRootPath } : {}),
    workspaceRoots: runtime.workspaceRoots.map(({ displayName, path, rootId }) => ({
      displayName,
      path,
      rootId,
    })),
  };
}

/** The desktop run admission the agent host composes from Main's reads. */
export function createDesktopRunAdmission(
  reads: DesktopAdmissionReads,
  /** The policy the user saved, which the host keeps; undefined when none is saved. */
  savedPolicy: () => Promise<PermissionToolGateSnapshot | undefined>
): DesktopRunAdmission {
  const policies = new Map<string, PermissionToolGateSnapshot>();
  // A host thread's session grants are the host's own (permission.granted);
  // no renderer store reaches its decisions.
  const readHostPermissionPolicy = async (threadId?: string) => {
    const captured = threadId ? policies.get(threadId) : undefined;
    const persisted = await savedPolicy();
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
  const readPreconditions = async (request: HostRunIntentRequest) => {
    request.signal.throwIfAborted();
    const catalog = await readDesktopCatalogSelection(reads, request.modelId, request.signal);
    const intent = await readDesktopIntent(request, catalog, savedPolicy, reads.cliOwnerIntent);
    const configuration = PlatformModelConfigurationSchema.parse(intent.modelConfiguration);
    if (configuration.provider !== catalog.provider || configuration.model !== catalog.model) {
      throw refusalError(
        'conflict',
        'model.selection-changed',
        'The model selection changed before this request started.',
        'Select the model again and retry.'
      );
    }
    const inputTokenLimit = desktopInputTokenLimit(catalog.definition, intent, configuration);
    const { memorySettings, observerTarget } = resolveDesktopMemorySettings(
      intent,
      configuration.provider,
      await readEnabledObservers(reads, intent, configuration.provider, request.signal)
    );
    const memoryVectors = await reads.memoryVectors(memorySettings, request.signal);
    request.signal.throwIfAborted();
    const memory = desktopMemorySelection(
      intent,
      configuration.provider,
      memorySettings,
      observerTarget,
      memoryVectors
    );
    return {
      catalog,
      configuration,
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
  ): Promise<DesktopRunSelection> => {
    const {
      catalog,
      configuration,
      inputTokenLimit,
      intent,
      memory,
      memoryVectors,
      observerTarget,
    } = await readPreconditions(request);
    const { definition } = catalog;
    const permissionPolicy = platformPermissionPolicy(intent.permissionPolicy);
    const native = await readDesktopNativeAdmission(
      reads,
      configuration,
      intent,
      await reads.worktreesAvailable(request.signal),
      request,
      workspace
    );
    const tools = desktopRunTools(native.descriptors, request, configuration.provider);
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
    readConfiguration: async (request) => {
      let workspace: DesktopWorkspaceBindingBorrow | undefined;
      if (request.workspaceBinding && changesThreadWorkspaceScope(request.workspaceBinding)) {
        workspace = await reads.acquireWorkspace({
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
            throw refusalError(
              'authorization',
              'workspace.recovery-root-mismatch',
              'The recovered thread workspace differs from its saved folders.',
              'Reconnect the thread folders and retry.'
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
  };
}
