import type { McpHostPort } from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import {
  applyTurnSubagentLimits,
  parseRuntimeSubagentSettings,
  type RuntimeSubagentSettings,
  resolveChildTaskTimeoutMs,
} from '@brainstrike/assistant-contract/subagent-settings';
import { createLogger } from '@brainstrike/logging';
import { Agent, type MastraDBMessage, type ToolsInput } from '@mastra/core/agent';
import type { AgentBackgroundConfig, BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Mastra } from '@mastra/core/mastra';
import type { MastraMemory } from '@mastra/core/memory';
import type { InputProcessor } from '@mastra/core/processors';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { AssistantResilienceConfig } from '../config/resilience-config';
import {
  buildContextBudgetNote,
  buildCurrentDateNote,
  buildCurrentTaskListNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
  type DelegationPersonaSummary,
} from '../instructions/default-instructions';
import { createMastraAgentError, isMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import {
  ASSISTANT_MAX_PROCESSOR_RETRIES,
  buildAssistantErrorProcessors,
} from '../mastra-processors/error-processors';
import type { ProjectionSafeToolCallFilter } from '../mastra-processors/projection-safe-tool-call-filter';
import type {
  BrainstrikeToolSearchProcessor,
  ToolDiscoveryMetadata,
} from '../mastra-processors/tool-search-runtime';
import type { McpConfig } from '../mcp/config';
import type { McpDiscoverySkip } from '../mcp/mcp-discovery-diagnostics';
import type { McpRuntimeClient } from '../mcp/mcp-runtime-client';
import type { McpTaskTrackingCapability } from '../mcp/task-tracking';
import type {
  PermissionAskToolMetadata,
  PermissionToolGateSnapshot,
} from '../permissions/permission-tool-gate';
import type { BackgroundTaskScope } from '../pglite-mastra-memory/background-store';
import { isListingOnlyModel } from '../providers/listing-only-model';
import type { ProviderAuthInput } from '../providers/provider-auth-input';
import {
  createProviderCallWarningSink,
  type ProviderCallWarningOrigin,
  type ProviderCallWarningSink,
  wrapModelWithCallWarningCapture,
} from '../providers/provider-call-warnings';
import {
  createProvider,
  getDefaultModel,
  toMastraModelConfiguration,
} from '../providers/provider-factory';
import {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from '../runtime-configuration';
import {
  resolveToolResultBudgetForModel,
  type ScaledToolResultBudget,
} from '../stream/tool-output-limits';
import type { RunTokenDiagnostics } from '../token-measurement';
import type { ToolOutputArtifactSettlementStore } from '../tool-projection/tool-output-artifact-settlement';
import type { AgentHookRunner } from '../tools/hook-runner';
import type { ToolExecutionDurations } from '../tools/tool-execution-durations';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type { AgentMessage, RuntimeData } from '../types';
import {
  type CacheAwareInstructions,
  composeCacheAwareInstructions,
} from './anthropic-instruction-cache';
import type { RuntimeApprovalGate } from './approval-gate';
import {
  type BackgroundChildWatchdogs,
  watchBackgroundChildren,
} from './background-child-watchdog';
import { requireBackgroundResultDelivery } from './background-result-delivery';
import type { DelegatedExecutionOptions } from './build-persona-subagents';
import type { ChildContinuationRuntimeScope } from './child-continuation-usage';
import { captureRuntimeChildExecution } from './child-run-configuration';
import type {
  DelegatedCancellationControl,
  DelegatedConversationBinding,
} from './delegated-conversation-binding';
import { createDelegatedFollowupControl } from './delegated-followup';
import {
  createRootDelegatedContextProcessor,
  type DelegatedSystemContextSource,
} from './delegated-system-context';
import {
  createDelegatedTurnPersistence,
  type DelegatedTurnPersistence,
} from './delegated-turn-persistence';
import { createLiveDecisionChannel, type LiveDecisionChannel } from './live-decision-channel';
import type { McpAppToolAdmissionCapability } from './mcp-app-tool-call';
import type { PermissionGateSummary } from './permission-gate-run-events';
import { createPersonaPinnedModelResolver } from './persona-pinned-model';
import { computeInstructionBreakdown, type InstructionBreakdown } from './prompt-breakdown';
import { createAssistantMessageIdGenerator } from './runtime-assembly/assistant-message-id';
import { resolvePersonaRuntimeParts } from './runtime-assembly/persona-assembly';
import {
  composeRuntimeToolMap,
  createToolHistoryFilter,
  prepareHostedToolDiscovery,
} from './runtime-assembly/tool-pipeline';
import type { ChildPromptFacts } from './subagent-delegation';

export interface MastraAgentRuntimeOptions {
  /**
   * This runtime resumes a paused APPROVAL. Persona children built for it run
   * their tool calls sequentially (see `build-persona-subagents.ts`,
   * `resolveChildToolCallConcurrency`): a delegated child's resume inherits no
   * run-wide approval gate from the parent, so when the approved tool's own
   * `ask` was lifted by a grant in the meantime the child's suspended step would
   * otherwise resume in PARALLEL mode, and Mastra 1.64's parallel foreach resume
   * re-raises the step's approval for every allowed sibling (2026-09-13,
   * thread-05251b3f: `globWorkspace` paused right after `readWorkspaceDirectory`
   * was approved, and approving that pause failed with "multiple pending
   * calls"). The root leg never hits this because its function-form gate is
   * truthy and already forces sequential execution. Set by the two approval
   * entry points — `streamMastraToolApprovalAction` and the tool-approval kind
   * of `createChildContinuationDecisionStream` — which are exhaustive; a
   * generic suspend resume needs no flag (a suspending tool carries a suspend
   * schema, which already forces sequential execution). Effect is run-level:
   * see `resolveChildToolCallConcurrency`.
   */
  approvalResumeLeg?: boolean;
  /**
   * Provider auth input for the run's language model (BST-1352). A DIRECT
   * option by contract — never read from `runtime`: RuntimeData must not carry
   * auth inputs (RequestContext.toJSON drops functions, so a custom_fetch
   * closure riding RuntimeData would vanish silently). Absent falls back to
   * the legacy runtime/env key resolution.
   */
  authInput?: ProviderAuthInput;
  /** Host-owned durable background scope; never client RuntimeData. */
  backgroundTaskScope?: BackgroundTaskScope;
  /** Host-admitted settings for the exact resumed child, never renderer authority. */
  childExecutionConfiguration?: import('@brainstrike/assistant-contract').ChildExecutionConfiguration;
  /** Actual ancestor depth retained when an existing child becomes the managed native root. */
  continuationChildScope?: ChildContinuationRuntimeScope | undefined;
  /** Host-owned native identity persistence; never serialized through RuntimeData. */
  conversationBinding?: DelegatedConversationBinding | undefined;
  delegatedDepthOffset?: number | undefined;
  delegatedExecutionSnapshots?: readonly (
    | import('@brainstrike/assistant-contract').ChildExecutionConfiguration
    | undefined
  )[];
  /** Host-authorized admission profiles, indexed by delegation depth for a resumed path. */
  delegatedPersonaSnapshots?: readonly AssistantPersonaDefinition[];
  /** @internal Initial host system context; native child snapshots own resumption. */
  getDelegatedSystemContext?: DelegatedSystemContextSource;
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
  /** Trusted host credential lookup for an admitted persona removed from the live registry. */
  resolvePersonaApiKey?: (provider: string) => Promise<string | undefined>;
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
   * The live approval gate (approval-gate.ts): the single decision point for
   * this run's `ask` tools. Each ask tool's function-form `requireApproval`
   * forwards to it per call; the approval leg resolves the resume API's
   * `requireToolApproval: true` through it (`resolveRequireToolApproval`).
   */
  approvalGate: RuntimeApprovalGate;
  /**
   * Sanitized id → risk metadata for every tool the permission gate resolved to
   * `'ask'` and KEPT in the map. Non-empty when the run has approval-gated
   * mutation tools; the live gate suspends exactly this set, and it feeds the
   * approval-pause risk hint and observability. Empty when no policy is
   * enforced, every tool resolved to allow/deny, or ask tools were
   * fail-safe-omitted for lack of resume storage.
   */
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  /** Fail-loud completion check for the client-provided persisted assistant id. */
  assertAssistantMessageIdPersisted?: () => void;
  /**
   * Each background child's own watchdog (`background-child-watchdog.ts`),
   * present exactly when `backgroundTaskManager` is. The parent's stream
   * watchdog reads it as the watch over the work that holds its stream open.
   */
  backgroundChildWatchdogs?: BackgroundChildWatchdogs | undefined;
  backgroundTaskManager?: BackgroundTaskManager | undefined;
  /** Direct child legs retain the child's native default processors and admitted step cap. */
  childExecution?: { readonly maxSteps: number; readonly inputProcessors?: unknown[] };
  /**
   * Persona id → the exact instructions and kept tool names each child Agent of
   * THIS runtime's persona build was constructed with (debug-pack prompt
   * manifests). Describes only delegations dispatched by `agent`.
   */
  childPromptFacts: ReadonlyMap<string, ChildPromptFacts>;
  conversationBinding?: DelegatedConversationBinding | undefined;
  delegatedExecutionOptions?: DelegatedExecutionOptions;
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
  /**
   * The leg's live decision seam: the host delivers a decision into this
   * RUNNING leg through it (`registerDecisionControl`), and the background
   * phase driving the stream owns it while it runs (`live-decision-channel.ts`).
   */
  liveDecisions: LiveDecisionChannel;
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
   * (`resolveRequireToolApproval`, approval-gate.ts) needs this: the former is an all-allowed
   * posture (gate nothing), the latter with run-wide `requireToolApproval: true`
   * is a genuine explicit GLOBAL approval (gate every non-internal tool).
   */
  permissionEnforced: boolean;
  /**
   * The permission gate this runtime's Agent was built with, minted ONCE as
   * `permission.gate.resolved` on the fresh-turn prelude (attempt-legs.ts).
   * REQUIRED: null means no policy snapshot gated the run, which must stay
   * distinguishable from a runtime that never computed it.
   */
  permissionGate: PermissionGateSummary | null;
  /** Persona id → definition for the registered delegation tools (delegation caps). */
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  /**
   * Provider warnings this run's model reported about the requests it served
   * (BST-1701). Filled UNDER Mastra by the model observer, drained into
   * always-visible run-event rows by `streamAttemptChunks`.
   *
   * Shared by the supervisor and every persona model instance. Descriptor
   * models still have no observer, but their hosted persona pins can report
   * into this same run sink.
   */
  providerCallWarnings: ProviderCallWarningSink;
  /**
   * Original names of the tools `agent` registered after the plan-mode filter,
   * the permission gate and the suspend-storage gate — the same set its
   * instructions advertise (`effectiveToolNameMap`). Debug-pack evidence only.
   */
  registeredToolNames: readonly string[];
  resilienceConfig: AssistantResilienceConfig;
  /** Per-run budget shared by fresh producers and runtime projection guards. */
  resolvedToolResultBudget: ScaledToolResultBudget;
  rootDelegatedContextProcessor?: InputProcessor | undefined;
  /**
   * The leg's validated limits: the request's (`runtimeData.subagentSettings`,
   * absent → defaults) with the turn's stored limits over them once its
   * budget row exists. Every consumer reads these, never the request.
   */
  subagentSettings: RuntimeSubagentSettings;
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
 * reads. A descriptor is handed back untouched: Mastra
 * materializes that model itself, so the boundary is structural. It is
 * narrowed explicitly instead of being wrapped into a proxy that could never
 * observe anything, so the gap stays documented rather than silent.
 */
function observeProviderCallWarnings(
  languageModel: MastraModelConfig,
  sink: ProviderCallWarningSink,
  origin: ProviderCallWarningOrigin
): MastraModelConfig {
  const isInstance =
    typeof languageModel === 'object' &&
    languageModel !== null &&
    typeof (languageModel as { doStream?: unknown }).doStream === 'function';
  if (!isInstance) {
    return languageModel;
  }
  return wrapModelWithCallWarningCapture(
    languageModel as object,
    sink,
    origin
  ) as MastraModelConfig;
}

function instantiateLanguageModel(
  provider: string,
  auth: ProviderAuthInput | undefined,
  modelName: string,
  runtime: RuntimeData | undefined
): MastraModelConfig {
  try {
    return toMastraModelConfiguration(createProvider(provider, auth, modelName, runtime));
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
  backgroundTaskScope: BackgroundTaskScope | undefined;
  budgetNote: string | null;
  hasSubAgents: boolean;
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
          backgroundDelegation: Boolean(params.backgroundTaskScope) && params.hasSubAgents,
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
  assistantMessageId: string | undefined,
  backgroundEnabled: boolean,
  taskTimeoutMs: number
): {
  assertAssistantMessageIdPersisted?: () => void;
  backgroundTaskManager?: BackgroundTaskManager | undefined;
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
    backgroundTasks: {
      defaultRetries: { maxRetries: 0 },
      defaultTimeoutMs: taskTimeoutMs,
      enabled: backgroundEnabled,
      waitTimeoutMs: 0,
    },
    ...(assistantMessageIdGenerator ? { idGenerator: assistantMessageIdGenerator.generate } : {}),
    logger: false,
    storage,
  });
  return {
    ...(assistantMessageIdGenerator
      ? { assertAssistantMessageIdPersisted: assistantMessageIdGenerator.assertConsumed }
      : {}),
    backgroundTaskManager: backgroundEnabled ? mastra.backgroundTaskManager : undefined,
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

async function initializeRuntimeLifetime(
  register: () => void,
  dispose: () => Promise<void>
): Promise<void> {
  try {
    register();
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Assistant runtime construction and cleanup failed.'
      );
    }
    throw error;
  }
}

async function buildBackgroundAgentOptions(
  scope: BackgroundTaskScope | undefined,
  hasSubAgents: boolean,
  personas: ReadonlyMap<string, AssistantPersonaDefinition>,
  storage: MastraCompositeStore | undefined
): Promise<{ backgroundTasks?: AgentBackgroundConfig }> {
  if (!(scope && hasSubAgents)) {
    return {};
  }
  requireBackgroundResultDelivery(await storage?.getStore('backgroundTasks'));
  return {
    backgroundTasks: {
      tools: Object.fromEntries([...personas.keys()].map((id) => [id, true])),
      waitTimeoutMs: 0,
    },
  };
}

function assertBackgroundScope(options: MastraAgentRuntimeOptions): void {
  const scope = options.backgroundTaskScope;
  if (!scope) {
    return;
  }
  if (
    !(options.storage && options.memory) ||
    scope.resourceId !== options.runtime?.memory?.resourceId ||
    scope.threadId !== options.runtime?.memory?.threadId
  ) {
    throw new Error('Background children require matching durable host memory scope.');
  }
}

function continuationPersonaTools(
  options: MastraAgentRuntimeOptions,
  planModeActive: boolean,
  artifactSettledTools: ToolsInput,
  hookedTools: ToolsInput
): ToolsInput {
  // Resuming an existing child in plan mode retains only the plan-filtered
  // tools; new delegations continue using the ordinary persona admission path.
  return options.continuationChildScope && planModeActive ? artifactSettledTools : hookedTools;
}

export async function createMastraAgentRuntime(
  options: MastraAgentRuntimeOptions = {}
): Promise<MastraAgentRuntime> {
  assertBackgroundScope(options);
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
    approvalResumeLeg,
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
  // instance to wrap. The run still owns a sink for hosted persona pins;
  // descriptor capture remains a documented boundary (BST-1740).
  const providerCallWarnings = createProviderCallWarningSink();
  const observedLanguageModel = observeProviderCallWarnings(languageModel, providerCallWarnings, {
    modelId: modelName,
    provider: normalizedProvider,
  });
  // Resolve once per run. Static catalog models use their declared context
  // window; runtime-discovered Ollama/LM Studio ids share the conservative
  // 32,768-token declaration from @brainstrike/assistant-contract.
  const resolvedToolResultBudget = resolveToolResultBudgetForModel(normalizedProvider, modelName);
  // Created before the tool map: the root's live gate and every child's gate
  // read this channel's remembered grant on each call (approval-gate.ts).
  const liveDecisions = createLiveDecisionChannel();
  let registeredDelegationToolNames: readonly string[] = [];
  const {
    approvalGate,
    artifactSettledTools,
    askTools,
    hookedTools,
    mcpAppToolAdmission,
    mcpClient,
    mcpDiscoverySkips,
    permissionGate,
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
    remembered: () => liveDecisions.remembered,
    resolvedToolResultBudget,
    toolOutputArtifactStore,
    workspaceSkills: sanitizedRuntime.workspaceSkills,
  });
  const permissionEnforced = permissionSnapshot !== undefined;
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
  const taskListNote = buildCurrentTaskListNote(sanitizedRuntime.taskList);
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
  // Validated ONCE per runtime; a malformed request field fails construction
  // loudly rather than admitting a child under an unknown budget. A later leg
  // of a turn runs under the limits its budget row stored, not its request's.
  const subagentSettings = applyTurnSubagentLimits(
    parseRuntimeSubagentSettings(sanitizedRuntime.subagentSettings),
    await options.conversationBinding?.budget?.readTurnLimits()
  );
  const delegatedExecutionOptions: DelegatedExecutionOptions = {};
  const delegatedTurnPersistence = createDelegatedTurnPersistence(memory, sanitizedRuntime.memory);
  const {
    artifactReaderDelegationTools,
    childPromptFacts,
    delegationToolPersonas,
    hasSubAgents,
    instructionPersonaSummaries,
    personasById,
    subAgents,
  } = await resolvePersonaRuntimeParts({
    approvalResumeLeg,
    childExecutionConfiguration: captureRuntimeChildExecution(
      sanitizedRuntime,
      normalizedProvider,
      modelName,
      planModeActive,
      permissionSnapshot,
      options.childExecutionConfiguration,
      isListingOnlyModel(languageModel)
    ),
    continuationChildScope: options.continuationChildScope,
    conversationBinding: options.conversationBinding,
    delegatedDepthOffset: options.delegatedDepthOffset,
    delegatedExecutionOptions,
    delegatedExecutionSnapshots: options.delegatedExecutionSnapshots,
    delegatedPersonaSnapshots: options.delegatedPersonaSnapshots,
    getDelegatedSystemContext: options.getDelegatedSystemContext,
    // BST-1206 review (P2): a persona that pins its OWN model must project
    // its tools against THAT model's resolved budget, not the parent's — so
    // `guardedTools` here is deliberately the RAW (pre-model-output-projection)
    // map. `resolvePersonaRuntimeParts`/`buildPersonaSubAgents` apply
    // `applyToolModelOutputProjections` themselves, per persona, choosing the
    // pinned model's own resolved budget when one is pinned and the parent's
    // `resolvedToolResultBudget` otherwise (see build-persona-subagents.ts).
    guardedTools: continuationPersonaTools(
      options,
      planModeActive,
      artifactSettledTools,
      hookedTools
    ),
    hasStorage: Boolean(storage),
    hydrateToolDiscoveryFromMemory,
    languageModel: observedLanguageModel,
    liveDecisions,
    localToolIds: sanitizedLocalToolIds,
    memory,
    modelName,
    permissionSnapshot,
    personas,
    planModeActive,
    provider: normalizedProvider,
    resolvedToolResultBudget,
    resolvePinnedModel: createPersonaPinnedModelResolver({
      // The parent's FULL auth input (not just its key string), so a
      // same-provider pin reuses custom_fetch/aws auth intact (BST-1352).
      auth: runtimeResolution.authInput,
      inheritedModel: { model: observedLanguageModel, name: modelName },
      instantiate: (provider, auth, pinnedModelName, runtime) =>
        observeProviderCallWarnings(
          instantiateLanguageModel(provider, auth, pinnedModelName, runtime),
          providerCallWarnings,
          { modelId: pinnedModelName, provider }
        ),
      parentProvider: normalizedProvider,
      runtime: sanitizedRuntime,
    }),
    rootMemoryContext: sanitizedRuntime.memory,
    settleChildToolOutputs,
    subagentSettings,
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
    workspaceSkills: sanitizedRuntime.workspaceSkills,
  });
  registeredDelegationToolNames = [...artifactReaderDelegationTools];

  const composedInstructions = composeRuntimeInstructions({
    backgroundTaskScope: options.backgroundTaskScope,
    budgetNote,
    hasSubAgents,
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
  const backgroundAgentOptions = await buildBackgroundAgentOptions(
    options.backgroundTaskScope,
    hasSubAgents,
    personasById,
    storage
  );
  const agent = new Agent({
    ...backgroundAgentOptions,
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
    runtime?.assistantMessageId,
    Boolean(backgroundAgentOptions.backgroundTasks),
    resolveChildTaskTimeoutMs(subagentSettings)
  );
  let backgroundChildWatchdogs: BackgroundChildWatchdogs | undefined;
  let unregisterCancellation: (() => void) | undefined;
  let unregisterDecisions: (() => void) | undefined;
  let unregisterFollowup: (() => void) | undefined;
  let invalidateMcpAppAdmission: (() => void) | undefined;
  const dispose = async () => {
    const failures: unknown[] = [];
    // Preserve cleanup order, but a failure cannot skip another owner or
    // replace an earlier error. Decision settlement remains fail-closed.
    for (const cleanup of [
      () => invalidateMcpAppAdmission?.(),
      // Judge no child through shutdown: its cancellation is not a stall.
      () => backgroundChildWatchdogs?.dispose(),
      () => mastra?.shutdown(),
      () => unregisterCancellation?.(),
      () => unregisterDecisions?.(),
      () => unregisterFollowup?.(),
      () => mcpClient?.disconnect(),
      () => options.conversationBinding?.finishToolActions?.(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Assistant runtime disposal failed.');
    }
  };
  const cancelInvocations: DelegatedCancellationControl = async (targets) => {
    options.conversationBinding?.abortInvocations?.(targets);
    const manager = assistantIdentityRuntime.backgroundTaskManager;
    if (manager) {
      if (!options.backgroundTaskScope) {
        throw new Error('Selective cancellation requires the native root scope.');
      }
      for (const target of targets) {
        const tasks = await manager.listTasks({
          ...options.backgroundTaskScope,
          runId: target.parentRuntimeRunId,
          toolCallId: target.parentToolCallId,
        });
        for (const task of tasks.tasks) {
          if (task.toolCallId === target.parentToolCallId) {
            await manager.cancel(task.id);
          }
        }
      }
    }
    await delegatedTurnPersistence?.finalize(targets);
  };
  await initializeRuntimeLifetime(() => {
    backgroundChildWatchdogs = watchBackgroundChildren(
      assistantIdentityRuntime.backgroundTaskManager,
      options,
      agent.id,
      toolNameMap,
      resilienceConfig
    );
    unregisterCancellation = options.conversationBinding?.registerCancellation?.(cancelInvocations);
    unregisterDecisions = options.conversationBinding?.registerDecisionControl?.((request) =>
      liveDecisions.deliver(request)
    );
    unregisterFollowup = options.conversationBinding?.registerFollowup?.(
      createDelegatedFollowupControl(subAgents)
    );
    invalidateMcpAppAdmission = registerAppCapableAdmission(mcpAppAdmission, mcpAppToolAdmission);
  }, dispose);

  return {
    agent,
    rootDelegatedContextProcessor: createRootDelegatedContextProcessor(
      options.getDelegatedSystemContext,
      hasSubAgents
    ),
    ...assistantIdentityRuntime,
    approvalGate,
    askTools,
    backgroundChildWatchdogs,
    childPromptFacts,
    conversationBinding: options.conversationBinding,
    delegatedExecutionOptions,
    delegatedTurnPersistence,
    delegationToolPersonas,
    dispose,
    instructionBreakdown,
    liveDecisions,
    mcpAppToolAdmission,
    mcpDiscoverySkips,
    // Present iff a policy snapshot gated this run's tool map — the signal the
    // resume gate uses to tell all-allowed (empty askTools) from a genuine
    // global-approval run (see resolveRequireToolApproval / MastraAgentRuntime).
    permissionEnforced,
    permissionGate,
    personasById,
    providerCallWarnings,
    registeredToolNames: [...effectiveToolNameMap.values()],
    resilienceConfig,
    resolvedToolResultBudget,
    subagentSettings,
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
