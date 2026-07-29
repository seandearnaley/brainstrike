import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type {
  AgentMessage,
  AssistantRunEvent,
  AssistantTaskItem,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  McpConfig,
  RuntimeData,
  ScannedWorkspaceSkills,
  ScopedToolOutputArtifactReader,
  StreamChunk,
  ToolOutputArtifactSettlementStore,
} from '@brainstrike/agent';
import {
  resolveRequestPermissionPolicy,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { ToolOutputArtifactRepository } from '@brainstrike/db';
import type { DesktopDatabase } from '../db-main';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { DesktopAssistantToolDependencies } from './assistant-tools';
import { buildDesktopAssistantTools } from './assistant-tools';
import type { HookRunVerdict } from './hooks/run-verdict';
import {
  finalizeHookedStream,
  hookRunEventToAssistant,
  makeHookBlockedStream,
  prepareRequestHooks,
  runUserPromptSubmitGate,
} from './hooks/server-integration';
import type { AssistantLlmHostManager } from './local-llm-host-client';
import {
  collectLocalLlmWarmupModelIds,
  isLocalChatProvider,
  resolveLocalLlmHostClient,
} from './local-provider-runtime';
import { desktopAssistantServerLogger as logger } from './logger';
import {
  type DesktopMastraMemoryResult,
  DesktopMemoryCredentialMissingError,
  getDesktopMastraMemory,
} from './mastra-memory';
import { resolveDesktopObserverUsageTarget } from './memory-model-targets';
import { createNodeFsScanDeps } from './node-fs-scan-deps';
import { injectReferencedFilesContext } from './referenced-files-context';
import { resolveRequestPersonas } from './request-personas';
import { prepareRequestSkills } from './request-skills';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
  recordDesktopAssistantHookRunOutcome,
} from './run-persistence';
import { getSecretReadErrorPayload } from './secret-error-responses';
import type {
  AgentStreamFailure,
  AgentStreamInitializationStage,
  AgentStreamResult,
} from './server-types';
import { injectActivatedSkillsContext } from './skills-activation-context';
import { createSecureSkillsFs } from './skills-fs-deps';
import { readThreadTaskList } from './task-list-repository';
import { scanUserPersonas } from './user-personas-loader';
import { WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS } from './web-extract-model-projection';
import { injectWorkspaceInstructionsContext } from './workspace-instructions-context';
import {
  BoundWorkspaceRootUnavailableError,
  enrichRuntimeDataWithWorkspaceRoots,
} from './workspace-roots';
import { readWorkspaceTextFile } from './workspace-text-file-reader';

/**
 * Read the current thread's task list for re-injection this turn. Returns `[]`
 * when there is no thread, no DB, the run targets the built-in local provider,
 * or the read fails (a warn is logged) — an absent plan is a legitimate empty
 * state, not a swallowed policy fallback. The local-provider skip is the
 * DB-read-avoiding gate of the same policy enforced again (defense in depth)
 * by the provider check on `taskListNote` in agent-runtime.ts, and by omitting
 * the manageTaskList tool for local in buildDesktopAssistantTools.
 */
async function readThreadTaskListForTurn(
  runtimeData: RuntimeData | undefined,
  database: Parameters<typeof readThreadTaskList>[0] | null
): Promise<readonly AssistantTaskItem[]> {
  const threadId = runtimeData?.memory?.threadId;
  if (!(threadId && database) || isLocalChatProvider(runtimeData)) {
    return [];
  }
  try {
    return await readThreadTaskList(database, threadId);
  } catch (error) {
    logger.warn('Failed to read thread task list; no task-list block this turn.', { error });
    return [];
  }
}

interface InitialStreamMemoryOptions {
  memory?: DesktopMastraMemoryResult['memory'];
  storage?: DesktopMastraMemoryResult['storage'];
  toolOutputArtifactInlineMaxSerializedCharsByToolName?: ReadonlyMap<string, number>;
  toolOutputArtifactStore?: ToolOutputArtifactSettlementStore;
}

interface ToolOutputArtifactCapabilities {
  toolOutputArtifactReader?: ScopedToolOutputArtifactReader;
  toolOutputArtifactStore?: ToolOutputArtifactSettlementStore;
}

function buildToolOutputArtifactCapabilities(
  runtimeData: RuntimeData | undefined,
  runId: string | undefined,
  getDatabase: AgentStreamDatabaseProvider
): ToolOutputArtifactCapabilities {
  const resourceId = runtimeData?.memory?.resourceId;
  const threadId = runtimeData?.memory?.threadId;
  if (!(resourceId && threadId)) {
    return {};
  }
  const toolOutputArtifactReader: ScopedToolOutputArtifactReader = {
    readRange: async (input) => {
      const database = await getDatabase();
      return new ToolOutputArtifactRepository(database).readRange({
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
        return new ToolOutputArtifactRepository(database).store({
          ...input,
          resourceId,
          runId,
          threadId,
        });
      },
    },
  };
}

function withToolOutputArtifactReader(
  dependencies: DesktopAssistantToolDependencies,
  reader: ScopedToolOutputArtifactReader | undefined
): DesktopAssistantToolDependencies {
  if (!reader) {
    return dependencies;
  }
  return { ...dependencies, toolOutputArtifactReader: reader };
}

function withSkillScriptResolver(
  dependencies: DesktopAssistantToolDependencies,
  resolver: ReturnType<typeof prepareRequestSkillsFromDisk>['workspaceSkills']
): DesktopAssistantToolDependencies {
  if (!resolver) {
    return dependencies;
  }
  return { ...dependencies, skillScriptResolver: resolver };
}

function buildInitialStreamMemoryOptions(
  memoryResult: DesktopMastraMemoryResult | undefined,
  toolOutputArtifactStore: ToolOutputArtifactSettlementStore | undefined
): InitialStreamMemoryOptions {
  return {
    ...(memoryResult ? { memory: memoryResult.memory, storage: memoryResult.storage } : {}),
    ...(toolOutputArtifactStore
      ? {
          toolOutputArtifactInlineMaxSerializedCharsByToolName: new Map([
            [NATIVE_TOOL_ID.webExtract, WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS],
          ]),
          toolOutputArtifactStore,
        }
      : {}),
  };
}

/**
 * Pick the initial stream for the turn: approval-resume, suspend-resume
 * (submitPlan/askUser), or a fresh generation. Both resume paths skip
 * `injectReferencedFilesContext` — there is no new user turn to scan — mirroring
 * the approval path's contract.
 */
async function resolveInitialAgentStream(args: {
  messages: AgentMessage[];
  runtime: RuntimeData;
  memoryOptions: InitialStreamMemoryOptions;
  toolApprovalAction: AssistantToolApprovalAction | undefined;
  toolResumeAction: AssistantToolResumeAction | undefined;
}): Promise<AsyncIterable<StreamChunk>> {
  const { messages, runtime, memoryOptions, toolApprovalAction, toolResumeAction } = args;
  if (toolApprovalAction) {
    return streamMastraToolApprovalAction(toolApprovalAction, {
      ...memoryOptions,
      requireToolApproval: true,
      runtime,
    });
  }
  if (toolResumeAction) {
    return streamMastraToolResumeAction(toolResumeAction, { ...memoryOptions, runtime });
  }
  // Prepend the turn's `@file` references (referenced-files), then any explicit
  // `:skill[name]` activations, then the mounted roots' workspace instructions
  // (AGENTS.md/AGENT.md/CLAUDE.md). Instructions are applied LAST so they land
  // at the FRONT of the message array — general workspace conventions precede
  // the turn's skill activations, which precede the turn-specific referenced
  // files and the conversation. All are no-ops (same array identity) when
  // nothing applies.
  const withReferencedFiles = await injectReferencedFilesContext(
    messages,
    runtime,
    readWorkspaceTextFile
  );
  const withSkillActivations = await injectActivatedSkillsContext(
    withReferencedFiles,
    runtime.workspaceSkills
  );
  return toAiSdkStyleStream(
    await injectWorkspaceInstructionsContext(withSkillActivations, runtime, readWorkspaceTextFile),
    runtime,
    memoryOptions
  );
}

/**
 * Build the TRUSTED per-request Agent Skills engine over a SecureRoot fs
 * surface spanning the request's resolved workspace roots + the home dir.
 * Extracted from initializeAgentStream for the cognitive-complexity budget.
 */
function prepareRequestSkillsFromDisk(runtimeData: RuntimeData | undefined): {
  workspaceSkills?: ScannedWorkspaceSkills;
} {
  const { workspaceSkills } = prepareRequestSkills({
    fs: createSecureSkillsFs([
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

/**
 * Scan user-defined personas from disk over the request's already-resolved
 * workspace roots (SecureRoot-backed fs; disposed after the scan). Extracted
 * from initializeAgentStream for the cognitive-complexity budget.
 */
function scanUserPersonasFromDisk(
  workspaceRoots: RuntimeData['workspaceRoots']
): ReturnType<typeof scanUserPersonas> {
  const filesystem = createNodeFsScanDeps();
  try {
    const scanRoots = (workspaceRoots ?? [])
      .filter((root) => Boolean(root.path))
      .map((root) => ({
        absPath: root.path,
        displayName: root.displayName,
        id: root.rootId,
      }));
    return scanUserPersonas({ homeDir: homedir(), roots: scanRoots }, filesystem);
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
async function resolvePersonaRuntimeFields(
  runtimeData: RuntimeData | undefined,
  subagentPersonasRequest: RuntimeData['subagentPersonasRequest'],
  resolveProviderApiKey: AgentStreamProviderApiKeyReader
): Promise<Pick<RuntimeData, 'personas' | 'personaProviderApiKeys'>> {
  const resolved = await resolveRequestPersonas({
    logger,
    parentProvider: runtimeData?.provider ?? '',
    request: subagentPersonasRequest,
    resolveApiKey: resolveProviderApiKey,
    scanUserPersonas: () => scanUserPersonasFromDisk(runtimeData?.workspaceRoots),
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
function buildHookRunVerdictRecorder(
  runId: string | undefined,
  getDatabase: AgentStreamDatabaseProvider
): {
  onRunVerdict?: (verdict: HookRunVerdict) => Promise<void>;
} {
  if (!runId) {
    return {};
  }
  return {
    onRunVerdict: async (verdict: HookRunVerdict): Promise<void> => {
      const database = await getDatabase();
      await recordDesktopAssistantHookRunOutcome(database, runId, verdict);
    },
  };
}

function buildAgentStreamInitializationFailure(
  error: unknown,
  stage: AgentStreamInitializationStage
): AgentStreamFailure {
  const secretReadErrorPayload = getSecretReadErrorPayload(error);
  if (secretReadErrorPayload) {
    return {
      ok: false,
      payload: secretReadErrorPayload,
      status: 400,
    };
  }
  if (error instanceof DesktopMemoryCredentialMissingError) {
    return {
      ok: false,
      payload: {
        error: 'memory_credential_missing',
        feature: error.feature,
        message: error.message,
        provider: error.provider,
      },
      status: 400,
    };
  }
  const correlationId = randomUUID();
  logger.error('Failed to initialize assistant stream', { correlationId, error, stage });
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

function buildWorkspaceRootResolutionFailure(error: unknown): AgentStreamFailure {
  if (error instanceof BoundWorkspaceRootUnavailableError) {
    return {
      ok: false,
      payload: {
        error: 'bound_workspace_root_unavailable',
        message: error.message,
        stage: 'workspace_root_resolution',
      },
      status: 409,
    };
  }
  return buildAgentStreamInitializationFailure(error, 'workspace_root_resolution');
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
 * Injected main-process database provider (BST-972 A2). A provider, not a
 * resolved handle, for the same reason as run-persistence.ts: each use awaits
 * the current handle exactly where the previous direct `getDatabase()` calls
 * did. The desktop composition site (assistant-server.ts) passes db-main's
 * `getDatabase` verbatim; the type-only `DesktopDatabase` import is erased at
 * runtime, so this module no longer names db-main directly. (It still loads
 * db-main transitively via ./mastra-memory and ./assistant-tools — those edges
 * are later slices in the BST-972 sequence.)
 */
export type AgentStreamDatabaseProvider = () => Promise<DesktopDatabase>;

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
 * Params object rather than positional arguments (ruling from the #2115
 * review): dependencies accumulate here slice by slice, and adjacent
 * positional parameters stay mistake-proof only while their types happen to
 * differ — desktop's type-check excludes test files, so a missed test call
 * site would surface only at runtime.
 */
export interface InitializeAgentStreamParams {
  readonly apiKey: string | undefined;
  readonly getDatabase: AgentStreamDatabaseProvider;
  readonly mcpConfig: McpConfig | undefined;
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
    readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
    readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
  };
  readonly toolResumeAction: AssistantToolResumeAction | undefined;
}

export async function initializeAgentStream(
  params: InitializeAgentStreamParams
): Promise<AgentStreamResult> {
  const {
    messages,
    runtimeData: incomingRuntimeData,
    apiKey,
    mcpConfig,
    signal,
    runId,
    toolApprovalAction,
    toolResumeAction,
    toolDependencies,
    getDatabase,
    resolveProviderApiKey,
  } = params;
  // Multi-root: resolve the active workspace roots from the DB `roots` table so
  // the assistant's file/search tools can disambiguate paths across roots. The
  // helper falls back to the single focused root on an empty/failed lookup.
  const rootsDatabase = await getDatabase().catch((error: unknown) => {
    logger.warn('Workspace roots DB unavailable; tools fall back to the focused root.', { error });
    return null;
  });
  let runtimeData: RuntimeData | undefined;
  try {
    runtimeData = await enrichRuntimeDataWithWorkspaceRoots(
      stripClientWorkspaceRoots(incomingRuntimeData),
      rootsDatabase
    );
  } catch (error) {
    return buildWorkspaceRootResolutionFailure(error);
  }

  // Re-inject the current per-thread task list into the instructions this
  // turn (see readThreadTaskListForTurn for the local-provider skip).
  const taskList = await readThreadTaskListForTurn(runtimeData, rootsDatabase);

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
    // The renderer's persona availability preference; resolved (with the
    // user-persona disk scan) into `runtime.personas` below.
    subagentPersonasRequest,
    ...runtimeWithoutMcpConfig
  } = runtimeData ?? {};
  const permissionPolicy = resolveRequestPermissionPolicy(permissionPolicyRequest);

  // Subagent personas: built-ins + user-defined (scanned from
  // `.brainstrike/agents` under each mounted root and the home dir), with the
  // renderer's availability preference applied and cross-provider pin keys
  // resolved from the secrets bridge. Set on the shared runtime so BOTH the
  // initial turn and the approval/suspend-resume paths keep the `agent-<id>`
  // delegation tools; the agent runtime skips personas for the built-in local
  // provider (D10).
  const personaRuntimeFields = await resolvePersonaRuntimeFields(
    runtimeData,
    subagentPersonasRequest,
    resolveProviderApiKey
  );

  let initializationStage: AgentStreamInitializationStage = 'provider_model_bootstrap';
  try {
    const localLlmHostClient = resolveLocalLlmHostClient(runtimeData, toolDependencies);
    // Tool-lifecycle hooks (desktop): build the per-request manager over the
    // mounted roots + server-resolved trust. Hook run events flow through the
    // same queued sink the memory + stream observer drain, so hook.blocked and
    // hook.notice reach the timeline. The queue is hoisted here (was built with
    // memory below) so the manager can push into it.
    const queuedRunEvents: AssistantRunEvent[] = [];
    // TRUSTED server-built runner (never the client-supplied one, stripped above);
    // present iff valid hooks exist.
    const { manager: hookManager, runner: hookRunner } = prepareRequestHooks({
      emitRunEvent: (event) => queuedRunEvents.push(hookRunEventToAssistant(event)),
      hookTrustRequest,
      logger,
      runId,
      runtimeData,
    });
    // Agent Skills: TRUSTED server-built engine over the SecureRoot scan of the
    // four skills tiers (mounted roots + home dir), with the renderer's
    // preference applied (master toggle / per-skill disables — reduce-only).
    // Undefined when skills are off or the provider is the built-in local model.
    const skillsRuntimeFields = prepareRequestSkillsFromDisk(runtimeData);
    const artifactCapabilities = buildToolOutputArtifactCapabilities(
      runtimeData,
      runId,
      getDatabase
    );
    initializationStage = 'native_tool_preferences';
    const mastraTools = buildDesktopAssistantTools(
      runtimeData,
      withSkillScriptResolver(
        withToolOutputArtifactReader(
          toolDependencies,
          artifactCapabilities.toolOutputArtifactReader
        ),
        skillsRuntimeFields.workspaceSkills
      )
    );
    initializationStage = 'provider_model_bootstrap';
    const runtime: RuntimeData = {
      ...runtimeWithoutMcpConfig,
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
      ...(apiKey ? { apiKey } : {}),
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
      ? await getDesktopMastraMemory(
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
      artifactCapabilities.toolOutputArtifactStore
    );

    // UserPromptSubmit (blocking): only on a FRESH turn (never the approval/
    // resume path — no new user message to gate). A block short-circuits the
    // turn with a visible message + run.failed and NEVER invokes the model;
    // additionalContext is prepended as a system message (mirrors @file inject).
    // Run-event observer wrapper (a no-op when there is no runId to stamp).
    const observe = (source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> =>
      runId
        ? persistDesktopChildRunUsage(
            observeDesktopAssistantRunEvents(source, runId, queuedRunEvents, getDatabase),
            runId,
            resolveDesktopObserverUsageTarget(runtime.memory?.memorySettings),
            getDatabase
          )
        : source;

    const upsGate = await runUserPromptSubmitGate(
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
        stream: observe(makeHookBlockedStream(upsGate.reason)),
        terminalError: upsGate.reason,
        terminalStatus: 'failed',
      };
    }

    initializationStage = 'stream_construction';
    const stream = await resolveInitialAgentStream({
      memoryOptions,
      messages: upsGate.messages,
      runtime,
      toolApprovalAction,
      toolResumeAction,
    });
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
      stream: finalizeHookedStream(stream, {
        logger,
        manager: hookManager,
        observe,
        ...buildHookRunVerdictRecorder(runId, getDatabase),
        runner: hookRunner,
        signal,
      }),
    };
  } catch (error) {
    return buildAgentStreamInitializationFailure(error, initializationStage);
  }
}
