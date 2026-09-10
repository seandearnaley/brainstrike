import { type McpHostPort, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { createLogger } from '@brainstrike/logging';
import { Agent, type MastraDBMessage, type ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Mastra } from '@mastra/core/mastra';
import type { MastraMemory } from '@mastra/core/memory';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { AssistantResilienceConfig } from '../config/resilience-config';
import type { McpConfig } from '../mcp/config';
import type { McpTaskTrackingCapability } from '../mcp/task-tracking';
import type { ProviderAuthInput } from '../providers/provider-auth-input';
import {
  createProviderCallWarningSink,
  type ProviderCallWarningSink,
  wrapModelWithCallWarningCapture,
} from '../providers/provider-call-warnings';
import { createProvider, getDefaultModel } from '../providers/provider-factory';
import {
  resolveToolResultBudgetForModel,
  type ScaledToolResultBudget,
} from '../stream/tool-output-limits';
import type { AgentHookRunner } from '../tools/hook-runner';
import type { ToolExecutionDurations } from '../tools/tool-execution-durations';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type { AgentMessage, RuntimeData } from '../types';
import {
  type CacheAwareInstructions,
  composeCacheAwareInstructions,
} from './anthropic-instruction-cache';
import {
  buildContextBudgetNote,
  buildCurrentDateNote,
  buildCurrentTaskListNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
  type DelegationPersonaSummary,
} from './default-instructions';
import type { DelegatedConversationBinding } from './delegated-conversation-binding';
import {
  createDelegatedTurnPersistence,
  type DelegatedTurnPersistence,
} from './delegated-turn-persistence';
import { ASSISTANT_MAX_PROCESSOR_RETRIES, buildAssistantErrorProcessors } from './error-processors';
import { createMastraAgentError, isMastraAgentError } from './mastra-agent-error';
import type { McpAppToolAdmissionCapability } from './mcp-app-tool-call';
import type { McpDiscoverySkip } from './mcp-discovery-diagnostics';
import type { McpRuntimeClient } from './mcp-runtime-client';
import type { PermissionAskToolMetadata, PermissionToolGateSnapshot } from './permission-tool-gate';
import { createPersonaPinnedModelResolver } from './persona-pinned-model';
import type { ProjectionSafeToolCallFilter } from './projection-safe-tool-call-filter';
import { computeInstructionBreakdown, type InstructionBreakdown } from './prompt-breakdown';
import { createAssistantMessageIdGenerator } from './runtime-assembly/assistant-message-id';
import { resolvePersonaRuntimeParts } from './runtime-assembly/persona-assembly';
import {
  composeRuntimeToolMap,
  createToolHistoryFilter,
  prepareHostedToolDiscovery,
} from './runtime-assembly/tool-pipeline';
import {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './runtime-configuration';
import type { RunTokenDiagnostics } from './token-measurement';
import type { ToolOutputArtifactSettlementStore } from './tool-output-artifact-settlement';
import type { BrainstrikeToolSearchProcessor, ToolDiscoveryMetadata } from './tool-search-runtime';

export interface MastraAgentRuntimeOptions {
  /**
   * Provider auth input for the run's language model (BST-1352). A DIRECT
   * option by contract — never read from `runtime`: RuntimeData must not carry
   * auth inputs (RequestContext.toJSON drops functions, so a custom_fetch
   * closure riding RuntimeData would vanish silently). Absent falls back to
   * the legacy runtime/env key resolution.
   */
  authInput?: ProviderAuthInput;
  /** Host-owned native identity persistence; never serialized through RuntimeData. */
  conversationBinding?: DelegatedConversationBinding | undefined;
  /**
   * Server-injected tool-lifecycle hook runner (desktop). Composed OUTSIDE the
   * guard and BEFORE the permission gate. Overrides `runtime.hookRunner` when
   * both are present. OPTIONAL — absent means no hooks (production default).
   */
  hookRunner?: AgentHookRunner;
  /** @internal Rehydrate context-backed deferred tools before a fresh resume runtime executes. */
  hydrateToolDiscoveryFromMemory?: boolean;
  instructions?: string;
  /** Live-run observer for the Apps ordinary-tool admission capability. */
  mcpAppAdmission?: McpAppAdmissionObserver;
  mcpConfig?: McpConfig;
  /** Host-owned MCP authority. Runtime disposal releases only its adapter lease. */
  mcpHost?: McpHostPort;
  /**
   * Trusted host capability that owns MCP Tasks (BST-1566): a task-creating
   * tool result is tracked by it and the tool settles on the bounded task
   * presentation. Absent (web, no host) keeps every MCP call synchronous and a
   * task result becomes a hard error rather than an untracked task.
   */
  mcpTaskTracking?: McpTaskTrackingCapability;
  // Optional timeout (ms) for initial MCP tool discovery
  mcpTimeoutMs?: number;
  memory?: MastraMemory;
  model?: string;
  /**
   * Pre-built language model to use INSTEAD of resolving provider/model. When
   * set, `createProvider`/`getDefaultModel` are skipped entirely — the sole
   * consumer is the suspended-run DISCOVERY path (see `createListingOnlyModel`),
   * which needs a runtime with no inference and must not require a provider key
   * or a static default model. Never set on a real chat/resume turn.
   */
  modelOverride?: MastraModelConfig;
  /**
   * Serializable permission posture + tool risk classification used to gate the
   * tool map before the Agent is built. Overrides `runtime.permissionPolicy`
   * when both are present. OPTIONAL — when neither is set the tool map is
   * unchanged (production-default).
   */
  permissionPolicy?: PermissionToolGateSnapshot;
  /**
   * Built-in subagent personas the supervisor may delegate to. Server-set,
   * agent-only (mirrors `mastraTools`). When present AND the provider is not
   * `'local'` (D10), each persona becomes an `agent-<id>` delegation tool.
   */
  personas?: readonly AssistantPersonaDefinition[];
  /** @internal Preserve the implementation captured by an already-suspended web-search call. */
  preserveExecuteBackedWebSearch?: boolean;
  requireToolApproval?: boolean;
  resolved?: ResolvedRuntimeConfiguration;
  runtime?: RuntimeData;
  storage?: MastraCompositeStore;
  /**
   * Optional stricter inline ceilings for tools whose complete domain
   * projection must fit below the generic artifact settlement threshold.
   */
  toolOutputArtifactInlineMaxSerializedCharsByToolName?: ReadonlyMap<string, number>;
  /**
   * Trusted host capability for complete oversized tool-output retention.
   * Absent keeps the temporary inline MCP ceilings active.
   */
  toolOutputArtifactStore?: ToolOutputArtifactSettlementStore;
  tools?: ToolsInput;
}

export interface McpAppAdmissionObserver {
  register(admission: McpAppToolAdmissionCapability): () => void;
}

export interface MastraAgentRuntime {
  agent: Agent;
  /**
   * Sanitized id → risk metadata for every tool the permission gate resolved to
   * `'ask'` and KEPT in the map (each carrying the per-tool `requireApproval`
   * flag). Non-empty when the run has approval-gated mutation tools; used for the
   * approval-pause risk hint and observability. Empty when no policy is enforced,
   * every tool resolved to allow/deny, or ask tools were fail-safe-omitted for
   * lack of resume storage.
   */
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  /** Fail-loud completion check for the client-provided persisted assistant id. */
  assertAssistantMessageIdPersisted?: () => void;
  conversationBinding?: DelegatedConversationBinding | undefined;
  delegatedTurnPersistence?: DelegatedTurnPersistence | undefined;
  /**
   * 'agent-<personaId>' → personaId for every registered delegation tool. Empty
   * when personas are absent/skipped. Consumed by the stream mapper (T4) to emit
   * `subagent.*` run events keyed by the delegation toolCallId.
   */
  delegationToolPersonas: ReadonlyMap<string, string>;
  dispose: () => Promise<void>;
  /**
   * Instruction-side heuristic token counts, captured where the composed system
   * instructions were finalized. Combined with the message-side counts at
   * stream start (computePromptBreakdown) and emitted as the transient
   * `brainstrike.context-breakdown` data part.
   */
  instructionBreakdown: InstructionBreakdown;
  /** App-originated admission captured from this runtime's admitted tool map. */
  mcpAppToolAdmission: McpAppToolAdmissionCapability;
  mcpClient?: McpRuntimeClient;
  /**
   * Every MCP server that contributed ZERO tools to this run (BST-1602) —
   * discovery lost its timeout race, or that server's `listTools` failed. Empty
   * when discovery was healthy or no MCP client existed.
   *
   * REQUIRED, never optional: an empty array means "discovery was healthy",
   * which must stay distinguishable from "nobody looked". Consumed by the fresh
   * turn's stream prelude, which mints one `mcp.tools.unavailable` run event per
   * entry. Content-free, like {@link tokenDiagnostics} and {@link toolDiscovery}.
   */
  mcpDiscoverySkips: readonly McpDiscoverySkip[];
  /**
   * Whether a permission-policy snapshot was enforced when this runtime built its
   * tool map. It DISAMBIGUATES an empty {@link askTools}: empty because a policy
   * WAS enforced but resolved nothing to `'ask'` (every remaining tool is
   * allowed — e.g. after "Allow all tools this session" grants all categories)
   * vs. empty because NO policy was enforced at all. The approval-resume gate
   * (`resolveResumeApprovalGate`) needs this: the former is an all-allowed
   * posture (gate nothing), the latter with run-wide `requireToolApproval: true`
   * is a genuine explicit GLOBAL approval (gate every non-internal tool).
   */
  permissionEnforced: boolean;
  /** Persona id → definition for the registered delegation tools (delegation caps). */
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  /**
   * Provider warnings this run's model reported about the requests it served
   * (BST-1701). Filled UNDER Mastra by the model observer, drained into
   * always-visible run-event rows by `streamAttemptChunks`.
   *
   * `undefined` when the provider is configured by DESCRIPTOR rather than by
   * model instance (ollama, lmstudio): Mastra builds those models itself, so
   * there is no Brainstrike-owned seam to observe. Their OpenAI-compatible
   * route forwards sampling params rather than dropping them, so no signal is
   * being discarded there today - see docs/agents/assistant-providers.md.
   * Required-with-`undefined` (like `toolHistoryFilter`) so an assembled
   * runtime always states which of the two it is.
   */
  providerCallWarnings: ProviderCallWarningSink | undefined;
  resilienceConfig: AssistantResilienceConfig;
  /** Per-run budget shared by fresh producers and runtime projection guards. */
  resolvedToolResultBudget: ScaledToolResultBudget;
  /** Bounded, content-free token measurements for this concrete run/tool map. */
  tokenDiagnostics: RunTokenDiagnostics;
  /** Content-free discovery surface metadata for traces, tests, and diagnostics. */
  toolDiscovery?: ToolDiscoveryMetadata;
  /**
   * How long each tool's `execute` ACTUALLY ran, keyed by tool-call id.
   *
   * The stream mapper stamps it onto the terminal tool run event, because
   * wall-clock between `tool.started` and that event is not execution time for
   * an approval-gated call — the gate suspends before `execute` is invoked, so
   * the gap spans the human approval wait. See tool-execution-durations.ts.
   */
  toolExecutionDurations: ToolExecutionDurations;
  /** Hosted-only transient filter for safely projected stale tool history. */
  toolHistoryFilter: ProjectionSafeToolCallFilter | undefined;
  toolNameMap: Map<string, string>;
  /** Internal per-runtime processor reused by initial and both resume paths. */
  toolSearchProcessor?: BrainstrikeToolSearchProcessor;
}

const logger = createLogger('MastraAgent');

/**
 * Attach BST-1701's provider-warning observer to a model instance.
 *
 * `createProvider` returns EITHER a model instance (every hosted provider plus
 * the built-in local runtime) or a Mastra model DESCRIPTOR (ollama, lmstudio),
 * and only an instance carries the `doStream`/`doGenerate` seam the observer
 * reads. A descriptor is handed back untouched with NO sink: Mastra
 * materializes that model itself, so the boundary is structural. It is
 * narrowed explicitly instead of being wrapped into a proxy that could never
 * observe anything, so the gap stays documented rather than silent.
 */
function observeProviderCallWarnings(languageModel: MastraModelConfig): {
  model: MastraModelConfig;
  sink: ProviderCallWarningSink | undefined;
} {
  const isInstance =
    typeof languageModel === 'object' &&
    languageModel !== null &&
    typeof (languageModel as { doStream?: unknown }).doStream === 'function';
  if (!isInstance) {
    return { model: languageModel, sink: undefined };
  }
  const sink = createProviderCallWarningSink();
  return {
    model: wrapModelWithCallWarningCapture(languageModel as object, sink) as MastraModelConfig,
    sink,
  };
}

function instantiateLanguageModel(
  provider: string,
  auth: ProviderAuthInput | undefined,
  modelName: string,
  runtime: RuntimeData | undefined
): MastraModelConfig {
  try {
    return createProvider(provider, auth, modelName, runtime);
  } catch (error) {
    if (isMastraAgentError(error)) {
      throw error;
    }
    const detail =
      error instanceof Error && error.message ? error.message : 'provider creation failed';
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      cause: error,
      context: { model: modelName, provider },
      detail,
    });
  }
}

/** AI-SDK v5 user-content parts Mastra's MessageList accepts directly. */
interface MastraContentTextPart {
  text: string;
  type: 'text';
}
interface MastraContentImagePart {
  image: string;
  mediaType: string;
  type: 'image';
}
type MastraMessageContent = string | Array<MastraContentImagePart | MastraContentTextPart>;

export function convertMessagesToMastra(
  messages: AgentMessage[]
): Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: MastraMessageContent }> {
  const result: Array<{
    content: MastraMessageContent;
    id: string;
    role: 'user' | 'assistant' | 'system';
  }> = [];
  for (const message of messages) {
    const textParts: string[] = [];
    const imageParts: MastraContentImagePart[] = [];
    for (const part of message.parts) {
      if (part.type === 'file') {
        // Validated image attachment (message-utils enforces the shared
        // allowlist/caps). Emitted as the canonical AI-SDK user-message
        // ImagePart — the shape every provider adapter converts for vision.
        imageParts.push({ image: part.data, mediaType: part.mediaType, type: 'image' });
        continue;
      }
      if (part.type !== 'text') {
        continue;
      }
      const trimmed = part.text.trim();
      if (trimmed.length > 0) {
        textParts.push(trimmed);
      }
    }
    if (imageParts.length > 0) {
      // Content ARRAY only when an image is present; text-only messages keep
      // the exact legacy string join for prompt stability.
      result.push({
        content: [...textParts.map((text) => ({ text, type: 'text' as const })), ...imageParts],
        id: message.id,
        role: message.role,
      });
      continue;
    }
    if (textParts.length > 0) {
      result.push({ content: textParts.join('\n\n'), id: message.id, role: message.role });
    }
  }
  return result;
}

/**
 * Compose the final system instructions. The built-in local model gets a compact
 * instruction set (its 2B WebGPU prefill can't afford the hosted playbook); the
 * hosted path advertises only the personas that actually registered a delegation
 * tool this run. Order: instructions, budget note, task list LAST (most recent).
 */
function composeRuntimeInstructions(params: {
  budgetNote: string | null;
  instructionsOverride: string | undefined;
  /**
   * Prompt-assembly clock. Injected rather than read inside the builder so the
   * composed instructions stay a pure function of their inputs and the date
   * line is assertable without freezing global time.
   */
  now: Date;
  personaSummaries: DelegationPersonaSummary[] | undefined;
  planModeActive: boolean;
  provider: string;
  taskListNote: string | null;
  toolDiscoveryEnabled: boolean;
  toolNameMap: ReadonlyMap<string, string>;
}): { agentInstructions: CacheAwareInstructions; combinedText: string } {
  const resolvedInstructions =
    params.instructionsOverride ??
    (params.provider === 'local'
      ? buildLocalDefaultInstructions(params.toolNameMap)
      : buildDefaultInstructions(params.toolNameMap, {
          planMode: params.planModeActive,
          toolDiscoveryEnabled: params.toolDiscoveryEnabled,
          ...(params.personaSummaries ? { personas: params.personaSummaries } : {}),
        }));
  // Composed OUTSIDE the branch, deliberately. Threading the clock into
  // `buildDefaultInstructions` left the two other supported paths — the
  // built-in local model and a caller-supplied `instructionsOverride` —
  // shipping dateless prompts, which is the exact behaviour this prevents. The
  // local path arguably needs it most: a small local model is the least able to
  // recover from not knowing the date.
  //
  // Lands in `stableText` (the CACHED half) beside the budget note: a date
  // moves at most once a day, so it cannot churn the cached prefix the way a
  // timestamp would.
  const stableText = [resolvedInstructions, buildCurrentDateNote(params.now), params.budgetNote]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const combinedText = [stableText, params.taskListNote]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  return {
    agentInstructions: composeCacheAwareInstructions({
      provider: params.provider,
      stableText,
      volatileText: params.taskListNote,
    }),
    combinedText,
  };
}

function registerAgentWithMastra(
  agent: Agent,
  storage: MastraCompositeStore | undefined,
  assistantMessageId: string | undefined
): {
  assertAssistantMessageIdPersisted?: () => void;
  mastra?: Mastra;
} {
  if (!storage) {
    return {};
  }
  const assistantMessageIdGenerator = assistantMessageId
    ? createAssistantMessageIdGenerator(assistantMessageId)
    : undefined;
  const mastra = new Mastra({
    agents: { brainstrikeAssistant: agent },
    ...(assistantMessageIdGenerator ? { idGenerator: assistantMessageIdGenerator.generate } : {}),
    logger: false,
    storage,
  });
  return {
    ...(assistantMessageIdGenerator
      ? { assertAssistantMessageIdPersisted: assistantMessageIdGenerator.assertConsumed }
      : {}),
    mastra,
  };
}

function createPersistedDiscoveryMessageLoader(params: {
  enabled: boolean | undefined;
  memory: MastraMemory | undefined;
  memoryContext: RuntimeData['memory'];
}): (() => Promise<readonly MastraDBMessage[]>) | undefined {
  if (!params.enabled) {
    return;
  }
  if (!params.memory) {
    return;
  }
  if (!params.memoryContext) {
    return;
  }
  const { memory, memoryContext } = params;
  return async (): Promise<readonly MastraDBMessage[]> => {
    const recalled = await memory.recall({
      perPage: false,
      resourceId: memoryContext.resourceId,
      threadId: memoryContext.threadId,
    });
    return recalled.messages;
  };
}

/**
 * An app-free run can never mount an app: registering it would only detach
 * into a host watch on disposal and supersede the thread's still-mounted app
 * admission for nothing.
 */
function registerAppCapableAdmission(
  registry: MastraAgentRuntimeOptions['mcpAppAdmission'],
  admission: McpAppToolAdmissionCapability
): (() => void) | undefined {
  if (admission.appCapableToolCount === 0) {
    return;
  }
  return registry?.register(admission);
}

export async function createMastraAgentRuntime(
  options: MastraAgentRuntimeOptions = {}
): Promise<MastraAgentRuntime> {
  const {
    authInput,
    runtime,
    instructions,
    model,
    mcpConfig,
    mcpHost,
    mcpAppAdmission,
    mcpTaskTracking,
    tools: localTools,
    mcpTimeoutMs,
    permissionPolicy,
    preserveExecuteBackedWebSearch,
    personas,
    hookRunner: hookRunnerOption,
    resolved,
    memory,
    storage,
    toolOutputArtifactStore,
    toolOutputArtifactInlineMaxSerializedCharsByToolName,
    modelOverride,
    hydrateToolDiscoveryFromMemory,
  } = options;

  // BST-1352 review finding 7: `resolved` wins over live resolution, so a
  // DIFFERENT authInput passed alongside it would be silently dropped — the
  // exact vanishing-closure hazard the direct-parameter rule exists to
  // prevent. Same-reference is the legitimate pre-resolved case
  // (initializeMastraRuntime spreads options + resolved together).
  if (resolved && authInput && resolved.authInput !== authInput) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail:
        'Both resolved and authInput were supplied with different auth inputs; ' +
        'pass exactly one authority (a silently preferred one would drop the other auth closure).',
    });
  }
  let runtimeResolution: ResolvedRuntimeConfiguration;
  try {
    runtimeResolution = resolved ?? resolveRuntimeConfiguration(runtime, authInput);
  } catch (err) {
    logger.error('mastra runtime configuration failed', {
      code: 'mastra_agent_runtime_configuration_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const { runtime: sanitizedRuntime, provider: normalizedProvider } = runtimeResolution;

  const resolvedMcpConfig = mcpConfig ?? sanitizedRuntime.mcpConfig;

  // Tool pipeline phase 1 (runtime-assembly/tool-pipeline.ts): skills-merge →
  // sanitize → MCP discovery → timeout guard → lifecycle hooks →
  // plan/permission/suspend gates → provider-native web search → artifact
  // settlement. The stage order and per-stage invariants are documented in the
  // pipeline module + docs/agents/assistant-runtime.md. An explicit
  // `options.hookRunner`/`options.permissionPolicy` wins over one carried on
  // the runtime data. Plan mode is NEVER active for the built-in local
  // provider (mirrors the local gating on the task-list tool/note).
  const hookRunner = hookRunnerOption ?? sanitizedRuntime.hookRunner;
  const permissionSnapshot = permissionPolicy ?? sanitizedRuntime.permissionPolicy;
  const planModeActive = normalizedProvider !== 'local' && sanitizedRuntime.planMode === true;
  // Create the provider-specific model instance before tool discovery. The
  // DISCOVERY path passes an inert listing-only model so no provider lookup or
  // inference occurs there.
  const modelName = model ?? getDefaultModel(normalizedProvider);
  const languageModel =
    modelOverride ??
    instantiateLanguageModel(
      normalizedProvider,
      runtimeResolution.authInput,
      modelName,
      sanitizedRuntime
    );

  assertModernLanguageModel(languageModel, normalizedProvider, modelName);
  // BST-1701. The adapter answers a setting the model rejects by DROPPING it
  // and listing it on the call's `warnings`; Mastra never carries that array
  // onto the stream, so the observer has to sit here, between the model and
  // the Agent that will use it. It reads results only - the request is
  // untouched, which BST-1699's wire-level specs continue to pin.
  //
  // A DESCRIPTOR-configured provider (ollama, lmstudio) returns a plain
  // `{id, url, apiKey}` config that Mastra materializes itself, so there is no
  // instance to wrap and this run carries no sink at all. Explicitly narrowed
  // rather than duck-typed into a no-op wrapper: the absence is a documented
  // boundary, not a silent one.
  const { model: observedLanguageModel, sink: providerCallWarnings } =
    observeProviderCallWarnings(languageModel);
  // Resolve once per run. Static catalog models use their declared context
  // window; runtime-discovered Ollama/LM Studio ids share the conservative
  // 32,768-token declaration from @brainstrike/assistant-contract.
  const resolvedToolResultBudget = resolveToolResultBudgetForModel(normalizedProvider, modelName);
  let registeredDelegationToolNames: readonly string[] = [];
  const {
    artifactSettledTools,
    askTools,
    guardedTools,
    mcpAppToolAdmission,
    mcpClient,
    mcpDiscoverySkips,
    resilienceConfig,
    sanitizedLocalToolIds,
    settleChildToolOutputs,
    toolExecutionDurations,
    toolNameMap,
  } = await composeRuntimeToolMap({
    auth: runtimeResolution.authInput,
    getDelegationToolNames: () => registeredDelegationToolNames,
    hasStorage: Boolean(storage),
    hookRunner,
    inlineMaxSerializedCharsByToolName: toolOutputArtifactInlineMaxSerializedCharsByToolName,
    localTools,
    mcpConfig: resolvedMcpConfig,
    mcpHost,
    mcpTaskTracking,
    mcpTimeoutMs,
    permissionSnapshot,
    planModeActive,
    preserveExecuteBackedWebSearch,
    provider: normalizedProvider,
    resolvedToolResultBudget,
    toolOutputArtifactStore,
    workspaceSkills: sanitizedRuntime.workspaceSkills,
  });
  const persistedDiscoveryMessages = createPersistedDiscoveryMessageLoader({
    enabled: hydrateToolDiscoveryFromMemory,
    memory,
    memoryContext: sanitizedRuntime.memory,
  });
  // Apply the raw/model projection boundary independently to the post-gate core
  // and deferred surfaces, then reuse one discovery processor for every leg.
  const { discoverySurface, modelProjectedTools, tokenDiagnostics, toolSearchProcessor } =
    await prepareHostedToolDiscovery({
      eligibleTools: artifactSettledTools,
      localToolIds: sanitizedLocalToolIds,
      modelName,
      ...(persistedDiscoveryMessages ? { persistedDiscoveryMessages } : {}),
      provider: normalizedProvider,
      resolvedToolResultBudget,
      toolNameMap,
    }).catch(async (error: unknown) => {
      // Discovery has already opened MCP transports, but ownership does not
      // transfer to the returned runtime until initialization completes.
      await mcpClient?.disconnect();
      throw error;
    });
  const toolHistoryFilter = createToolHistoryFilter(normalizedProvider, toolNameMap);

  const budgetNote = buildContextBudgetNote(sanitizedRuntime.agentLoop?.inputTokenLimit);
  // The current per-thread plan, re-serialized into the instructions every turn
  // (the loop's TokenLimiter never trims the system instructions), so it
  // survives observational-memory truncation. Absent list → null (no block).
  // The built-in local provider never gets this block (its own manageTaskList
  // tool is also omitted from the tool map — see buildDesktopAssistantTools):
  // the tiny on-device model's WebGPU prefill budget cannot afford it. Gated
  // here too (not just at the caller's DB-read site) so a caller that still
  // threads a populated taskList through can never leak it into a local run.
  const taskListNote =
    normalizedProvider === 'local' ? null : buildCurrentTaskListNote(sanitizedRuntime.taskList);
  // Instructions must reflect the FINAL tool map the Agent actually receives:
  // the plan-mode filter, permission gate, and suspend-storage gate all omit
  // tools BEFORE this point, so building guidance from the raw `toolNameMap`
  // would advertise (name + usage block) tools the model can no longer call —
  // e.g. plan mode still listing writeWorkspaceFile/executeCommand. Restrict the
  // name map to the sanitized ids present in `gatedTools` (both are keyed by the
  // same sanitized id — see sanitizeTools) so an omitted tool is never advertised.
  const effectiveToolNameMap = new Map(
    Array.from(toolNameMap).filter(([sanitizedId]) => sanitizedId in modelProjectedTools)
  );

  // Subagent personas (D10): built BEFORE the instructions so guidance only
  // names personas that actually registered a delegation tool this run.
  const delegatedTurnPersistence = createDelegatedTurnPersistence(memory, sanitizedRuntime.memory);
  const {
    delegationToolPersonas,
    hasSubAgents,
    instructionPersonaSummaries,
    personasById,
    subAgents,
  } = resolvePersonaRuntimeParts({
    conversationBinding: options.conversationBinding,
    // BST-1206 review (P2): a persona that pins its OWN model must project
    // its tools against THAT model's resolved budget, not the parent's — so
    // `guardedTools` here is deliberately the RAW (pre-model-output-projection)
    // map. `resolvePersonaRuntimeParts`/`buildPersonaSubAgents` apply
    // `applyToolModelOutputProjections` themselves, per persona, choosing the
    // pinned model's own resolved budget when one is pinned and the parent's
    // `resolvedToolResultBudget` otherwise (see build-persona-subagents.ts).
    guardedTools,
    languageModel,
    permissionSnapshot,
    personas,
    planModeActive,
    provider: normalizedProvider,
    resolvedToolResultBudget,
    resolvePinnedModel: createPersonaPinnedModelResolver({
      // The parent's FULL auth input (not just its key string), so a
      // same-provider pin reuses custom_fetch/aws auth intact (BST-1352).
      auth: runtimeResolution.authInput,
      instantiate: instantiateLanguageModel,
      parentProvider: normalizedProvider,
      runtime: sanitizedRuntime,
    }),
    settleChildToolOutputs,
    toolNameMap,
    // Persona agents get the same raw/model split. Their independent policy
    // gate clones full tool descriptors, so `toModelOutput` survives intact.
    // Thread the SAME `tokenDiagnostics` instance as the primary tool map so
    // subagent calls attribute to the parent run's existing telemetry drain
    // (BST-1196), but through the telemetry-only sink: `recordModelOutput`
    // (used by the primary map) also feeds the `#projection` aggregate,
    // which is a reconciliation signal against the PARENT model's actual
    // prompt (`providerReportedPromptTokens`). Subagent tool outputs never
    // enter the parent's prompt, so they must not inflate that aggregate —
    // see `RunTokenDiagnostics.recordSubagentToolOutput`'s doc comment.
    toolOutputObserver: (toolId, output) =>
      tokenDiagnostics.recordSubagentToolOutput(toolId, output),
    turnPersistenceProcessor: delegatedTurnPersistence?.processor,
  });
  registeredDelegationToolNames = Array.from(delegationToolPersonas, ([toolName, personaId]) =>
    personasById.get(personaId)?.allowedToolIds.includes(NATIVE_TOOL_ID.readToolOutputArtifact)
      ? toolName
      : null
  ).filter((toolName): toolName is string => toolName !== null);

  const composedInstructions = composeRuntimeInstructions({
    budgetNote,
    instructionsOverride: instructions,
    now: new Date(),
    personaSummaries: instructionPersonaSummaries,
    planModeActive,
    provider: normalizedProvider,
    taskListNote,
    toolDiscoveryEnabled: toolSearchProcessor !== undefined,
    toolNameMap: effectiveToolNameMap,
  });

  // Instruction-side prompt-breakdown counts (heuristic), captured HERE because
  // this is the only seam where the task list note and the final composed
  // instructions are both in scope. Message-side counts join at stream start.
  const instructionBreakdown = computeInstructionBreakdown({
    composedInstructions: composedInstructions.combinedText,
    taskListNote,
  });

  // Error-processor resilience layer (PrefillErrorHandler +
  // StreamErrorRetryProcessor + ProviderHistoryCompat's reactive rules) on the
  // Agent-config `errorProcessors` seam — the ONE processor array a per-call
  // override never clobbers (the per-call TokenLimiter only replaces
  // `inputProcessors`). Excluded for the built-in local provider. When present
  // we MUST pin `maxProcessorRetries`: any errorProcessors flips Mastra's
  // implicit default to 10 (see ASSISTANT_MAX_PROCESSOR_RETRIES). See docs/agents/assistant-runtime.md
  // ASSISTANT RESILIENCE.
  const errorProcessors = buildAssistantErrorProcessors(normalizedProvider);
  const agent = new Agent({
    id: 'brainstrike-assistant',
    instructions: composedInstructions.agentInstructions,
    model: observedLanguageModel,
    name: 'Brainstrike Assistant',
    tools: modelProjectedTools,
    ...(hasSubAgents ? { agents: subAgents } : {}),
    ...(memory ? { memory } : {}),
    ...(errorProcessors
      ? { errorProcessors, maxProcessorRetries: ASSISTANT_MAX_PROCESSOR_RETRIES }
      : {}),
  });

  const { mastra, ...assistantIdentityRuntime } = registerAgentWithMastra(
    agent,
    storage,
    runtime?.assistantMessageId
  );
  const invalidateMcpAppAdmission = registerAppCapableAdmission(
    mcpAppAdmission,
    mcpAppToolAdmission
  );

  return {
    agent,
    ...assistantIdentityRuntime,
    askTools,
    conversationBinding: options.conversationBinding,
    delegatedTurnPersistence,
    delegationToolPersonas,
    dispose: async () => {
      invalidateMcpAppAdmission?.();
      await mastra?.shutdown();
      await mcpClient?.disconnect();
    },
    instructionBreakdown,
    mcpAppToolAdmission,
    mcpDiscoverySkips,
    // Present iff a policy snapshot gated this run's tool map — the signal the
    // resume gate uses to tell all-allowed (empty askTools) from a genuine
    // global-approval run (see resolveResumeApprovalGate / MastraAgentRuntime).
    permissionEnforced: permissionSnapshot !== undefined,
    personasById,
    providerCallWarnings,
    resilienceConfig,
    resolvedToolResultBudget,
    tokenDiagnostics,
    ...(discoverySurface ? { toolDiscovery: discoverySurface.metadata } : {}),
    toolExecutionDurations,
    toolHistoryFilter,
    ...(toolSearchProcessor ? { toolSearchProcessor } : {}),
    toolNameMap,
    ...(mcpClient ? { mcpClient } : {}),
  };
}

function assertModernLanguageModel(
  languageModel: MastraModelConfig,
  provider: string,
  model: string
): void {
  if (!languageModel || typeof languageModel !== 'object') {
    return;
  }

  const spec = (languageModel as { specificationVersion?: unknown }).specificationVersion;
  if (spec !== 'v1') {
    return;
  }

  // Tool-only context depends on the modern Mastra streaming surface. The old
  // AI SDK v1 adapter can drop terminal/tool events, so fail explicitly instead
  // of silently falling back to the removed legacy stream path.
  throw createMastraAgentError('mastra_agent_unsupported_model_runtime', {
    context: { model, provider, specificationVersion: spec },
    detail: `AI SDK v1 model runtime is not supported for Brainstrike chat streaming: ${provider}/${model}. Select a provider/model backed by the modern AI SDK v2 streaming runtime before retrying.`,
  });
}
