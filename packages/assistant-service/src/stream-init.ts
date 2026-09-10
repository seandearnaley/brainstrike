import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type {
  AgentMessage,
  AssistantRunEvent,
  AssistantTaskItem,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  DelegatedConversationBinding,
  McpConfig,
  ProviderAuthInput,
  RuntimeAssistantMemorySettings,
  RuntimeData,
  ScaledToolResultBudget,
  ScannedWorkspaceSkills,
  ScopedToolOutputArtifactReader,
  StreamChunk,
  ToolOutputArtifactSettlementStore,
} from '@brainstrike/agent';
import {
  getProviderDefaultModel,
  isSupportedProvider,
  resolveRequestPermissionPolicy,
  resolveScaledToolResultBudget,
  resolveToolResultBudgetForModel,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
  TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import type { PgliteMastraMemoryResult } from '@brainstrike/agent/pglite-mastra-memory';
import type { McpHostPort } from '@brainstrike/assistant-contract';
import type { AgentStreamInitializationStage } from '@brainstrike/assistant-wire';
import type { ScopedLogger } from '@brainstrike/logging';
import {
  collectLocalLlmWarmupModelIds,
  isLocalChatProvider,
  resolveLocalLlmHostClient,
} from './local-provider-runtime.js';
import { resolveDesktopObserverUsageTarget } from './memory-model-targets.js';
import type { AssistantLlmHostManager, AssistantStreamRuntimeOptions } from './ports.js';
import { getSecretReadErrorPayload } from './secret-errors.js';
import type { PreRequestCompactionCapabilityResult } from './stream-init-compaction.js';
import {
  runConversationCompactionBeforeStream,
  trustedCompactionOverlayFields,
  withCompactionPreludeChunks,
} from './stream-init-compaction.js';
import { buildInitialStreamMemoryOptions } from './stream-runtime-options.js';
import type { AgentStreamFailure, AgentStreamResult, DesktopMemoryFeature } from './types.js';

/**
 * Read the current thread's task list for re-injection this turn. Returns `[]`
 * when there is no thread, no DB, the run targets the built-in local provider,
 * or the read fails (a warn is logged) — an absent plan is a legitimate empty
 * state, not a swallowed policy fallback. The local-provider skip is the
 * DB-read-avoiding gate of the same policy enforced again (defense in depth)
 * by the provider check on `taskListNote` in agent-runtime.ts, and by omitting
 * the manageTaskList tool for local in buildDesktopAssistantTools.
 */
async function readThreadTaskListForTurn<K extends AgentStreamCapabilityKinds>(
  runtimeData: RuntimeData | undefined,
  database: K['database'] | null,
  deps: AgentStreamHelperDeps<K>
): Promise<readonly AssistantTaskItem[]> {
  const threadId = runtimeData?.memory?.threadId;
  if (!(threadId && database) || isLocalChatProvider(runtimeData)) {
    return [];
  }
  try {
    return await deps.capabilities.taskList.read(database, threadId);
  } catch (error) {
    deps.logger.warn('Failed to read thread task list; no task-list block this turn.', { error });
    return [];
  }
}

type InitialStreamMemoryOptions = AssistantStreamRuntimeOptions;

interface ToolOutputArtifactCapabilities {
  toolOutputArtifactReader?: ScopedToolOutputArtifactReader;
  toolOutputArtifactStore?: ToolOutputArtifactSettlementStore;
}

export function buildToolOutputArtifactCapabilities<K extends AgentStreamCapabilityKinds>(
  runtimeData: RuntimeData | undefined,
  runId: string | undefined,
  getDatabase: AgentStreamDatabaseProvider<K['database']>,
  deps: { readonly capabilities: Pick<AgentStreamCapabilities<K>, 'artifacts'> }
): ToolOutputArtifactCapabilities {
  const resourceId = runtimeData?.memory?.resourceId;
  const threadId = runtimeData?.memory?.threadId;
  if (!(resourceId && threadId)) {
    return {};
  }
  const toolOutputArtifactReader: ScopedToolOutputArtifactReader = {
    readRange: async (input) => {
      const database = await getDatabase();
      return deps.capabilities.artifacts.createRepository(database).readRange({
        ...input,
        resourceId,
        threadId,
      });
    },
  };
  if (!runId) {
    return { toolOutputArtifactReader };
  }
  return {
    toolOutputArtifactReader,
    toolOutputArtifactStore: {
      store: async (input) => {
        const database = await getDatabase();
        return deps.capabilities.artifacts.createRepository(database).store({
          ...input,
          resourceId,
          runId,
          threadId,
        });
      },
    },
  };
}

function withToolOutputArtifactReader<K extends AgentStreamCapabilityKinds>(
  dependencies: AgentStreamToolDependencies<K>,
  reader: ScopedToolOutputArtifactReader | undefined
): AgentStreamToolDependencies<K> {
  if (!reader) {
    return dependencies;
  }
  return { ...dependencies, toolOutputArtifactReader: reader };
}

function withSkillScriptResolver<K extends AgentStreamCapabilityKinds>(
  dependencies: AgentStreamToolDependencies<K>,
  resolver: ScannedWorkspaceSkills | undefined
): AgentStreamToolDependencies<K> {
  if (!resolver) {
    return dependencies;
  }
  return { ...dependencies, skillScriptResolver: resolver };
}

function withResolvedToolResultBudget<K extends AgentStreamCapabilityKinds>(
  dependencies: AgentStreamToolDependencies<K>,
  resolvedToolResultBudget: ScaledToolResultBudget
): AgentStreamToolDependencies<K> {
  return { ...dependencies, resolvedToolResultBudget };
}

/** Resolve the producer-side budget from the runtime's provider/model pair. */
export function resolveToolBuildBudget(
  runtimeData: Pick<RuntimeData, 'model' | 'provider'> | undefined,
  logger: Pick<ScopedLogger, 'warn'>
): ScaledToolResultBudget {
  const rawProvider = typeof runtimeData?.provider === 'string' ? runtimeData.provider.trim() : '';
  const normalizedProvider = rawProvider.toLowerCase();
  if (!isSupportedProvider(normalizedProvider)) {
    logger.warn('Cannot resolve tool-result budget for tool construction; using anchor fallback.', {
      code: 'tool_result_budget_invalid_provider_fallback',
      provider: rawProvider || '<unset>',
    });
    return resolveScaledToolResultBudget(TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW);
  }
  const model = runtimeData?.model || getProviderDefaultModel(normalizedProvider) || '';
  return resolveToolResultBudgetForModel(normalizedProvider, model);
}

/**
 * Pick the initial stream for the turn: approval-resume, suspend-resume
 * (submitPlan/askUser), or a fresh generation. Both resume paths skip
 * `injectReferencedFilesContext` — there is no new user turn to scan — mirroring
 * the approval path's contract.
 */
async function resolveInitialAgentStream<K extends AgentStreamCapabilityKinds>(args: {
  deps: AgentStreamHelperDeps<K>;
  messages: AgentMessage[];
  runtime: RuntimeData;
  memoryOptions: InitialStreamMemoryOptions;
  toolApprovalAction: AssistantToolApprovalAction | undefined;
  toolResumeAction: AssistantToolResumeAction | undefined;
}): Promise<AsyncIterable<StreamChunk>> {
  const {
    deps: { capabilities },
    messages,
    runtime,
    memoryOptions,
    toolApprovalAction,
    toolResumeAction,
  } = args;
  if (toolApprovalAction) {
    capabilities.runPersistence.recordContinuationRunTreatment?.(runtime);
    return streamMastraToolApprovalAction(toolApprovalAction, {
      ...memoryOptions,
      requireToolApproval: true,
      runtime,
    });
  }
  if (toolResumeAction) {
    capabilities.runPersistence.recordContinuationRunTreatment?.(runtime);
    return streamMastraToolResumeAction(toolResumeAction, { ...memoryOptions, runtime });
  }
  // Prepend the turn's `@file` references (referenced-files), then any explicit
  // `:skill[name]` activations, then the opt-in self-improvement signal, then
  // the mounted roots' workspace instructions (AGENTS.md/AGENT.md/CLAUDE.md).
  // Instructions are applied LAST so the final front-to-back order is:
  // instructions → signal → skills → referenced files → conversation. All are
  // no-ops (same array identity) when nothing applies.
  const withReferencedFiles = await capabilities.contextInjectors.referencedFiles(
    messages,
    runtime,
    capabilities.readWorkspaceTextFile
  );
  const withSkillActivations = await capabilities.contextInjectors.activatedSkills(
    withReferencedFiles,
    runtime.workspaceSkills
  );
  const withSelfImprovementSignal = await capabilities.contextInjectors.selfImprovementSignal(
    withSkillActivations,
    runtime
  );
  return toAiSdkStyleStream(
    await capabilities.contextInjectors.workspaceInstructions(
      withSelfImprovementSignal,
      runtime,
      capabilities.readWorkspaceTextFile
    ),
    runtime,
    memoryOptions
  );
}

/**
 * Build the TRUSTED per-request Agent Skills engine over a SecureRoot fs
 * surface spanning the request's resolved workspace roots + the home dir.
 * Extracted from initializeAgentStream for the cognitive-complexity budget.
 */
function prepareRequestSkillsFromDisk<K extends AgentStreamCapabilityKinds>(
  runtimeData: RuntimeData | undefined,
  deps: AgentStreamHelperDeps<K>
): {
  workspaceSkills?: ScannedWorkspaceSkills;
} {
  const { workspaceSkills } = deps.capabilities.skills.prepare({
    fs: deps.capabilities.skills.createFs([
      ...(runtimeData?.workspaceRoots ?? [])
        .map((root) => root.path)
        .filter((rootPath): rootPath is string => Boolean(rootPath)),
      homedir(),
    ]),
    homedir,
    runtimeData,
  });
  // Shaped as a runtime-field fragment (like resolvePersonaRuntimeFields) so
  // the caller spreads it unconditionally.
  return workspaceSkills ? { workspaceSkills } : {};
}

function trustedProjectionRewriteFields(
  lookup: RuntimeData['toolProjectionRewriteLookup']
): Pick<RuntimeData, 'toolProjectionRewriteLookup'> {
  return lookup ? { toolProjectionRewriteLookup: lookup } : {};
}

/**
 * Scan user-defined personas from disk over the request's already-resolved
 * workspace roots (SecureRoot-backed fs; disposed after the scan). Extracted
 * from initializeAgentStream for the cognitive-complexity budget.
 */
function scanUserPersonasFromDisk<K extends AgentStreamCapabilityKinds>(
  workspaceRoots: RuntimeData['workspaceRoots'],
  deps: AgentStreamHelperDeps<K>
): K['personaScan'] {
  const filesystem = deps.capabilities.personas.createScanDeps();
  try {
    const scanRoots = (workspaceRoots ?? [])
      .filter((root) => Boolean(root.path))
      .map((root) => ({
        absPath: root.path,
        displayName: root.displayName,
        id: root.rootId,
      }));
    return deps.capabilities.personas.scan({ homeDir: homedir(), roots: scanRoots }, filesystem);
  } finally {
    filesystem.dispose();
  }
}

/**
 * Resolve the request's persona set (built-in + user-defined, availability
 * preference applied) and any pinned-provider API keys, shaped as the runtime
 * fields to spread onto the request RuntimeData. See request-personas.ts for
 * the trust boundaries.
 */
async function resolvePersonaRuntimeFields<K extends AgentStreamCapabilityKinds>(
  runtimeData: RuntimeData | undefined,
  subagentPersonasRequest: RuntimeData['subagentPersonasRequest'],
  resolveProviderApiKey: AgentStreamProviderApiKeyReader,
  deps: AgentStreamHelperDeps<K>
): Promise<Pick<RuntimeData, 'personas' | 'personaProviderApiKeys'>> {
  const resolved = await deps.capabilities.personas.resolve({
    logger: deps.logger,
    parentProvider: runtimeData?.provider ?? '',
    request: subagentPersonasRequest,
    resolveApiKey: resolveProviderApiKey,
    scanUserPersonas: () => scanUserPersonasFromDisk(runtimeData?.workspaceRoots, deps),
  });
  return {
    personas: resolved.personas,
    ...(resolved.personaProviderApiKeys
      ? { personaProviderApiKeys: resolved.personaProviderApiKeys }
      : {}),
  };
}

/**
 * The Stop-hook verdict recorder threaded into `finalizeHookedStream`: records
 * a hook-reported Task Ledger verdict for THIS run via the main-process DB
 * handle. Without a runId there is no run to label, so no recorder is threaded
 * (hooks themselves still run).
 */
function buildHookRunVerdictRecorder<K extends AgentStreamCapabilityKinds>(
  runId: string | undefined,
  getDatabase: AgentStreamDatabaseProvider<K['database']>,
  deps: AgentStreamHelperDeps<K>
): {
  onRunVerdict?: (verdict: K['hookVerdict']) => Promise<void>;
} {
  if (!runId) {
    return {};
  }
  return {
    onRunVerdict: async (verdict: K['hookVerdict']): Promise<void> => {
      const database = await getDatabase();
      await deps.capabilities.runPersistence.recordHookRunOutcome(database, runId, verdict);
    },
  };
}

function buildAgentStreamInitializationFailure<K extends AgentStreamCapabilityKinds>(
  error: unknown,
  stage: AgentStreamInitializationStage,
  deps: AgentStreamHelperDeps<K>
): AgentStreamFailure {
  const secretReadErrorPayload = getSecretReadErrorPayload(error);
  if (secretReadErrorPayload) {
    return {
      ok: false,
      payload: secretReadErrorPayload,
      status: 400,
    };
  }
  const memoryCredentialMissing = deps.capabilities.memory.matchCredentialMissingError(error);
  if (memoryCredentialMissing) {
    return {
      ok: false,
      payload: {
        error: 'memory_credential_missing',
        feature: memoryCredentialMissing.feature,
        message: memoryCredentialMissing.message,
        provider: memoryCredentialMissing.provider,
      },
      status: 400,
    };
  }
  const correlationId = randomUUID();
  deps.logger.error('Failed to initialize assistant stream', { correlationId, error, stage });
  return {
    ok: false,
    payload: {
      correlationId,
      error: 'agent_stream_init_failed',
      message: 'Assistant stream initialization failed.',
      stage,
    },
    status: 502,
  };
}

function buildWorkspaceRootResolutionFailure<K extends AgentStreamCapabilityKinds>(
  error: unknown,
  deps: AgentStreamHelperDeps<K>
): AgentStreamFailure {
  const boundRootUnavailable =
    deps.capabilities.workspaceRoots.matchBoundRootUnavailableError(error);
  if (boundRootUnavailable) {
    return {
      ok: false,
      payload: {
        error: 'bound_workspace_root_unavailable',
        message: boundRootUnavailable.message,
        stage: 'workspace_root_resolution',
      },
      status: 409,
    };
  }
  return buildAgentStreamInitializationFailure(error, 'workspace_root_resolution', deps);
}

function stripClientWorkspaceRoots(runtimeData: RuntimeData | undefined): RuntimeData | undefined {
  if (!runtimeData) {
    return;
  }
  // `workspaceRoots` is a TRUSTED server-resolved capability inventory: its ids
  // must be the DB `roots.id` values accepted by the native tools. The renderer
  // supplies only Main/Focused ordering hints, never an authoritative root list.
  const { workspaceRoots: _ignoredClientWorkspaceRoots, ...runtimeWithoutWorkspaceRoots } =
    runtimeData;
  return runtimeWithoutWorkspaceRoots;
}

/**
 * Injected host database provider (BST-972 A2 rule, unchanged by the move): a
 * PROVIDER, not a resolved handle, so each use awaits the current handle
 * exactly where the previous direct calls did — a mid-run handle swap is
 * observed, never cached across awaits. `TDb` is the host's opaque
 * `AgentStreamCapabilityKinds['database']`.
 */
export type AgentStreamDatabaseProvider<TDb> = () => Promise<TDb>;

/**
 * Injected provider-credential reader (BST-972 A3): the persona pin-key path
 * resolves keys through this instead of importing provider-credentials at
 * module scope. Same structural shape request-personas.ts already declares for
 * its `resolveApiKey` dependency; the desktop composition site
 * (assistant-server.ts) passes provider-credentials' `resolveProviderApiKey`
 * verbatim, so resolution order (env key, then stored secret) and the thrown
 * SecretReadError contract are unchanged.
 */
export type AgentStreamProviderApiKeyReader = (provider: string) => Promise<string | undefined>;

/**
 * A workspace text-file reader with the same containment/size/binary guards as
 * the read tools (implemented host-side; the service only routes it into the
 * context injectors).
 */
export type WorkspaceFileReader = (args: {
  rootPath: string;
  requestedPath: string;
}) => Promise<{ content: string; path: string; size: number }>;

/**
 * The host-internal types the service routes BETWEEN capability calls without
 * ever inspecting (BST-972 B4b): a hook manager produced by `hooks.prepare` is
 * consumed only by `hooks.runUserPromptSubmitGate`/`hooks.finalize`, a persona
 * scan result only by `personas.resolve`, and so on. Opaque generics keep the
 * intra-request wiring type-safe without restating host types structurally —
 * the drift the B4a `typeof import(...)` pins existed to prevent.
 */
export interface AgentStreamCapabilityKinds {
  readonly database: unknown;
  readonly embeddingHost: unknown;
  readonly hookEvent: unknown;
  readonly hookManager: unknown;
  readonly hookVerdict: unknown;
  readonly personaScan: unknown;
  /** Disposed after the persona scan, so the constraint is structural. */
  readonly scanFilesystem: { readonly dispose: () => void };
  readonly skillsFilesystem: unknown;
}

/**
 * The tool-construction dependency bag: what the service THREADS (host
 * managers from the request params, plus the per-request artifact reader and
 * skill-script resolver it builds). Hosts may accept more fields; every field
 * here is optional so the host's own bag type stays assignable.
 */
export interface AgentStreamToolDependencies<K extends AgentStreamCapabilityKinds> {
  readonly embeddingHostManager?: K['embeddingHost'] | null | undefined;
  readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
  readonly resolvedToolResultBudget?: ScaledToolResultBudget | undefined;
  readonly skillScriptResolver?: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'> | undefined;
  readonly toolOutputArtifactReader?: ScopedToolOutputArtifactReader | undefined;
}

/** What `memory.create` yields: the Mastra memory/storage pair for the run. */
export type AgentStreamMemoryResult = PgliteMastraMemoryResult & {
  readonly conversationBinding?: DelegatedConversationBinding;
};

/**
 * Host-composed capabilities (BST-972 B4a/B4b): every host-module VALUE edge
 * of this module, injected so the service owns orchestration while the host
 * owns adapters. The desktop composition site is assistant-server.ts, which
 * passes the real implementations verbatim — suites that vi.mock those
 * specifiers keep intercepting because the ROOT still imports them (the
 * dd8599895 lesson, avoided by construction). Host-internal value types ride
 * the opaque `AgentStreamCapabilityKinds` bag; everything else is the shared
 * agent vocabulary.
 */
export interface AgentStreamCapabilities<
  K extends AgentStreamCapabilityKinds = AgentStreamCapabilityKinds,
> {
  readonly artifacts: {
    /** Scoped tool-output artifact repository over the host DB handle. */
    readonly createRepository: (database: K['database']) => {
      readonly readRange: (
        input: Parameters<ScopedToolOutputArtifactReader['readRange']>[0] & {
          readonly resourceId: string;
          readonly threadId: string;
        }
      ) => ReturnType<ScopedToolOutputArtifactReader['readRange']>;
      readonly store: (
        input: Parameters<ToolOutputArtifactSettlementStore['store']>[0] & {
          readonly resourceId: string;
          readonly runId: string;
          readonly threadId: string;
        }
      ) => ReturnType<ToolOutputArtifactSettlementStore['store']>;
    };
  };
  readonly compaction: {
    readonly createContextOverflowRecovery: (input: {
      readonly memoryStore: AgentStreamMemoryResult['store'];
      readonly runtimeData: RuntimeData;
    }) => NonNullable<RuntimeData['contextOverflowRecovery']>;
    readonly runPreRequest: (input: {
      readonly memoryStore: AgentStreamMemoryResult['store'];
      readonly requestMessages: readonly AgentMessage[];
      readonly runId: string | undefined;
      readonly runtimeData: RuntimeData;
      readonly signal: AbortSignal;
    }) => Promise<PreRequestCompactionCapabilityResult>;
  };
  readonly contextInjectors: {
    readonly activatedSkills: (
      messages: AgentMessage[],
      workspaceSkills: RuntimeData['workspaceSkills']
    ) => Promise<AgentMessage[]>;
    readonly referencedFiles: (
      messages: AgentMessage[],
      runtimeData: RuntimeData,
      readFile: WorkspaceFileReader
    ) => Promise<AgentMessage[]>;
    readonly selfImprovementSignal: (
      messages: AgentMessage[],
      runtimeData: RuntimeData
    ) => Promise<AgentMessage[]>;
    readonly workspaceInstructions: (
      messages: AgentMessage[],
      runtimeData: RuntimeData,
      readFile: WorkspaceFileReader
    ) => Promise<AgentMessage[]>;
  };
  readonly hooks: {
    readonly eventToAssistant: (event: K['hookEvent']) => AssistantRunEvent;
    readonly finalize: (
      stream: AsyncIterable<StreamChunk>,
      opts: {
        readonly logger: ScopedLogger;
        readonly manager: K['hookManager'];
        readonly observe: (source: AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
        readonly onRunVerdict?: (verdict: K['hookVerdict']) => Promise<void>;
        readonly runner: RuntimeData['hookRunner'] | undefined;
        readonly signal: AbortSignal;
      }
    ) => AsyncIterable<StreamChunk>;
    readonly makeBlockedStream: (reason: string) => AsyncIterable<StreamChunk>;
    readonly prepare: (input: {
      readonly emitRunEvent: (event: K['hookEvent']) => void;
      readonly hookTrustRequest: RuntimeData['hookTrustRequest'];
      readonly logger: ScopedLogger;
      readonly runId: string | undefined;
      readonly runtimeData: RuntimeData | undefined;
    }) => {
      readonly manager: K['hookManager'];
      readonly runner: RuntimeData['hookRunner'] | undefined;
    };
    readonly runUserPromptSubmitGate: (
      manager: K['hookManager'],
      messages: AgentMessage[],
      isResumeOrApproval: boolean
    ) => Promise<
      | { readonly kind: 'block'; readonly reason: string }
      | { readonly kind: 'proceed'; readonly messages: AgentMessage[] }
    >;
  };
  readonly memory: {
    readonly create: (
      memorySettings: RuntimeAssistantMemorySettings | undefined,
      runId: string | undefined,
      eventSink: ((event: AssistantRunEvent) => void) | undefined,
      runtimeData: RuntimeData | undefined,
      dependencies: { readonly embeddingHostManager?: K['embeddingHost'] | null | undefined }
    ) => Promise<AgentStreamMemoryResult>;
    /**
     * Structural stand-in for the previous `instanceof
     * DesktopMemoryCredentialMissingError` check (the A3 matchSecretReadError
     * precedent): the desktop root matches with the REAL class, so identity
     * semantics are unchanged while this module stops naming it.
     */
    readonly matchCredentialMissingError: (error: unknown) =>
      | {
          readonly feature: DesktopMemoryFeature;
          readonly message: string;
          readonly provider: string;
        }
      | undefined;
  };
  readonly personas: {
    readonly createScanDeps: () => K['scanFilesystem'];
    readonly resolve: (params: {
      readonly logger: ScopedLogger;
      readonly parentProvider: string;
      readonly request: RuntimeData['subagentPersonasRequest'];
      readonly resolveApiKey: AgentStreamProviderApiKeyReader;
      readonly scanUserPersonas: () => K['personaScan'];
    }) => Promise<{
      readonly personas: NonNullable<RuntimeData['personas']>;
      readonly personaProviderApiKeys?: RuntimeData['personaProviderApiKeys'];
    }>;
    readonly scan: (
      input: {
        readonly homeDir: string;
        readonly roots: ReadonlyArray<{
          readonly absPath: string;
          readonly displayName: string;
          readonly id: string;
        }>;
      },
      deps: K['scanFilesystem']
    ) => K['personaScan'];
  };
  readonly readWorkspaceTextFile: WorkspaceFileReader;
  readonly runPersistence: {
    readonly observeRunEvents: (
      stream: AsyncIterable<StreamChunk>,
      runId: string,
      queuedEvents: AssistantRunEvent[],
      getDatabase: AgentStreamDatabaseProvider<K['database']>
    ) => AsyncIterable<StreamChunk>;
    readonly persistChildRunUsage: (
      stream: AsyncIterable<StreamChunk>,
      runId: string,
      observerTarget: { readonly model: string; readonly provider: string } | undefined,
      getDatabase: AgentStreamDatabaseProvider<K['database']>,
      requiresDelegationIdentity?: boolean
    ) => AsyncIterable<StreamChunk>;
    readonly persistToolCallTelemetry: (
      stream: AsyncIterable<StreamChunk>,
      runId: string,
      getDatabase: AgentStreamDatabaseProvider<K['database']>
    ) => AsyncIterable<StreamChunk>;
    readonly persistTokenEstimateCalibration: (
      stream: AsyncIterable<StreamChunk>,
      runId: string,
      getDatabase: AgentStreamDatabaseProvider<K['database']>
    ) => AsyncIterable<StreamChunk>;
    readonly recordHookRunOutcome: (
      database: K['database'],
      runId: string,
      verdict: K['hookVerdict']
    ) => Promise<void>;
    /**
     * BST-1250 (optional): record the per-run experiment treatment for
     * approval/resume continuation legs. Those legs mint their own runId and
     * run row but return BEFORE the context injectors (where normal legs
     * record), so without this they get outcome labels with no treatment row
     * — a systematically biased gap (they correlate with tool-heavy,
     * permission-gated runs). Fire-and-forget; never blocks the stream.
     */
    readonly recordContinuationRunTreatment?: (runtime: RuntimeData) => void;
  };
  readonly skills: {
    readonly createFs: (candidateRoots: readonly string[]) => K['skillsFilesystem'];
    readonly prepare: (params: {
      readonly fs: K['skillsFilesystem'];
      readonly homedir: () => string;
      readonly runtimeData: RuntimeData | undefined;
    }) => { readonly workspaceSkills?: ScannedWorkspaceSkills };
  };
  readonly taskList: {
    readonly read: (database: K['database'], threadId: string) => Promise<AssistantTaskItem[]>;
  };
  readonly tools: {
    readonly build: (
      runtimeData: RuntimeData | undefined,
      dependencies: AgentStreamToolDependencies<K>
    ) => NonNullable<RuntimeData['mastraTools']>;
  };
  /** The webExtract inline-serialization cap, injected as a plain number. */
  readonly webExtractInlineMaxSerializedChars: number;
  readonly workspaceRoots: {
    readonly enrich: (
      runtimeData: RuntimeData | undefined,
      db: K['database'] | null
    ) => Promise<RuntimeData | undefined>;
    /** Structural stand-in for `instanceof BoundWorkspaceRootUnavailableError`. */
    readonly matchBoundRootUnavailableError: (
      error: unknown
    ) => { readonly message: string } | undefined;
  };
}

/**
 * The request-invariant ambient dependencies threaded to this module's private
 * helpers as ONE object (review finding on #2128): the same silent-swap
 * hazard the params-object ruling names would otherwise re-accumulate on
 * every helper tail, two positionals at a time.
 */
interface AgentStreamHelperDeps<K extends AgentStreamCapabilityKinds> {
  readonly capabilities: AgentStreamCapabilities<K>;
  readonly logger: ScopedLogger;
}

/**
 * Params object rather than positional arguments (ruling from the #2115
 * review): dependencies accumulate here slice by slice, and adjacent
 * positional parameters stay mistake-proof only while their types happen to
 * differ — desktop's type-check excludes test files, so a missed test call
 * site would surface only at runtime.
 */
export interface InitializeAgentStreamParams<K extends AgentStreamCapabilityKinds> {
  /**
   * Legacy resolved-key string, retained on the port for transport parity;
   * NOT consumed here since the BST-1352 review — auth reaches the stream
   * exclusively through `authInput` and the runtime carries no apiKey field.
   */
  readonly apiKey: string | undefined;
  /**
   * Provider auth input (BST-1352), threaded as a DIRECT parameter into the
   * stream options. Never copied onto RuntimeData (RequestContext.toJSON
   * drops functions — a custom_fetch closure would vanish silently).
   */
  readonly authInput?: ProviderAuthInput | undefined;
  readonly capabilities: AgentStreamCapabilities<K>;
  /** Trusted host-injected compaction overlay lookup; never client supplied. */
  readonly compactionOverlayLookup?: RuntimeData['compactionOverlayLookup'];
  readonly getDatabase: AgentStreamDatabaseProvider<K['database']>;
  readonly logger: ScopedLogger;
  readonly mcpAppAdmission?: AssistantStreamRuntimeOptions['mcpAppAdmission'];
  readonly mcpConfig: McpConfig | undefined;
  readonly mcpHost?: McpHostPort;
  readonly mcpTaskTracking?: AssistantStreamRuntimeOptions['mcpTaskTracking'];
  // Deliberately the mutable array type: this exact array is handed through
  // runUserPromptSubmitGate and resolveInitialAgentStream into
  // @brainstrike/agent's toAiSdkStyleStream, whose signature is AgentMessage[].
  // `readonly AgentMessage[]` here means threading readonly through that whole
  // chain — request-boundary type work for the package-extraction slice.
  readonly messages: AgentMessage[];
  readonly resolveProviderApiKey: AgentStreamProviderApiKeyReader;
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData | undefined;
  readonly signal: AbortSignal;
  readonly toolApprovalAction: AssistantToolApprovalAction | undefined;
  readonly toolDependencies: {
    readonly embeddingHostManager?: K['embeddingHost'] | null | undefined;
    readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
  };
  /** Trusted host-injected projection-overlay lookup; never client supplied. */
  readonly toolProjectionRewriteLookup?: RuntimeData['toolProjectionRewriteLookup'];
  readonly toolResumeAction: AssistantToolResumeAction | undefined;
}

export async function initializeAgentStream<K extends AgentStreamCapabilityKinds>(
  params: InitializeAgentStreamParams<K>
): Promise<AgentStreamResult> {
  const {
    capabilities,
    logger,
    messages,
    runtimeData: incomingRuntimeData,
    authInput,
    mcpConfig,
    mcpHost,
    mcpAppAdmission,
    mcpTaskTracking,
    signal,
    runId,
    toolApprovalAction,
    toolResumeAction,
    toolDependencies,
    compactionOverlayLookup,
    toolProjectionRewriteLookup,
    getDatabase,
    resolveProviderApiKey,
  } = params;
  const deps: AgentStreamHelperDeps<K> = { capabilities, logger };
  // Multi-root: resolve the active workspace roots from the DB `roots` table so
  // the assistant's file/search tools can disambiguate paths across roots. A
  // failed lookup leaves the authoritative inventory unavailable, so workspace
  // tool authorization fails closed instead of synthesizing the focused path.
  const rootsDatabase = await getDatabase().catch((error: unknown) => {
    logger.warn('Workspace roots DB unavailable; workspace tools fail closed.', { error });
    return null;
  });
  let runtimeData: RuntimeData | undefined;
  try {
    runtimeData = await capabilities.workspaceRoots.enrich(
      stripClientWorkspaceRoots(incomingRuntimeData),
      rootsDatabase
    );
  } catch (error) {
    return buildWorkspaceRootResolutionFailure(error, deps);
  }

  // Re-inject the current per-thread task list into the instructions this
  // turn (see readThreadTaskListForTurn for the local-provider skip).
  const taskList = await readThreadTaskListForTurn(runtimeData, rootsDatabase, deps);

  // Build runtime context with abort signal for cancellation support
  // The signal is embedded in RuntimeData and flows through to:
  // - toAiSdkStyleStream -> streamMastraAgent -> readableStreamIterator
  // - AssistantDataStreamSession (via cancel() on Response stream)
  //
  // `permissionPolicyRequest` (renderer-supplied) is stripped here and resolved
  // into the TRUSTED `permissionPolicy` below: only when the user opted in
  // (`enforce: true`) is a snapshot built (with server-owned tool risk
  // classification); otherwise `permissionPolicy` stays unset and the runtime
  // gate is a no-op (passthrough — current production behavior). A malformed
  // policy is NOT repaired here; it surfaces from the runtime resolver.
  const {
    mcpConfig: _ignoredMcpConfig,
    // Strip any client-supplied `permissionPolicy`: the runtime gate TRUSTS this
    // field, so it must only ever be the server-resolved snapshot below — a
    // client must not be able to inject `riskByTool` or bypass the opt-in.
    permissionPolicy: _ignoredClientPermissionPolicy,
    permissionPolicyRequest,
    // Strip any client-supplied `hookRunner` for the same reason: it is the
    // TRUSTED, server-built closure (below). The renderer only ATTESTS approved
    // hashes via `hookTrustRequest`, which the server re-hashes against disk.
    hookRunner: _ignoredClientHookRunner,
    hookTrustRequest,
    // Strip any client-supplied `personaProviderApiKeys`: pinned-persona keys
    // are server-resolved from the secrets bridge below — a client must never
    // inject credentials into the runtime.
    personaProviderApiKeys: _ignoredClientPersonaKeys,
    // Strip any client-supplied `workspaceSkills`: the skills engine is the
    // TRUSTED, server-built object over the SecureRoot scan (below). The
    // renderer only sends the `skillsPreference` wire field, which can only
    // REDUCE the skill set.
    workspaceSkills: _ignoredClientWorkspaceSkills,
    // Strip any client-supplied overlay lookup. Only the host-injected closure
    // passed as an initializer dependency may reach the agent runtime.
    compactionOverlayLookup: _ignoredClientCompactionOverlayLookup,
    contextOverflowRecovery: _ignoredClientContextOverflowRecovery,
    toolProjectionRewriteLookup: _ignoredClientProjectionRewriteLookup,
    // The renderer's persona availability preference; resolved (with the
    // user-persona disk scan) into `runtime.personas` below.
    subagentPersonasRequest,
    ...runtimeWithoutMcpConfig
  } = runtimeData ?? {};
  const trustedRuntimeData: RuntimeData = {
    ...runtimeWithoutMcpConfig,
    ...trustedCompactionOverlayFields(compactionOverlayLookup),
    ...trustedProjectionRewriteFields(toolProjectionRewriteLookup),
  };
  const permissionPolicy = resolveRequestPermissionPolicy(permissionPolicyRequest);

  // Subagent personas: built-ins + user-defined (scanned from
  // `.brainstrike/agents` under each mounted root and the home dir), with the
  // renderer's availability preference applied and cross-provider pin keys
  // resolved from the secrets bridge. Set on the shared runtime so BOTH the
  // initial turn and the approval/suspend-resume paths keep the `agent-<id>`
  // delegation tools; the agent runtime skips personas for the built-in local
  // provider (D10).
  const personaRuntimeFields = await resolvePersonaRuntimeFields(
    trustedRuntimeData,
    subagentPersonasRequest,
    resolveProviderApiKey,
    deps
  );

  let initializationStage: AgentStreamInitializationStage = 'provider_model_bootstrap';
  try {
    // trustedRuntimeData for consistency with every other capability builder
    // below, even though resolveLocalLlmHostClient today only reads
    // `provider`/`memory.memorySettings.observationalMemory.modelTarget` —
    // neither field is stripped, so this was a no-op-in-practice inconsistency
    // (raw `runtimeData` was never intentional here) rather than a live bug.
    const localLlmHostClient = resolveLocalLlmHostClient(trustedRuntimeData, toolDependencies);
    // Tool-lifecycle hooks (desktop): build the per-request manager over the
    // mounted roots + server-resolved trust. Hook run events flow through the
    // same queued sink the memory + stream observer drain, so hook.blocked and
    // hook.notice reach the timeline. The queue is hoisted here (was built with
    // memory below) so the manager can push into it.
    const queuedRunEvents: AssistantRunEvent[] = [];
    // TRUSTED server-built runner (never the client-supplied one, stripped above);
    // present iff valid hooks exist.
    const { manager: hookManager, runner: hookRunner } = capabilities.hooks.prepare({
      emitRunEvent: (event) => queuedRunEvents.push(capabilities.hooks.eventToAssistant(event)),
      hookTrustRequest,
      logger,
      runId,
      runtimeData: trustedRuntimeData,
    });
    // Agent Skills: TRUSTED server-built engine over the SecureRoot scan of the
    // four skills tiers (mounted roots + home dir), with the renderer's
    // preference applied (master toggle / per-skill disables — reduce-only).
    // Undefined when skills are off or the provider is the built-in local model.
    const skillsRuntimeFields = prepareRequestSkillsFromDisk(trustedRuntimeData, deps);
    const artifactCapabilities = buildToolOutputArtifactCapabilities(
      trustedRuntimeData,
      runId,
      getDatabase,
      deps
    );
    const resolvedToolResultBudget = resolveToolBuildBudget(trustedRuntimeData, logger);
    initializationStage = 'native_tool_preferences';
    const mastraTools = capabilities.tools.build(
      trustedRuntimeData,
      withResolvedToolResultBudget(
        withSkillScriptResolver(
          withToolOutputArtifactReader(
            toolDependencies,
            artifactCapabilities.toolOutputArtifactReader
          ),
          skillsRuntimeFields.workspaceSkills
        ),
        resolvedToolResultBudget
      )
    );
    initializationStage = 'provider_model_bootstrap';
    const runtime: RuntimeData = {
      ...trustedRuntimeData,
      // The execute-risk shell tool is registered like every other native tool;
      // the permission gate (enforce-on-by-default → execute:ask) suspends the
      // run for per-call approval before it executes, so it is no longer gated at
      // registration time.
      mastraTools,
      mcpEnabled: true,
      signal, // ← AbortSignal passed here, used by stream iterator
      // Always set: an empty list yields no <current-task-list> block (the note
      // builder returns null), so no branch is needed here.
      taskList,
      ...(mcpConfig ? { mcpConfig } : {}),
      // BST-1352 review: NO bearer key on the runtime — RuntimeData reaches
      // Mastra RequestContext serialization; credentials travel ONLY as the
      // direct authInput parameter.
      ...(localLlmHostClient ? { localLlmHostClient } : {}),
      ...(permissionPolicy ? { permissionPolicy } : {}),
      ...(hookRunner ? { hookRunner } : {}),
      // TRUSTED server-built skills engine (or nothing when skills are off).
      ...skillsRuntimeFields,
      // Resolved subagent personas (built-in + user-defined, availability
      // preference applied) + pinned-provider keys — see resolvePersonaRuntimeFields.
      ...personaRuntimeFields,
    };
    // Cold model loads (multi-GB download) exceed the generate request's hard
    // 5-minute ceiling, so warm the host (20-minute ceiling, progress-aware)
    // before the Mastra loop or observational memory issues a generation.
    if (localLlmHostClient) {
      for (const modelId of collectLocalLlmWarmupModelIds(runtimeData)) {
        await localLlmHostClient.warmup(modelId, { signal });
      }
    }
    const memoryResult = runtime.memory
      ? await capabilities.memory.create(
          runtime.memory.memorySettings,
          runId,
          runId
            ? (event) => {
                queuedRunEvents.push({ ...event, runId });
              }
            : undefined,
          runtime,
          { embeddingHostManager: toolDependencies.embeddingHostManager }
        )
      : undefined;
    if (toolApprovalAction && !memoryResult?.storage) {
      return {
        ok: false,
        payload: {
          error: 'tool_approval_memory_required',
          message: 'Tool approval resume requires Mastra memory context with workflow storage.',
        },
        status: 400,
      };
    }
    if (toolResumeAction && !memoryResult?.storage) {
      return {
        ok: false,
        payload: {
          error: 'tool_resume_memory_required',
          message: 'Tool suspend resume requires Mastra memory context with workflow storage.',
        },
        status: 400,
      };
    }
    // @file context-insert: resolve any `:file[…]{name=…}` directives in the
    // current turn's user message into a prepended `system` context message
    // carrying the referenced files' content. Uses the same containment/size/
    // binary-guarded reader as the read tools; unresolvable references surface a
    // visible note rather than being silently dropped. Skipped on the approval-
    // resume path (no new user turn to scan).
    const memoryOptions = buildInitialStreamMemoryOptions(
      memoryResult,
      artifactCapabilities.toolOutputArtifactStore,
      Math.min(
        capabilities.webExtractInlineMaxSerializedChars,
        resolvedToolResultBudget.domainModelResultCharBudget
      ),
      authInput,
      { mcpAppAdmission, mcpHost, mcpTaskTracking }
    );

    // UserPromptSubmit (blocking): only on a FRESH turn (never the approval/
    // resume path — no new user message to gate). A block short-circuits the
    // turn with a visible message + run.failed and NEVER invokes the model;
    // additionalContext is prepended as a system message (mirrors @file inject).
    // Run-event observer wrapper (a no-op when there is no runId to stamp).
    const observe = (source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> =>
      runId
        ? capabilities.runPersistence.persistTokenEstimateCalibration(
            capabilities.runPersistence.persistToolCallTelemetry(
              capabilities.runPersistence.persistChildRunUsage(
                capabilities.runPersistence.observeRunEvents(
                  source,
                  runId,
                  queuedRunEvents,
                  getDatabase
                ),
                runId,
                resolveDesktopObserverUsageTarget(runtime.memory?.memorySettings),
                getDatabase,
                Boolean(memoryResult?.conversationBinding)
              ),
              runId,
              getDatabase
            ),
            runId,
            getDatabase
          )
        : source;

    const upsGate = await capabilities.hooks.runUserPromptSubmitGate(
      hookManager,
      messages,
      Boolean(toolApprovalAction || toolResumeAction)
    );
    if (upsGate.kind === 'block') {
      // The blocked turn still streams a visible message + run.failed, but it
      // never invokes the model — record the run row as failed (not completed)
      // so persistence matches the visible failure.
      return {
        ok: true,
        stream: observe(capabilities.hooks.makeBlockedStream(upsGate.reason)),
        terminalError: upsGate.reason,
        terminalStatus: 'failed',
      };
    }

    const preRequestCompaction = await runConversationCompactionBeforeStream({
      capabilities,
      logger,
      memoryResult,
      messages: upsGate.messages,
      runId,
      runtime,
      signal,
    });

    initializationStage = 'stream_construction';
    const initialStream = await resolveInitialAgentStream({
      deps,
      memoryOptions,
      messages: upsGate.messages,
      runtime,
      toolApprovalAction,
      toolResumeAction,
    });
    const stream = withCompactionPreludeChunks(initialStream, preRequestCompaction);
    logger.info('Assistant stream initialized');
    // Stop (notify-only in v1): fire the terminal Stop hook best-effort when the
    // stream ends (clean/error/abort). Its run events ride the queued sink the
    // observer drains. A Stop hook may additionally report a Task Ledger
    // verdict for the run (source 'hook'): recorded here via the main-process
    // DB handle, awaited in FRONT of the finish yield so it lands before the
    // post-stream terminal bookkeeping. Without a runId there is no run to
    // label, so no recorder is threaded (hooks themselves still run).
    return {
      ok: true,
      stream: capabilities.hooks.finalize(stream, {
        logger,
        manager: hookManager,
        observe,
        ...buildHookRunVerdictRecorder(runId, getDatabase, deps),
        runner: hookRunner,
        signal,
      }),
    };
  } catch (error) {
    return buildAgentStreamInitializationFailure(error, initializationStage, deps);
  }
}
