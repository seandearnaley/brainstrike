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
  NATIVE_TOOL_ID,
  refusalError,
} from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { changesThreadWorkspaceScope } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/ports';
import { resolveHostDelegation } from '@brainstrike/host-capabilities/delegation';
import {
  type AttachedMentionFolders,
  attachedMentionReader,
  createSecureSkillsFs,
  type HostSystemContext,
  hostPlanModeTools,
  type PreparedAdmittedSkills,
  placeMentionedFiles,
  prepareAdmittedSkills,
  readHostSystemContext,
} from '@brainstrike/host-capabilities/workspace-context';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/workspace-text-file-reader';
import { Schema } from 'effect';
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
import { memoryReadinessReason } from './memory-readiness';
import {
  PlatformAdmittedSkillSchema,
  type PlatformClientConfigurationSchema,
  type PlatformMemoryReadinessSchema,
  PlatformModelConfigurationSchema,
  type PlatformSelection,
  platformPermissionPolicy,
} from './platform-wire';

type RuntimeWorkspaceRoots = NonNullable<RuntimeData['workspaceRoots']>;
/** ADR-0032: the given roots the person trusted, in their order. */
export type DesktopTrustedRoots = (roots: RuntimeWorkspaceRoots) => Promise<RuntimeWorkspaceRoots>;
/**
 * What a desktop run's admission reads from the facts Main owns (BST-1930
 * stage e): the model catalog, live roots and their binding leases, the
 * worktree service. The agent host composes the admission from them; Main
 * serves each read and holds no selection.
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
    target: {
      readonly model: string;
      readonly provider: string;
    },
    signal: AbortSignal
  ): Promise<{
    readonly isEnabled: boolean;
    readonly providerId: string;
    /** The model's capability type (`llm`, `embedding`, …), as the catalog lists it. */
    readonly type: string | null;
  } | null>;
  /** The full intent a CLI workspace selection reduces; absent where no owner supplies one. */
  cliOwnerIntent?(request: HostRunIntentRequest): Promise<unknown>;
  /** The candidates whose provider and model rows are enabled and whose model is an LLM. */
  enabledObservers(candidates: readonly string[], signal: AbortSignal): Promise<readonly string[]>;
  /** The profile's mounted workspace roots. */
  liveWorkspaceRoots(signal: AbortSignal): Promise<RuntimeWorkspaceRoots>;
}
/** One admitted desktop run: the selection, its live roots and its release. */
export interface DesktopRunSelection extends Omit<PlatformSelection, 'delegation'> {
  close(): Promise<void>;
  /** BST-1932: the personas and subagent limits this run may delegate with. */
  readonly delegation?: HostDelegation | undefined;
  /** The admitted roots revalidated against their live owners, for the host's shared tools. */
  freshWorkspaceRoots(): Promise<RuntimeWorkspaceRoots>;
  revalidateWorkspace?(signal: AbortSignal): Promise<void>;
}
export interface DesktopRunAdmission {
  readConfiguration(request: HostRunAdmissionRequest): Promise<DesktopRunSelection>;
  /** thread/memory/read: the preconditions an admission starts with, nothing acquired. */
  readMemoryReadiness(
    request: HostRunIntentRequest
  ): Promise<(typeof PlatformMemoryReadinessSchema)['Encoded']>;
  readPermissionPolicy(threadId?: string): Promise<PermissionToolGateSnapshot>;
}
function desktopSystemFields(system: string | undefined): {
  readonly system?: string;
} {
  return system === undefined ? {} : { system };
}
function desktopContextReaderFields(
  restricted: boolean,
  readWorkspaceFile: WorkspaceFileReader
): {
  readonly readWorkspaceFile?: WorkspaceFileReader;
} {
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
  intent: (typeof PlatformClientConfigurationSchema)['Type'],
  observerTarget: string | null,
  { childSystem, system }: HostSystemContext,
  cliWorkspaceRoots?: RuntimeData['workspaceRoots'],
  boundWorkspaceRoots?: RuntimeData['workspaceRoots']
): DesktopRunSelection['durableConfiguration'] {
  return wireDecoder(Schema.Record(Schema.String, Schema.MutableJson), {
    errors: 'all',
    onExcessProperty: 'error',
  })(
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
  trustedRoots: DesktopTrustedRoots,
  configuration: (typeof PlatformModelConfigurationSchema)['Type'],
  intent: (typeof PlatformClientConfigurationSchema)['Type'],
  request: HostRunAdmissionRequest,
  workspace?: DesktopWorkspaceBindingBorrow
): Promise<{
  /** The enabled skills of the run's one scan, admitted to the host. */
  readonly admittedSkills: readonly import('@brainstrike/agent').ScannedSkill[] | undefined;
  /** BST-2018: live folders outside the thread whose mentioned files this run's prompt attaches. */
  readonly attachedMentions?: AttachedMentionFolders;
  /** ADR-0032: the run's roots the person trusted, the only ones whose agent configuration loads. */
  readonly configurationRoots: RuntimeWorkspaceRoots;
  /** The admission's tools, described from the catalog; the host executes every one. */
  readonly descriptors: Record<string, DesktopToolDescriptor>;
  readonly freshRoots: () => Promise<NonNullable<RuntimeData['workspaceRoots']>>;
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
    const capturedRoots = Schema.decodeUnknownSync(CliWorkspaceRootsSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(request.snapshot.configuration['cliWorkspaceRoots']);
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
  // A CLI selection or a binding admits context reads to the thread's own roots.
  const readWorkspaceFile = desktopContextReader(
    request,
    freshRoots,
    selection !== undefined || workspace !== undefined
  );
  const configurationRoots = await trustedRoots(roots);
  request.signal.throwIfAborted();
  // The thread's binding owns the roots a run executes in; the explorer's focus
  // names a folder only when it is one of the thread's.
  const focused = roots.find((root) => root.rootId === intent.selectionFolderId);
  // BST-2018: a mention in a live folder outside the thread is attached for
  // this run only; the reader reads exactly the mentioned files, while live.
  // A CLI selection is the run's whole inventory: its prompt cannot widen it.
  const mentioned = placeMentionedFiles(request.prompt ?? '', roots, selection ? roots : liveRoots);
  const attachedMentions: AttachedMentionFolders | undefined =
    mentioned.attachedRoots.length > 0
      ? {
          read: attachedMentionReader(
            mentioned,
            () => reads.liveWorkspaceRoots(request.signal),
            request.signal
          ),
          roots: mentioned.attachedRoots,
        }
      : undefined;
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
    workspaceInstructionsPreference: intent.workspaceInstructionsPreference,
    workspaceRoots: roots,
    ...(request.workspaceBinding?.operatingRootId
      ? { boundWorkspaceRootId: request.workspaceBinding.operatingRootId }
      : {}),
    ...(focused ? { selectionFolderId: focused.rootId, workspaceRootPath: focused.path } : {}),
    ...(intent.skillsPreference ? { skillsPreference: intent.skillsPreference } : {}),
  };
  const { skills: admittedSkills, workspaceSkills } = desktopRunSkills(
    selection !== undefined,
    intent,
    runtime,
    configurationRoots
  );
  const descriptors = await desktopToolDescriptors({
    // Only a run that enables run_python asks: the check loads the sandbox runtime.
    codeFence:
      intent.enabledNativeToolIds.includes(NATIVE_TOOL_ID.runPython) && (await hostFencesCode()),
    enabledNativeToolIds: intent.enabledNativeToolIds,
    skills: workspaceSkills !== undefined,
  });
  return {
    admittedSkills,
    ...(attachedMentions ? { attachedMentions } : {}),
    configurationRoots,
    descriptors,
    freshRoots,
    readWorkspaceFile,
    revalidateWorkspace,
    runtime,
    ...(workspaceSkills ? { workspaceSkills } : {}),
  };
}
/** BST-2360: the fence run_python's executor itself requires, from the same check. */
async function hostFencesCode(): Promise<boolean> {
  const { isFenceSupported } = await import('@brainstrike/agent/fence-executor');
  return isFenceSupported();
}
/**
 * A CLI selection runs without skills; otherwise one scan of the trusted roots
 * and the home directory feeds the prompt and the host's skill tools.
 */
function desktopRunSkills(
  cliSelection: boolean,
  intent: (typeof PlatformClientConfigurationSchema)['Type'],
  runtime: RuntimeData,
  roots: RuntimeWorkspaceRoots
): PreparedAdmittedSkills {
  if (!cliSelection) {
    return prepareAdmittedSkills({
      fs: createSecureSkillsFs([...roots.map((root) => root.path), homedir()]),
      homedir,
      roots,
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
/** Plan mode admits only the plan-mode tool set. */
function desktopRunTools(
  tools: Readonly<Record<string, DesktopToolDescriptor>>,
  request: HostRunAdmissionRequest
): Readonly<Record<string, DesktopToolDescriptor>> {
  return request.planMode ? hostPlanModeTools(tools) : tools;
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
  skills: readonly import('@brainstrike/agent').ScannedSkill[] | undefined
): DesktopRunSelection['nativeRuntime'] {
  if (typeof runtime.provider !== 'string' || !runtime.workspaceRoots) {
    throw new Error('Desktop admission has no native tool runtime');
  }
  return {
    ...(runtime.boundWorkspaceRootId ? { boundWorkspaceRootId: runtime.boundWorkspaceRootId } : {}),
    provider: runtime.provider,
    ...(runtime.selectionFolderId ? { selectionFolderId: runtime.selectionFolderId } : {}),
    ...(skills
      ? {
          skills: Schema.decodeUnknownSync(
            Schema.mutable(Schema.Array(PlatformAdmittedSkillSchema)),
            { errors: 'all', onExcessProperty: 'error' }
          )(skills),
        }
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
  savedPolicy: () => Promise<PermissionToolGateSnapshot | undefined>,
  /** ADR-0032: the host's workspace trust, which decides whose agent configuration loads. */
  trustedRoots: DesktopTrustedRoots
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
   * settings and observer resolution. A run
   * admission and thread/memory/read both start here; nothing is acquired.
   */
  const readPreconditions = async (request: HostRunIntentRequest) => {
    request.signal.throwIfAborted();
    const selection = await readDesktopCatalogSelection(reads, request.modelId, request.signal);
    const intent = await readDesktopIntent(request, selection, savedPolicy, reads.cliOwnerIntent);
    const configuration = Schema.decodeUnknownSync(PlatformModelConfigurationSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(intent.modelConfiguration);
    if (configuration.provider !== selection.provider || configuration.model !== selection.model) {
      throw refusalError(
        'conflict',
        'model.selection-changed',
        'The model selection changed before this request started.',
        'Select the model again and retry.'
      );
    }
    const catalog = selection;
    const inputTokenLimit = desktopInputTokenLimit(catalog.definition, intent, configuration);
    const { memorySettings, observerTarget } = resolveDesktopMemorySettings(
      intent,
      configuration.provider,
      await readEnabledObservers(reads, intent, configuration.provider, request.signal)
    );
    const memory = desktopMemorySelection(
      intent,
      configuration.provider,
      memorySettings,
      observerTarget
    );
    return {
      catalog,
      configuration,
      inputTokenLimit,
      intent,
      memory,
      observerTarget,
    };
  };
  const readConfiguration = async (
    request: HostRunAdmissionRequest,
    workspace?: DesktopWorkspaceBindingBorrow
  ): Promise<DesktopRunSelection> => {
    const { catalog, configuration, inputTokenLimit, intent, memory, observerTarget } =
      await readPreconditions(request);
    const { definition } = catalog;
    const permissionPolicy = platformPermissionPolicy(intent.permissionPolicy);
    const native = await readDesktopNativeAdmission(
      reads,
      trustedRoots,
      configuration,
      intent,
      request,
      workspace
    );
    const tools = desktopRunTools(native.descriptors, request);
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
      // ADR-0032: personas come from the trusted roots and the home directory.
      const delegation = resolveHostDelegation(
        intent,
        native.configurationRoots,
        request.planMode === true
      );
      // The host never offers what the saved policy denies; the instructions never name it.
      const policy = await readHostPermissionPolicy(request.threadId);
      const { childSystem, system, referencedFileFailures } = await readHostSystemContext({
        ...(native.attachedMentions ? { attachedMentions: native.attachedMentions } : {}),
        configurationRoots: native.configurationRoots,
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
        ...(referencedFileFailures ? { referencedFileFailures: [...referencedFileFailures] } : {}),
        freshWorkspaceRoots: native.freshRoots,
        inputTokenLimit,
        maxSteps: intent.agentLoop?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
        memory,
        nativeRuntime: desktopNativeRuntime(native.runtime, native.admittedSkills),
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
          const captured = Schema.decodeUnknownSync(CliWorkspaceRootsSchema, {
            errors: 'all',
            onExcessProperty: 'error',
          })(request.snapshot.configuration['boundWorkspaceRoots']);
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
        return { ready: false, reason: memoryReadinessReason(cause) };
      }
    },
    readPermissionPolicy: readHostPermissionPolicy,
  };
}
