import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { AssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import type { AssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger, generateUUID } from '@brainstrike/utils';
import {
  Agent,
  type AgentMemoryOption,
  type DelegationConfig,
  type ToolsInput,
} from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Mastra } from '@mastra/core/mastra';
import type { MastraMemory } from '@mastra/core/memory';
import { TokenLimiter } from '@mastra/core/processors';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { MCPClient, type MCPClientOptions } from '@mastra/mcp';
import {
  type AssistantResilienceConfig,
  resolveAssistantResilienceConfig,
} from '../config/resilience-config';
import type { McpConfig } from '../mcp/config';
import { createListingOnlyModel } from '../providers/listing-only-model';
import { createProvider, getDefaultModel } from '../providers/provider-factory';
import type {
  AssistantRunEventKind,
  AssistantRunEventMetadata,
  AssistantRunEventStatus,
} from '../run-events';
import { readableStreamIterator } from '../stream/readable-stream-iterator';
import { StreamStalledError, withInactivityTimeout } from '../stream/with-inactivity-timeout';
import { applyToolGuards } from '../tools/guard-tool-execution';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type {
  AgentMessage,
  RuntimeData,
  StreamChunk,
  StreamChunkTool,
  StreamFinishReason,
  StreamIterator,
} from '../types';
import { buildPersonaSubAgents } from './build-persona-subagents';
import {
  buildContextBudgetNote,
  buildCurrentTaskListNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
  type DelegationPersonaSummary,
} from './default-instructions';
import {
  ASSISTANT_MAX_PROCESSOR_RETRIES,
  buildAssistantErrorProcessors,
  buildProviderHistoryCompatInputProcessor,
} from './error-processors';
import { isApprovalExemptInternalTool } from './internal-approval-exempt-tools';
import { createMastraAgentError, isMastraAgentError } from './mastra-agent-error';
import { collectCombinedTools } from './mcp-tool-loader';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionAskToolMetadata,
  type PermissionToolGateSnapshot,
} from './permission-tool-gate';
import { filterToolsForPlanMode, resolveSuspendToolsForRun } from './plan-mode-tool-gate';
import {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './runtime-configuration';
import {
  createDelegationConfig,
  createDelegationLifecycleTracker,
  type DelegationLifecycleTracker,
  shouldEnablePersonas,
} from './subagent-delegation';
import {
  mapMastraToolEvent,
  readMastraStreamPartString,
  readMastraStreamPartValue,
  readNestedToolOutputChunk,
} from './tool-event-mapper';
import { sanitizeTools } from './tool-sanitizer';

export interface MastraAgentRuntimeOptions {
  instructions?: string;
  mcpConfig?: McpConfig;
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
  requireToolApproval?: boolean;
  resolved?: ResolvedRuntimeConfiguration;
  runtime?: RuntimeData;
  storage?: MastraCompositeStore;
  tools?: ToolsInput;
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
  /**
   * 'agent-<personaId>' → personaId for every registered delegation tool. Empty
   * when personas are absent/skipped. Consumed by the stream mapper (T4) to emit
   * `subagent.*` run events keyed by the delegation toolCallId.
   */
  delegationToolPersonas: ReadonlyMap<string, string>;
  dispose: () => Promise<void>;
  mcpClient?: MCPClient;
  /** Persona id → definition for the registered delegation tools (delegation caps). */
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  resilienceConfig: AssistantResilienceConfig;
  toolNameMap: Map<string, string>;
}

const logger = createLogger('MastraAgent');

function toMastraServerMap(config: McpConfig | undefined): MCPClientOptions['servers'] {
  if (!(config && Array.isArray(config.servers))) {
    return {};
  }

  const map: Record<string, MCPClientOptions['servers'][string]> = {};

  const buildStdio = (
    command: string,
    args?: string[] | undefined,
    env?: Record<string, string> | undefined
  ): { command: string; args?: string[]; env?: Record<string, string> } => {
    const entry: { command: string; args?: string[]; env?: Record<string, string> } = { command };
    if (Array.isArray(args) && args.length > 0) {
      entry.args = args;
    }
    if (env && Object.keys(env).length > 0) {
      entry.env = env;
    }
    return entry;
  };

  const buildSse = (
    urlString: string,
    headers?: Record<string, string> | undefined
  ): MCPClientOptions['servers'][string] | undefined => {
    try {
      const entry: MCPClientOptions['servers'][string] = { url: new URL(urlString) };
      if (headers && Object.keys(headers).length > 0) {
        entry.requestInit = { headers };
      }
      return entry;
    } catch {
      return;
    }
  };

  for (const server of config.servers) {
    if (!server?.name) {
      continue;
    }
    if (server.transport === 'stdio') {
      map[server.name] = buildStdio(server.command, server.args, server.env);
      continue;
    }
    if (server.transport === 'sse') {
      const entry = buildSse(server.url, server.headers);
      if (entry) {
        map[server.name] = entry;
      }
    }
  }

  return map;
}

function instantiateLanguageModel(
  provider: string,
  apiKey: string | undefined,
  modelName: string,
  runtime: RuntimeData | undefined
): MastraModelConfig {
  try {
    return createProvider(provider, apiKey, modelName, runtime);
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

export function convertMessagesToMastra(
  messages: AgentMessage[]
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  const result: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  for (const message of messages) {
    const textParts: string[] = [];
    for (const part of message.parts) {
      if (part.type !== 'text') {
        continue;
      }
      const trimmed = part.text.trim();
      if (trimmed.length > 0) {
        textParts.push(trimmed);
      }
    }
    if (textParts.length > 0) {
      result.push({ content: textParts.join('\n\n'), role: message.role });
    }
  }
  return result;
}

interface ResolvedAskTools {
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  tools: ToolsInput;
}

/**
 * Reconcile the gate result with whether the run can suspend-then-resume for
 * approval (i.e. whether Mastra workflow storage is configured).
 *
 * The gate already marked each `'ask'` tool with the PER-TOOL `requireApproval`
 * flag (only the ask tool suspends; allowed tools run free). This function only
 * decides whether those ask tools may STAY:
 * - With storage: keep them (their per-tool flag suspends on call) and carry
 *   `askTools` for the approval-pause risk hint. Logged so the gate is observable.
 * - Without storage: the resume path (`streamMastraToolApprovalAction`) throws,
 *   so a suspend could never resume. We must NOT run an approval-required tool
 *   unprompted (no-silent-fallbacks), so we fall back to the conservative
 *   FAIL-SAFE — OMIT the `'ask'` tools from the map (logged) and return an empty
 *   `askTools`, exactly as the engine did before per-call approval landed.
 */
function resolveAskToolsForRun(
  gateResult: {
    tools: ToolsInput;
    askToolIds: ReadonlySet<string>;
    askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  },
  canSuspendForApproval: boolean
): ResolvedAskTools {
  if (gateResult.askToolIds.size === 0) {
    return { askTools: gateResult.askTools, tools: gateResult.tools };
  }

  if (!canSuspendForApproval) {
    const reducedTools: Record<string, unknown> = {};
    for (const [sanitizedId, tool] of Object.entries(gateResult.tools)) {
      if (gateResult.askToolIds.has(sanitizedId)) {
        const meta = gateResult.askTools.get(sanitizedId);
        logger.warn(
          "Tool gated to 'ask' but no storage to suspend for approval; omitting (fail-safe)",
          {
            code: 'permission_tool_gate_ask_omitted_no_storage',
            riskCategory: meta?.riskCategory,
            sanitizedId,
            tool: meta?.originalName ?? sanitizedId,
          }
        );
        continue;
      }
      reducedTools[sanitizedId] = tool;
    }
    return { askTools: new Map(), tools: reducedTools as ToolsInput };
  }

  // Each ask tool carries the per-tool requireApproval flag and will suspend ONLY
  // when actually called. Logged so the gated tools are observable.
  logger.info('Permission policy requires per-call approval for ask tools', {
    askToolCount: gateResult.askToolIds.size,
    askTools: Array.from(gateResult.askTools.values()).map((meta) => ({
      riskCategory: meta.riskCategory,
      tool: meta.originalName,
    })),
    code: 'permission_tool_gate_require_approval',
  });
  return { askTools: gateResult.askTools, tools: gateResult.tools };
}

interface PersonaRuntimeParts {
  delegationToolPersonas: ReadonlyMap<string, string>;
  hasSubAgents: boolean;
  instructionPersonaSummaries: DelegationPersonaSummary[] | undefined;
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  subAgents: Record<string, Agent>;
}

const EMPTY_PERSONA_RUNTIME_PARTS: PersonaRuntimeParts = {
  delegationToolPersonas: new Map(),
  hasSubAgents: false,
  instructionPersonaSummaries: undefined,
  personasById: new Map(),
  subAgents: {},
};

/**
 * Build the persona delegation parts (child Agents + summaries) for a run.
 * Skipped for the built-in local provider (prompt budget) and in plan mode
 * (delegation is out of scope for planning — the `agent-<id>` tools are
 * Mastra-constructed and never enter the plan-mode-filtered tool map, so we
 * simply do not pass `agents`). Children re-gate the parent's GUARDED tool map
 * (pre-permission-filter) so ask tools are omitted per the child's own gate.
 */
function resolvePersonaRuntimeParts(params: {
  guardedTools: ToolsInput;
  languageModel: MastraModelConfig;
  permissionSnapshot: PermissionToolGateSnapshot | undefined;
  personas: readonly AssistantPersonaDefinition[] | undefined;
  planModeActive: boolean;
  provider: string;
  toolNameMap: Map<string, string>;
}): PersonaRuntimeParts {
  if (params.planModeActive || !shouldEnablePersonas(params.provider, params.personas)) {
    return EMPTY_PERSONA_RUNTIME_PARTS;
  }
  const personaBuild = buildPersonaSubAgents({
    guardedTools: params.guardedTools,
    languageModel: params.languageModel,
    logger,
    permissionSnapshot: params.permissionSnapshot,
    personas: params.personas ?? [],
    toolNameMap: params.toolNameMap,
  });
  return {
    delegationToolPersonas: personaBuild.delegationToolPersonas,
    hasSubAgents: Object.keys(personaBuild.subAgents).length > 0,
    instructionPersonaSummaries: Array.from(personaBuild.personasById.values(), (persona) => ({
      description: persona.description,
      id: persona.id,
      label: persona.label,
    })),
    personasById: personaBuild.personasById,
    subAgents: personaBuild.subAgents,
  };
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
  personaSummaries: DelegationPersonaSummary[] | undefined;
  planModeActive: boolean;
  provider: string;
  taskListNote: string | null;
  toolNameMap: ReadonlyMap<string, string>;
}): string {
  const resolvedInstructions =
    params.instructionsOverride ??
    (params.provider === 'local'
      ? buildLocalDefaultInstructions(params.toolNameMap)
      : buildDefaultInstructions(params.toolNameMap, {
          planMode: params.planModeActive,
          ...(params.personaSummaries ? { personas: params.personaSummaries } : {}),
        }));
  return [resolvedInstructions, params.budgetNote, params.taskListNote]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

export async function createMastraAgentRuntime(
  options: MastraAgentRuntimeOptions = {}
): Promise<MastraAgentRuntime> {
  const {
    runtime,
    instructions,
    model,
    mcpConfig,
    tools: localTools,
    mcpTimeoutMs,
    permissionPolicy,
    personas,
    resolved,
    memory,
    storage,
    modelOverride,
  } = options;

  let runtimeResolution: ResolvedRuntimeConfiguration;
  try {
    runtimeResolution = resolved ?? resolveRuntimeConfiguration(runtime);
  } catch (err) {
    logger.error('mastra runtime configuration failed', {
      code: 'mastra_agent_runtime_configuration_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const { runtime: sanitizedRuntime, provider: normalizedProvider, apiKey } = runtimeResolution;

  const servers = toMastraServerMap(mcpConfig ?? sanitizedRuntime.mcpConfig);
  const hasServers = Object.keys(servers).length > 0;
  const mcpClient = hasServers
    ? // Timestamp is kept for easier chronological debugging; UUID provides uniqueness.
      new MCPClient({ id: `mcp-client-${Date.now()}-${generateUUID()}`, servers })
    : undefined;

  const toolNameMap = new Map<string, string>();
  const sanitizedLocalTools = sanitizeTools(localTools, toolNameMap);
  const combinedTools = await collectCombinedTools({
    mcpClient,
    mcpConfig: mcpConfig ?? sanitizedRuntime.mcpConfig,
    sanitizedLocalTools,
    timeoutOverrideMs: mcpTimeoutMs,
    toolNameMap,
  });
  const resilienceConfig = resolveAssistantResilienceConfig();
  // Intentional global guard: every native and MCP tool execution shares this
  // ceiling so a single slow tool cannot freeze the assistant stream.
  const guardedTools = applyToolGuards(combinedTools, {
    logger,
    timeoutMs: resilienceConfig.toolTimeoutMs,
  });

  // Permission gate: filter the tool map by the user's policy BEFORE the Agent
  // is constructed (the Agent is immutable after `new Agent`). 'deny' omits the
  // tool from the map the model sees; 'ask' KEEPS a CLONE of the tool carrying
  // Mastra's PER-TOOL `requireApproval: true` (and records its id in `askTools`)
  // so Mastra suspends for approval ONLY when that tool is actually called —
  // allowed read/mcp tools in the same run still run free. We do NOT force the
  // run-wide requireToolApproval (see permission-tool-gate.ts + streamMastraAgent).
  // When no policy is threaded the map is returned unchanged (production-default)
  // with an empty askTools. An explicit `options.permissionPolicy` wins over one
  // carried on the runtime data.
  const permissionSnapshot = permissionPolicy ?? sanitizedRuntime.permissionPolicy;

  // Plan mode (opt-in, per-request; NEVER for the built-in local provider — it
  // mirrors the local gating on the task-list tool/note): constrain the tool map
  // to read/mcp + the suspending tools (submitPlan/askUser) and omit every
  // edit/execute tool, BEFORE the permission gate (a dropped mutation tool is
  // dropped regardless of allow/ask/deny). The risk map is the authoritative
  // static registry classification (never client-supplied).
  const planModeActive = normalizedProvider !== 'local' && sanitizedRuntime.planMode === true;
  const planFilteredTools = planModeActive
    ? filterToolsForPlanMode(
        guardedTools,
        toolNameMap,
        permissionSnapshot?.riskByTool ?? buildNativeToolRiskMap(),
        logger
      )
    : guardedTools;

  const gateResult = filterToolsByPermissionWithMetadata(
    planFilteredTools,
    permissionSnapshot,
    toolNameMap,
    logger
  );
  const { tools: askResolvedTools, askTools } = resolveAskToolsForRun(gateResult, Boolean(storage));
  // Fail-safe: a tool that pauses via suspend() cannot resume without workflow
  // storage, so omit the suspending tools when storage is absent (never run one
  // that would wedge the run — no-silent-fallbacks).
  const gatedTools = resolveSuspendToolsForRun(
    askResolvedTools,
    Boolean(storage),
    toolNameMap,
    logger
  );

  // Create provider-specific model instance. The DISCOVERY path passes
  // `modelOverride` (an inert listing-only model) so provider/model are never
  // resolved — listing suspended runs performs no inference and must not require
  // a provider key or a static default model.
  const modelName = model ?? getDefaultModel(normalizedProvider);
  const languageModel =
    modelOverride ??
    instantiateLanguageModel(normalizedProvider, apiKey, modelName, sanitizedRuntime);

  assertModernLanguageModel(languageModel, normalizedProvider, modelName);

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
    Array.from(toolNameMap).filter(([sanitizedId]) => sanitizedId in gatedTools)
  );

  // Subagent personas (D10): built BEFORE the instructions so guidance only
  // names personas that actually registered a delegation tool this run.
  const {
    delegationToolPersonas,
    hasSubAgents,
    instructionPersonaSummaries,
    personasById,
    subAgents,
  } = resolvePersonaRuntimeParts({
    guardedTools,
    languageModel,
    permissionSnapshot,
    personas,
    planModeActive,
    provider: normalizedProvider,
    toolNameMap,
  });

  const composedInstructions = composeRuntimeInstructions({
    budgetNote,
    instructionsOverride: instructions,
    personaSummaries: instructionPersonaSummaries,
    planModeActive,
    provider: normalizedProvider,
    taskListNote,
    toolNameMap: effectiveToolNameMap,
  });

  // Error-processor resilience layer (PrefillErrorHandler +
  // StreamErrorRetryProcessor + ProviderHistoryCompat's reactive rules) on the
  // Agent-config `errorProcessors` seam — the ONE processor array a per-call
  // override never clobbers (the per-call TokenLimiter only replaces
  // `inputProcessors`). Excluded for the built-in local provider. When present
  // we MUST pin `maxProcessorRetries`: any errorProcessors flips Mastra's
  // implicit default to 10 (see ASSISTANT_MAX_PROCESSOR_RETRIES). See AGENTS.md
  // ASSISTANT RESILIENCE.
  const errorProcessors = buildAssistantErrorProcessors(normalizedProvider);
  const agent = new Agent({
    id: 'brainstrike-assistant',
    instructions: composedInstructions,
    model: languageModel,
    name: 'Brainstrike Assistant',
    tools: gatedTools,
    ...(hasSubAgents ? { agents: subAgents } : {}),
    ...(memory ? { memory } : {}),
    ...(errorProcessors
      ? { errorProcessors, maxProcessorRetries: ASSISTANT_MAX_PROCESSOR_RETRIES }
      : {}),
  });

  const mastra = storage
    ? new Mastra({
        agents: { brainstrikeAssistant: agent },
        logger: false,
        storage,
      })
    : undefined;

  return {
    agent,
    askTools,
    delegationToolPersonas,
    dispose: async () => {
      await mastra?.shutdown();
      await mcpClient?.disconnect();
    },
    personasById,
    resilienceConfig,
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

interface UsageLike {
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
}

/** Shape of a Mastra stream part with potential usage/text/tool payload fields. */
interface MastraStreamPart {
  delta?: string;
  error?: unknown;
  finishReason?: unknown;
  messageId?: unknown;
  payload?: {
    text?: string;
    textDelta?: string;
    delta?: string;
    error?: unknown;
    tripwireReason?: string;
    stepResult?: { reason?: unknown };
    output?: { usage?: UsageLike };
    metadata?: { usage?: UsageLike };
  };
  runId?: unknown;
  text?: string;
  textDelta?: string;
  tripwireReason?: string;
  type: string;
  usage?: UsageLike;
}

function asMastraStreamPart(part: unknown): MastraStreamPart {
  if (part && typeof part === 'object') {
    return part as MastraStreamPart;
  }
  return { type: 'unknown' };
}

function makeFinishChunk(part: unknown): StreamChunk {
  const p = asMastraStreamPart(part);
  const usageCandidates: Array<UsageLike | undefined> = [
    p.usage,
    p.payload?.output?.usage,
    p.payload?.metadata?.usage,
  ];
  const usage = usageCandidates.find((candidate) => candidate !== undefined) ?? {};
  const promptTokensRaw = usage.promptTokens ?? usage.inputTokens;
  const promptTokens = Number.isFinite(promptTokensRaw) ? (promptTokensRaw ?? 0) : 0;
  const completionTokensRaw = usage.completionTokens ?? usage.outputTokens;
  const completionTokens = Number.isFinite(completionTokensRaw) ? (completionTokensRaw ?? 0) : 0;
  return {
    finishReason: readFinishReason(part),
    path: [],
    type: 'message-finish',
    usage: { completionTokens, promptTokens },
  };
}

function makeSyntheticFinishChunk(): StreamChunk {
  return {
    finishReason: 'other',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

function makeErrorFinishChunk(): StreamChunk {
  return {
    finishReason: 'error',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

function makeToolCallsFinishChunk(): StreamChunk {
  return {
    finishReason: 'tool-calls',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

function normalizeFinishReason(reason: string): StreamFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
    case 'other':
    case 'unknown':
      return reason;
    case 'tool_calls':
      return 'tool-calls';
    default:
      return 'unknown';
  }
}

function readFinishReason(part: unknown): StreamFinishReason {
  const p = asMastraStreamPart(part);
  const direct = p.finishReason;
  if (typeof direct === 'string' && direct.length > 0) {
    return normalizeFinishReason(direct);
  }
  const nested = p.payload?.stepResult?.reason;
  if (typeof nested === 'string' && nested.length > 0) {
    return normalizeFinishReason(nested);
  }
  return 'unknown';
}

function getDeltaText(part: unknown): string {
  const p = asMastraStreamPart(part);
  const payloadText = p.payload?.text ?? p.payload?.textDelta ?? p.payload?.delta;
  return p.text ?? p.textDelta ?? p.delta ?? payloadText ?? '';
}

function isRunEventMetadata(value: unknown): value is AssistantRunEventMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function makeRunEventChunk(
  kind: AssistantRunEventKind,
  status: AssistantRunEventStatus,
  label: string,
  metadata?: AssistantRunEventMetadata,
  timestamp?: string
): StreamChunk {
  return {
    event: {
      id: `run-event-${generateUUID()}`,
      kind,
      label,
      status,
      timestamp: timestamp ?? new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    },
    type: 'run-event',
  };
}

function makeStepMetadata(part: unknown): AssistantRunEventMetadata | undefined {
  const p = asMastraStreamPart(part);
  const metadata: AssistantRunEventMetadata = {};
  if (typeof p.messageId === 'string' && p.messageId.length > 0) {
    metadata['messageId'] = p.messageId;
  }
  if (p.usage) {
    const promptTokens = p.usage.promptTokens ?? p.usage.inputTokens;
    if (typeof promptTokens === 'number' && Number.isFinite(promptTokens)) {
      metadata['promptTokens'] = promptTokens;
    }
    if (typeof p.usage.completionTokens === 'number' && Number.isFinite(p.usage.completionTokens)) {
      metadata['completionTokens'] = p.usage.completionTokens;
    }
  }
  return isRunEventMetadata(metadata) && Object.keys(metadata).length > 0 ? metadata : undefined;
}

type TerminalToolCallState = 'completed' | 'failed';

interface OutputOnlyToolEvent {
  timestamp: string;
  toolEvent: StreamChunkTool;
}

interface ToolLifecycleState {
  delegationLifecycle: DelegationLifecycleTracker;
  outputOnlyToolEvents: Map<string, OutputOnlyToolEvent>;
  terminalToolCallStates: Map<string, TerminalToolCallState>;
}

/**
 * Terminal `subagent.failed` (cancelled) chunks for every delegation still in
 * flight when the parent run aborts — so a cancelled parent never leaves an
 * orphaned `subagent.started` with no counterpart.
 */
function makeCancelledDelegationRunEventChunks(lifecycleState: ToolLifecycleState): StreamChunk[] {
  return lifecycleState.delegationLifecycle
    .drainInFlight()
    .map((metadata) =>
      makeRunEventChunk('subagent.failed', 'cancelled', 'Subagent cancelled', metadata)
    );
}

function getToolEventPayload(toolEvent: StreamChunkTool): AssistantRunEventMetadata | undefined {
  return isRunEventMetadata(toolEvent.payload) ? toolEvent.payload : undefined;
}

function getToolCallIdFromToolEvent(toolEvent: StreamChunkTool): string | undefined {
  const payload = getToolEventPayload(toolEvent);
  return typeof payload?.['toolCallId'] === 'string'
    ? payload['toolCallId']
    : typeof payload?.['callId'] === 'string'
      ? payload['callId']
      : undefined;
}

function makeToolEventMetadata(toolEvent: StreamChunkTool): AssistantRunEventMetadata {
  const payload = getToolEventPayload(toolEvent);
  const toolCallId = getToolCallIdFromToolEvent(toolEvent);
  const metadata: AssistantRunEventMetadata = {
    toolName: toolEvent.name,
    ...(toolCallId ? { toolCallId } : {}),
  };
  if (typeof payload?.['providerExecuted'] === 'boolean') {
    metadata['providerExecuted'] = payload['providerExecuted'];
  }
  if (typeof payload?.['dynamic'] === 'boolean') {
    metadata['dynamic'] = payload['dynamic'];
  }
  return metadata;
}

function makeToolLifecycleRunEventChunk(
  toolEvent: StreamChunkTool,
  mastraPartType: string | undefined,
  lifecycleState: ToolLifecycleState
): StreamChunk | undefined {
  const toolCallId = getToolCallIdFromToolEvent(toolEvent);
  const metadata = makeToolEventMetadata(toolEvent);

  switch (toolEvent.status) {
    case 'start':
      if (!toolCallId) {
        return;
      }
      return makeRunEventChunk('tool.started', 'running', 'Tool started', metadata);
    case 'success': {
      if (!toolCallId) {
        // Mastra terminal tool parts must carry the same stable call id as their
        // start part. Name-based matching would be ambiguous for concurrent
        // same-name tool calls, so durable terminal events are not guessed.
        return;
      }
      if (mastraPartType === 'tool-output') {
        if (!lifecycleState.terminalToolCallStates.has(toolCallId)) {
          lifecycleState.outputOnlyToolEvents.set(toolCallId, {
            timestamp: new Date().toISOString(),
            toolEvent,
          });
        }
        return;
      }
      if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
        return;
      }
      lifecycleState.terminalToolCallStates.set(toolCallId, 'completed');
      lifecycleState.outputOnlyToolEvents.delete(toolCallId);
      return makeRunEventChunk('tool.completed', 'completed', 'Tool completed', metadata);
    }
    case 'error': {
      if (!toolCallId) {
        return;
      }
      if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
        return;
      }
      lifecycleState.terminalToolCallStates.set(toolCallId, 'failed');
      lifecycleState.outputOnlyToolEvents.delete(toolCallId);
      return makeRunEventChunk('tool.failed', 'failed', 'Tool failed', metadata);
    }
    case 'progress':
      return;
  }
}

function makePendingToolOutputRunEventChunks(lifecycleState: ToolLifecycleState): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [toolCallId, outputOnlyToolEvent] of lifecycleState.outputOnlyToolEvents) {
    if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
      continue;
    }
    lifecycleState.terminalToolCallStates.set(toolCallId, 'completed');
    // Sequence remains the ordering source of truth; this timestamp preserves
    // when the output-only terminal observation happened for duration metrics.
    chunks.push(
      makeRunEventChunk(
        'tool.completed',
        'completed',
        'Tool completed',
        makeToolEventMetadata(outputOnlyToolEvent.toolEvent),
        outputOnlyToolEvent.timestamp
      )
    );
  }
  lifecycleState.outputOnlyToolEvents.clear();
  return chunks;
}

function readTripwireReason(part: unknown): string | undefined {
  const p = asMastraStreamPart(part);
  return p.tripwireReason ?? p.payload?.tripwireReason;
}

function getUnsupportedApprovalDetail(
  isSuspended: boolean,
  missingToolCallId: boolean,
  missingRunId: boolean
): string {
  if (missingToolCallId) {
    return `Mastra ${isSuspended ? 'suspended a tool call' : 'requires tool approval'} without a tool call id, so Brainstrike cannot safely resume it.`;
  }
  if (missingRunId && !isSuspended) {
    return 'Mastra requires tool approval without a run id, so Brainstrike cannot safely approve or decline it.';
  }
  if (isSuspended) {
    return 'Mastra suspended a tool call, but this Brainstrike client cannot resume suspended tool calls yet.';
  }
  return 'Mastra requires tool approval, but this Brainstrike client cannot approve or decline tool calls yet.';
}

function makeUnsupportedApprovalChunks(
  part: unknown,
  toolNames: Map<string, string>,
  sanitizedNameMap: Map<string, string> | undefined,
  eventType: 'tool-call-approval' | 'tool-call-suspended'
): StreamChunk[] {
  const upstreamToolCallId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const missingToolCallId = upstreamToolCallId === undefined;
  const toolCallId = upstreamToolCallId ?? `mastra-${eventType}-missing-tool-call-id`;
  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    (upstreamToolCallId ? toolNames.get(upstreamToolCallId) : undefined) ??
    'unknown-tool';
  const toolName = sanitizedNameMap?.get(rawToolName) ?? rawToolName;
  const runId = readMastraStreamPartString(part, 'runId');
  const missingRunId = runId === undefined;
  const args = readMastraStreamPartValue(part, 'args');
  const resumeSchema = readMastraStreamPartValue(part, 'resumeSchema');
  const suspendPayload = readMastraStreamPartValue(part, 'suspendPayload');
  const isSuspended = eventType === 'tool-call-suspended';
  const detail = getUnsupportedApprovalDetail(isSuspended, missingToolCallId, missingRunId);
  const label = isSuspended ? 'Tool resume required' : 'Tool approval required';

  logger.warn('mastra tool approval pause requires unsupported client action', {
    code: 'mastra_agent_tool_action_required',
    eventType,
    missingRunId,
    missingToolCallId,
    ...(runId ? { runId } : {}),
    toolCallId,
    toolName,
  });

  return [
    {
      name: toolName,
      payload: {
        actionRequired: true,
        approvalRequired: !isSuspended,
        callId: toolCallId,
        detail,
        error: detail,
        ...(missingToolCallId ? { missingToolCallId: true } : {}),
        ...(missingRunId ? { missingRunId: true } : {}),
        toolCallId,
        ...(args === undefined ? {} : { args, input: args }),
        ...(runId ? { runId } : {}),
        ...(resumeSchema === undefined ? {} : { resumeSchema }),
        ...(suspendPayload === undefined ? {} : { suspendPayload }),
        suspended: isSuspended,
      },
      status: 'error',
      type: 'tool-event',
    },
    makeRunEventChunk('run.failed', 'failed', label, {
      actionRequired: true,
      approvalRequired: !isSuspended,
      resumeSupported: false,
      ...(runId ? { runId } : {}),
      ...(isSuspended ? { suspended: true } : {}),
      ...(missingToolCallId ? { missingToolCallId: true } : {}),
      ...(missingRunId ? { missingRunId: true } : {}),
      toolCallId,
      toolName,
    }),
    makeErrorFinishChunk(),
  ];
}

function makeApprovalRequiredChunks(
  part: unknown,
  toolNames: Map<string, string>,
  sanitizedNameMap: Map<string, string> | undefined,
  askTools: ReadonlyMap<string, PermissionAskToolMetadata> | undefined
): StreamChunk[] {
  const toolCallId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const runId = readMastraStreamPartString(part, 'runId');
  if (!(toolCallId && runId)) {
    return makeUnsupportedApprovalChunks(part, toolNames, sanitizedNameMap, 'tool-call-approval');
  }

  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    toolNames.get(toolCallId) ??
    'unknown-tool';
  const toolName = sanitizedNameMap?.get(rawToolName) ?? rawToolName;
  const args = readMastraStreamPartValue(part, 'args');
  const resumeSchema = readMastraStreamPartValue(part, 'resumeSchema');
  // The Mastra approval part names the tool by its registered (sanitized) id,
  // which is how `askTools` is keyed by the permission gate. When the pause was
  // driven by a permission 'ask', surface the risk reason so the UI can say WHY.
  const askMetadata = askTools?.get(rawToolName);

  logger.info('mastra tool approval pause surfaced for client approval', {
    code: 'mastra_agent_tool_approval_required',
    runId,
    toolCallId,
    toolName,
    ...(askMetadata ? { riskCategory: askMetadata.riskCategory } : {}),
  });

  return [
    {
      runId,
      toolCallId,
      toolName,
      type: 'tool-approval-required',
      ...(askMetadata ? { policyDecision: 'ask', riskCategory: askMetadata.riskCategory } : {}),
      ...(args === undefined ? {} : { args }),
      ...(resumeSchema === undefined ? {} : { resumeSchema }),
    },
    makeToolCallsFinishChunk(),
  ];
}

/**
 * Turn a `tool-call-suspended` stream part (emitted when a suspending tool calls
 * `suspend()`) into the resumable `tool-suspend-required` chunk + a tool-calls
 * finish. Mirrors {@link makeApprovalRequiredChunks} but carries the tool-defined
 * `suspendPayload` (plan body / question) instead of approval-risk metadata. When
 * the pause is malformed (missing toolCallId/runId) we fall back to the existing
 * unsupported-termination so a bad pause fails visibly rather than silently.
 */
function makeToolSuspendRequiredChunks(
  part: unknown,
  toolNames: Map<string, string>,
  sanitizedNameMap: Map<string, string> | undefined
): StreamChunk[] {
  const toolCallId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const runId = readMastraStreamPartString(part, 'runId');
  if (!(toolCallId && runId)) {
    return makeUnsupportedApprovalChunks(part, toolNames, sanitizedNameMap, 'tool-call-suspended');
  }

  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    toolNames.get(toolCallId) ??
    'unknown-tool';
  const toolName = sanitizedNameMap?.get(rawToolName) ?? rawToolName;
  const suspendPayload = readMastraStreamPartValue(part, 'suspendPayload');
  const resumeSchema = readMastraStreamPartValue(part, 'resumeSchema');

  logger.info('mastra tool suspend pause surfaced for client resume', {
    code: 'mastra_agent_tool_suspend_required',
    runId,
    toolCallId,
    toolName,
  });

  return [
    {
      runId,
      toolCallId,
      toolName,
      type: 'tool-suspend-required',
      ...(suspendPayload === undefined ? {} : { suspendPayload }),
      ...(resumeSchema === undefined ? {} : { resumeSchema }),
    },
    makeToolCallsFinishChunk(),
  ];
}

interface ProcessStreamPartResult {
  chunks: StreamChunk[];
  finished: boolean;
}

/**
 * Resolve the delegation persona id for a parent `tool-call`/`tool-result`/
 * `tool-error` part whose tool is an `agent-<key>` delegation tool, or undefined
 * when it is an ordinary tool. Delegation tool names are Mastra-constructed
 * (`agent-<personaId>`) and never enter the sanitized name map, so the raw
 * toolName equals the key we look up.
 */
function resolveDelegationPersona(
  part: unknown,
  toolNames: Map<string, string>,
  delegationToolPersonas: ReadonlyMap<string, string>
): { parentToolCallId: string | undefined; personaId: string; toolName: string } | undefined {
  if (delegationToolPersonas.size === 0) {
    return;
  }
  const callId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    (callId ? toolNames.get(callId) : undefined);
  if (!rawToolName) {
    return;
  }
  const personaId = delegationToolPersonas.get(rawToolName);
  if (!personaId) {
    return;
  }
  return { parentToolCallId: callId, personaId, toolName: rawToolName };
}

/**
 * Map a delegation `tool-output` part (nested child chunk forwarded on the parent
 * stream, §2.5) into `subagent.tool.*` run events. The generic `mapMastraToolEvent`
 * path is deliberately BYPASSED for these parts (it would emit a bogus
 * successful tool event + `toolCallResult` frame per nested chunk). Child
 * text/reasoning/step/finish chunks produce NOTHING.
 */
function mapDelegationToolOutput(
  part: unknown,
  parentToolCallId: string | undefined,
  personaId: string,
  delegationToolName: string
): StreamChunk[] {
  const nested = readNestedToolOutputChunk(part);
  if (!nested) {
    return [];
  }
  const baseMetadata: AssistantRunEventMetadata = {
    personaId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
    toolName: delegationToolName,
  };
  const childMetadata: AssistantRunEventMetadata = {
    ...baseMetadata,
    ...(nested.toolCallId ? { toolCallId: nested.toolCallId } : {}),
    ...(nested.toolName ? { childToolName: nested.toolName } : {}),
  };
  if (nested.type === 'tool-call') {
    return [
      makeRunEventChunk('subagent.tool.started', 'running', 'Subagent tool started', childMetadata),
    ];
  }
  if (nested.type === 'tool-result') {
    return [
      nested.isError
        ? makeRunEventChunk('subagent.tool.failed', 'failed', 'Subagent tool failed', childMetadata)
        : makeRunEventChunk(
            'subagent.tool.completed',
            'completed',
            'Subagent tool completed',
            childMetadata
          ),
    ];
  }
  if (nested.type === 'tool-error') {
    return [
      makeRunEventChunk('subagent.tool.failed', 'failed', 'Subagent tool failed', childMetadata),
    ];
  }
  return [];
}

/** The generic (non-delegation) tool-event mapping shared by every tool part. */
function mapGenericToolEvent(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  partType: string,
  sanitizedNameMap?: Map<string, string>
): ProcessStreamPartResult {
  const evt = mapMastraToolEvent(part, toolNames, sanitizedNameMap);
  if (!(evt && evt.type === 'tool-event')) {
    return { chunks: [], finished: false };
  }
  const runEvent = makeToolLifecycleRunEventChunk(evt, partType, lifecycleState);
  return {
    chunks: runEvent ? [evt, runEvent] : [evt],
    finished: false,
  };
}

/** The subagent.* run event that mirrors a delegation tool-call/result/error. */
function makeSubagentLifecycleChunk(
  partType: 'tool-call' | 'tool-error' | 'tool-result',
  metadata: AssistantRunEventMetadata
): StreamChunk {
  if (partType === 'tool-call') {
    return makeRunEventChunk('subagent.started', 'running', 'Subagent started', metadata);
  }
  if (partType === 'tool-error') {
    return makeRunEventChunk('subagent.failed', 'failed', 'Subagent failed', metadata);
  }
  return makeRunEventChunk('subagent.finished', 'completed', 'Subagent completed', metadata);
}

/**
 * A delegation tool-call/result/error part: the generic tool event PLUS a
 * mirrored subagent.* run event, while tracking the delegation's in-flight
 * lifecycle so an aborted run can emit a terminal event for orphans.
 */
function mapToolLifecyclePart(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  partType: 'tool-call' | 'tool-error' | 'tool-result',
  sanitizedNameMap: Map<string, string> | undefined,
  delegationToolPersonas: ReadonlyMap<string, string>
): ProcessStreamPartResult {
  const delegation = resolveDelegationPersona(part, toolNames, delegationToolPersonas);
  const generic = mapGenericToolEvent(part, toolNames, lifecycleState, partType, sanitizedNameMap);
  if (!delegation) {
    return generic;
  }
  const metadata: AssistantRunEventMetadata = {
    personaId: delegation.personaId,
    toolName: delegation.toolName,
    ...(delegation.parentToolCallId ? { parentToolCallId: delegation.parentToolCallId } : {}),
  };
  if (delegation.parentToolCallId) {
    if (partType === 'tool-call') {
      lifecycleState.delegationLifecycle.started(delegation.parentToolCallId, metadata);
    } else {
      lifecycleState.delegationLifecycle.settled(delegation.parentToolCallId);
    }
  }
  return {
    chunks: [...generic.chunks, makeSubagentLifecycleChunk(partType, metadata)],
    finished: false,
  };
}

function processMastraStreamPart(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  sanitizedNameMap?: Map<string, string>,
  askTools?: ReadonlyMap<string, PermissionAskToolMetadata>,
  delegationToolPersonas: ReadonlyMap<string, string> = new Map()
): ProcessStreamPartResult {
  const p = asMastraStreamPart(part);

  switch (p.type) {
    case 'start':
      return {
        chunks: [
          makeRunEventChunk(
            'run.started',
            'running',
            'Assistant run started',
            makeStepMetadata(part)
          ),
        ],
        finished: false,
      };
    case 'text-delta': {
      const delta = getDeltaText(part);
      return delta.length > 0
        ? { chunks: [{ type: 'text-delta', value: delta }], finished: false }
        : { chunks: [], finished: false };
    }
    case 'reasoning-delta': {
      const delta = getDeltaText(part);
      return delta.length > 0
        ? { chunks: [{ type: 'reasoning-delta', value: delta }], finished: false }
        : { chunks: [], finished: false };
    }
    case 'step-start':
      return {
        chunks: [
          makeRunEventChunk(
            'run.step.started',
            'running',
            'Generation step started',
            makeStepMetadata(part)
          ),
        ],
        finished: false,
      };
    case 'step-finish':
      return {
        chunks: [
          makeRunEventChunk(
            'run.step.finished',
            'completed',
            'Generation step completed',
            makeStepMetadata(part)
          ),
        ],
        finished: false,
      };
    case 'finish': {
      return {
        chunks: [
          ...makePendingToolOutputRunEventChunks(lifecycleState),
          makeRunEventChunk(
            'run.finished',
            'completed',
            'Assistant run completed',
            makeStepMetadata(part)
          ),
          makeFinishChunk(part),
        ],
        finished: true,
      };
    }
    case 'tool-output': {
      // Delegation `tool-output` = a nested child chunk forwarded on the parent
      // stream. BYPASS the generic tool-event path (it would emit a bogus
      // successful tool event + a `toolCallResult` frame per nested chunk,
      // flooding the UI) and translate to `subagent.tool.*` run events instead.
      const delegation = resolveDelegationPersona(part, toolNames, delegationToolPersonas);
      if (delegation) {
        return {
          chunks: mapDelegationToolOutput(
            part,
            delegation.parentToolCallId,
            delegation.personaId,
            delegation.toolName
          ),
          finished: false,
        };
      }
      return mapGenericToolEvent(part, toolNames, lifecycleState, p.type, sanitizedNameMap);
    }
    case 'tool-call':
    case 'tool-result':
    case 'tool-error':
      return mapToolLifecyclePart(
        part,
        toolNames,
        lifecycleState,
        p.type,
        sanitizedNameMap,
        delegationToolPersonas
      );
    case 'tool-call-input-streaming-start':
    case 'tool-call-delta':
    case 'tool-call-input-streaming-end':
      return mapGenericToolEvent(part, toolNames, lifecycleState, p.type, sanitizedNameMap);
    case 'tool-call-approval':
      // Stop at the first approval pause and surface resumable metadata. Later
      // stream parts are only valid after an explicit approve/decline action.
      return {
        chunks: [
          ...makePendingToolOutputRunEventChunks(lifecycleState),
          ...makeApprovalRequiredChunks(part, toolNames, sanitizedNameMap, askTools),
        ],
        finished: true,
      };
    case 'tool-call-suspended':
      // A suspending tool (submitPlan/askUser) paused via suspend(). Surface the
      // resumable suspend metadata and STOP at the pause; later stream parts are
      // only valid after an explicit resume (streamMastraToolResumeAction).
      return {
        chunks: [
          ...makePendingToolOutputRunEventChunks(lifecycleState),
          ...makeToolSuspendRequiredChunks(part, toolNames, sanitizedNameMap),
        ],
        finished: true,
      };
    case 'error': {
      // Top-level provider errors (e.g. Anthropic returning HTTP 404 for an
      // unavailable model, or Ollama HTTP 400 because the model can't satisfy
      // the registered tool set) arrive as `'error'` parts. We terminate the
      // run gracefully: a visible assistant message with the reason, a terminal
      // `run.failed` run-event (which clears any in-flight "started" spinners),
      // and an error finish so the thread reaches a terminal state. Previously
      // we threw here; the throw produced a data-stream error frame that the
      // renderer did not surface, leaving the thread hung on a forever-spinning
      // "Generation step started" (the "large white pause"). See AGENTS.md.
      return makeProviderErrorTermination(
        extractErrorMessage(p.error ?? p.payload?.error) ?? 'agent_stream_error',
        lifecycleState,
        part
      );
    }
    case 'tripwire': {
      // Same rationale as `'error'`: surface tripwires (content policy
      // violations, etc.) as a visible message + terminal run-event so the user
      // sees the reason and the thread does not hang.
      return makeProviderErrorTermination(
        readTripwireReason(part) ?? 'tripwire',
        lifecycleState,
        part
      );
    }
    default:
      return { chunks: [], finished: false };
  }
}

/**
 * Terminate a run gracefully after a provider/model error part.
 *
 * Emits a user-visible assistant message with the reason, flushes any pending
 * tool-output run-events, marks the run `run.failed` (which clears in-flight
 * "started" spinners in the renderer), and finishes with reason `error`. This
 * replaces throwing on the error part: the throw surfaced a data-stream error
 * frame the renderer never rendered, leaving the thread hung on a spinner.
 */
/** Cap the provider error detail rendered as visible assistant text. Provider
 * error bodies can be verbose; the full detail is preserved in the log. */
const MAX_VISIBLE_PROVIDER_ERROR_CHARS = 600;

function makeProviderErrorTermination(
  detail: string,
  lifecycleState: ToolLifecycleState,
  part: unknown
): ProcessStreamPartResult {
  // Preserve the server-side breadcrumb. We terminate the run gracefully here
  // (visible message + run.failed) instead of throwing through
  // handleStreamFailure, so without this log the provider failure would be
  // invisible server-side — the `mastra_agent_stream_finished` success line in
  // the finally block would be the only record. Log at error level with a
  // distinct code so these stay diagnosable even though the user sees a clean
  // message. (Per AGENTS.md "Feedback & Observability".) The FULL detail goes to
  // the log; the visible message is clamped below.
  logger.error('mastra stream terminated by provider error', {
    code: 'mastra_agent_stream_provider_error',
    detail,
  });
  // Clamp the user-visible detail: provider error bodies can be arbitrarily long
  // (and occasionally echo request context), which reads poorly as persisted
  // assistant text. The full detail stays in the log breadcrumb above.
  const visibleDetail =
    detail.length > MAX_VISIBLE_PROVIDER_ERROR_CHARS
      ? `${detail.slice(0, MAX_VISIBLE_PROVIDER_ERROR_CHARS)}…`
      : detail;
  return {
    chunks: [
      ...makePendingToolOutputRunEventChunks(lifecycleState),
      { type: 'text-delta', value: `The model request failed: ${visibleDetail}` },
      makeRunEventChunk('run.failed', 'failed', 'Assistant run failed', makeStepMetadata(part)),
      makeErrorFinishChunk(),
    ],
    finished: true,
  };
}

function makeStreamStalledTermination(
  error: StreamStalledError,
  lifecycleState: ToolLifecycleState
): StreamChunk[] {
  logger.error('mastra stream stalled by inactivity timeout', {
    code: 'mastra_agent_stream_inactivity_timeout',
    inactivityMs: error.inactivityMs,
  });
  return [
    // A stall mid-delegation must never leave an orphaned `subagent.started`
    // with no terminal counterpart — mirror the abort branches' drain.
    ...makeCancelledDelegationRunEventChunks(lifecycleState),
    ...makePendingToolOutputRunEventChunks(lifecycleState),
    {
      type: 'text-delta',
      value: `The model stream stalled after ${error.inactivityMs}ms without output.`,
    },
    makeRunEventChunk('run.failed', 'failed', 'Assistant run failed', {
      code: error.code,
      inactivityMs: error.inactivityMs,
    }),
    makeErrorFinishChunk(),
  ];
}

function extractErrorMessage(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  try {
    return String(value);
  } catch {
    return;
  }
}

interface RuntimeInitializationResult {
  runtime: MastraAgentRuntime;
  sanitizedNameMap?: Map<string, string>;
}

async function initializeMastraRuntime(
  options: MastraAgentRuntimeOptions,
  runtimeResolution: ResolvedRuntimeConfiguration
): Promise<RuntimeInitializationResult> {
  try {
    const instance = await createMastraAgentRuntime({
      ...options,
      resolved: runtimeResolution,
      runtime: runtimeResolution.runtime,
    });
    const resolvedModel =
      options.model && options.model.length > 0
        ? options.model
        : (getDefaultModel(runtimeResolution.provider) ?? '');
    logger.info('mastra runtime initialized', {
      code: 'mastra_agent_runtime_initialized',
      // Empty string means the caller did not specify a model AND the
      // provider has no static default (e.g. local runtimes whose models are
      // discovered dynamically). This is a real failure mode worth logging.
      model: resolvedModel.length > 0 ? resolvedModel : '<unset>',
      provider: runtimeResolution.provider,
      toolCount: Object.keys(options.tools ?? {}).length,
    });
    return { runtime: instance, sanitizedNameMap: instance.toolNameMap };
  } catch (err) {
    logger.error('mastra runtime init failed', {
      code: 'mastra_agent_runtime_init_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    if (isMastraAgentError(err)) {
      throw err;
    }
    const errorDetail = err instanceof Error ? err.message : undefined;
    throw createMastraAgentError(
      'mastra_agent_runtime_init_failed',
      errorDetail ? { cause: err, detail: errorDetail } : { cause: err }
    );
  }
}

interface StreamIterationParams {
  memory?: MastraMemory;
  messages: AgentMessage[];
  requireToolApproval?: boolean;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}

interface StreamGeneratorParams {
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
  stream: NodeReadableStream<unknown> | ReadableStream<unknown>;
}

interface StreamResultLike {
  fullStream?: NodeReadableStream<unknown> | ReadableStream<unknown>;
}

// Derived from Agent.stream's 2-arg overload (introduced in @mastra/core 1.25 -- the
// 1-arg overload now refuses `undefined` as the second arg, so callers must either
// omit the second arg or pass real options). If a future Mastra bump exposes a
// stable public StreamOptions type, prefer importing that directly over deriving it
// from Parameters<>; the `as AgentStreamOptions` cast at the call sites is what
// keeps this file from reaching across the overload boundary.
type AgentStreamOptions = Exclude<
  Extract<Parameters<Agent['stream']>, [unknown, unknown]>[1],
  undefined
>;
type AgentToolApprovalOptions = Parameters<Agent['approveToolCall']>[0];

interface ToolApprovalIterationParams {
  action: AssistantToolApprovalAction;
  memory?: MastraMemory;
  requireToolApproval?: boolean;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}

/**
 * Per-call approval decision, matching Mastra's `RequireToolApproval` union
 * (`boolean | (ctx) => boolean`). The function form gates approval per tool call;
 * the resume leg uses it to exempt Mastra-internal tools (see
 * {@link resolveResumeApprovalGate}).
 */
type ApprovalGate = boolean | ((ctx: { toolName: string }) => boolean);

interface BrainstrikeAgentStreamOptions {
  abortSignal?: AbortSignal;
  delegation?: DelegationConfig;
  inputProcessors?: unknown[];
  maxSteps?: number;
  memory?: AgentMemoryOption;
  modelSettings?: RuntimeData['modelSettings'];
  providerOptions?: RuntimeData['providerOptions'];
  requireToolApproval?: ApprovalGate;
}

const DEFAULT_AGENT_MAX_STEPS = 20;
const UNSUPPORTED_DIRECT_STREAM_OPTION_KEYS = [
  'activeTools',
  'clientTools',
  'inputProcessors',
  'outputProcessors',
  'prepareStep',
  'structuredOutput',
  'toolChoice',
  'toolsets',
] as const;

function assertNoUnsupportedDirectStreamOptions(options: MastraAgentRuntimeOptions): void {
  const providedUnsupportedKeys = UNSUPPORTED_DIRECT_STREAM_OPTION_KEYS.filter((key) =>
    Object.hasOwn(options, key)
  );
  if (providedUnsupportedKeys.length === 0) {
    return;
  }

  throw createMastraAgentError('mastra_agent_unsupported_stream_option', {
    context: { unsupportedOptions: providedUnsupportedKeys },
    detail: `Unsupported Mastra stream option(s): ${providedUnsupportedKeys.join(', ')}`,
  });
}

function resolvePositiveIntegerOption(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { fieldName, value },
      detail: `${fieldName} must be a positive finite number`,
    });
  }
  return Math.floor(value);
}

function buildToolLoopOptions(
  runtimeData: RuntimeData | undefined
): Pick<BrainstrikeAgentStreamOptions, 'inputProcessors' | 'maxSteps'> {
  const agentLoop = runtimeData?.agentLoop;
  const maxSteps = resolvePositiveIntegerOption(agentLoop?.maxSteps, 'agentLoop.maxSteps');
  const inputTokenLimit = resolvePositiveIntegerOption(
    agentLoop?.inputTokenLimit,
    'agentLoop.inputTokenLimit'
  );
  // ProviderHistoryCompat's PREEMPTIVE `processLLMRequest` rules (strip
  // foreign/unsupported reasoning before a provider that would reject it — the
  // only place cross-provider reasoning incompatibility is handled) fire ONLY
  // from `inputProcessors`, never `errorProcessors` (verified against the
  // compiled loop). It rides the SAME per-call array as the TokenLimiter so the
  // per-call replacement doesn't drop either; their hooks are disjoint stages,
  // so token trimming is unaffected. Excluded for the local provider.
  const historyCompat = buildProviderHistoryCompatInputProcessor(runtimeData?.provider ?? '');
  const tokenLimiter = inputTokenLimit
    ? new TokenLimiter({ limit: inputTokenLimit, strategy: 'truncate', trimMode: 'contiguous' })
    : undefined;
  const inputProcessors: unknown[] = [tokenLimiter, historyCompat].filter(
    (processor): processor is NonNullable<typeof processor> => processor !== undefined
  );

  return {
    maxSteps: maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
    ...(inputProcessors.length > 0 ? { inputProcessors } : {}),
  };
}

const resolveFullStream = (
  result: unknown
): NodeReadableStream<unknown> | ReadableStream<unknown> | undefined => {
  if (!result || typeof result !== 'object') {
    return;
  }
  return (result as StreamResultLike).fullStream;
};

function resolveMemoryOption(
  runtimeData: RuntimeData | undefined,
  memory: MastraMemory | undefined
): AgentMemoryOption | undefined {
  const memoryContext = runtimeData?.memory;
  if (!memoryContext) {
    return;
  }
  if (!memory) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'runtime memory context was provided but no Mastra memory instance is configured',
    });
  }
  if (!memoryContext.threadId.trim()) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'memory.threadId is required',
    });
  }
  if (!memoryContext.resourceId.trim()) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'memory.resourceId is required',
    });
  }
  return {
    resource: memoryContext.resourceId,
    thread: memoryContext.threadId,
    ...(memoryContext.memoryOptions ? { options: memoryContext.memoryOptions } : {}),
  };
}

async function* streamChunksFromMastra({
  runtime,
  runtimeData,
  stream,
  sanitizedNameMap,
}: StreamGeneratorParams): AsyncIterableIterator<StreamChunk> {
  const toolNames = new Map<string, string>();
  const lifecycleState: ToolLifecycleState = {
    delegationLifecycle: createDelegationLifecycleTracker(),
    outputOnlyToolEvents: new Map(),
    terminalToolCallStates: new Map(),
  };

  try {
    const source = withInactivityTimeout(
      readableStreamIterator(stream, runtimeData?.signal),
      runtime.resilienceConfig.streamInactivityMs
    );
    for await (const part of source) {
      const { chunks, finished } = processMastraStreamPart(
        part,
        toolNames,
        lifecycleState,
        sanitizedNameMap,
        runtime.askTools,
        runtime.delegationToolPersonas
      );
      for (const chunk of chunks) {
        yield chunk;
      }

      if (finished) {
        return;
      }
    }
    // Aborted mid-run: settle any orphaned delegations (a cancelled parent must
    // never leave a forever-"running" subagent.started). Otherwise finalize a
    // missing-finish stream with pending tool output + a synthetic finish.
    const endChunks = runtimeData?.signal?.aborted
      ? makeCancelledDelegationRunEventChunks(lifecycleState)
      : makeMissingFinishStreamChunks(lifecycleState);
    for (const chunk of endChunks) {
      yield chunk;
    }
  } catch (error) {
    if (!(error instanceof StreamStalledError)) {
      throw error;
    }
    const stalledChunks = runtimeData?.signal?.aborted
      ? makeCancelledDelegationRunEventChunks(lifecycleState)
      : makeStreamStalledTermination(error, lifecycleState);
    for (const chunk of stalledChunks) {
      yield chunk;
    }
    return;
  } finally {
    logStreamOutcome(Boolean(runtimeData?.signal?.aborted));
    await runtime?.dispose();
  }
}

/** Post-loop chunks when a stream ends WITHOUT a finish event (not aborted). */
function makeMissingFinishStreamChunks(lifecycleState: ToolLifecycleState): StreamChunk[] {
  logger.warn('mastra stream ended without finish event', {
    code: 'mastra_agent_stream_missing_finish',
  });
  return [...makePendingToolOutputRunEventChunks(lifecycleState), makeSyntheticFinishChunk()];
}

function logStreamOutcome(aborted: boolean): void {
  if (aborted) {
    logger.info('mastra stream aborted', { code: 'mastra_agent_stream_aborted' });
    return;
  }
  logger.info('mastra stream finished', { code: 'mastra_agent_stream_finished' });
}

async function createStreamIteratorFromRuntime({
  runtime,
  runtimeData,
  messages,
  memory,
  requireToolApproval,
  sanitizedNameMap,
}: StreamIterationParams): Promise<StreamIterator> {
  const mastraMessages = convertMessagesToMastra(messages);

  try {
    const streamInput = mastraMessages as unknown as Parameters<typeof runtime.agent.stream>[0];
    const memoryOption = resolveMemoryOption(runtimeData, memory);

    const streamOptions: BrainstrikeAgentStreamOptions = {
      ...buildToolLoopOptions(runtimeData),
      ...(runtimeData?.signal ? { abortSignal: runtimeData.signal } : {}),
      ...(memoryOption ? { memory: memoryOption } : {}),
      ...(runtimeData?.modelSettings ? { modelSettings: runtimeData.modelSettings } : {}),
      ...(runtimeData?.providerOptions ? { providerOptions: runtimeData.providerOptions } : {}),
      // Delegation safety rails: per-run caps + maxSteps clamp + unknown-persona
      // rejection (only when the run has registered personas).
      ...(runtime.personasById.size > 0
        ? { delegation: createDelegationConfig({ logger, personasById: runtime.personasById }) }
        : {}),
      // When enabled, Mastra pauses before tool execution and emits resumable
      // approval metadata for the UI action bridge.
      ...(requireToolApproval === undefined ? {} : { requireToolApproval }),
    };
    const resolvedStreamOptions = Object.keys(streamOptions).length > 0 ? streamOptions : undefined;

    const streamResult = resolvedStreamOptions
      ? await runtime.agent.stream(streamInput, resolvedStreamOptions as AgentStreamOptions)
      : await runtime.agent.stream(streamInput);
    logger.info('mastra stream started', { code: 'mastra_agent_stream_started' });

    const fullStream = resolveFullStream(streamResult);
    if (!fullStream) {
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: 'empty_stream',
      });
    }

    return streamChunksFromMastra({
      runtime,
      stream: fullStream,
      ...(runtimeData ? { runtimeData } : {}),
      ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
    });
  } catch (err) {
    return await handleStreamFailure(err, runtime);
  }
}

function validateToolApprovalAction(action: AssistantToolApprovalAction): void {
  if (!action.runId.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'tool approval action requires runId',
    });
  }
  if (!action.toolCallId.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'tool approval action requires toolCallId',
    });
  }
}

/**
 * The approval RESUME leg passes Mastra's run-wide `requireToolApproval: true`
 * (the resume API needs it — see AGENTS.md PERMISSION ENGINE). A blanket `true`
 * gates EVERY tool call on the resumed run, so Mastra's INTERNAL memory tools
 * (`updateWorkingMemory`) would surface a spurious approval prompt (the D4
 * defect). Substitute the FUNCTION form of the gate so internal bookkeeping tools
 * run free while genuine mutation tools still suspend. A caller-supplied function
 * or a non-`true` value passes through unchanged.
 */
function resolveResumeApprovalGate(requireToolApproval: ApprovalGate | undefined): ApprovalGate {
  if (requireToolApproval !== true) {
    return requireToolApproval ?? false;
  }
  return ({ toolName }: { toolName: string }): boolean => !isApprovalExemptInternalTool(toolName);
}

async function createToolApprovalIteratorFromRuntime({
  runtime,
  runtimeData,
  action,
  memory,
  requireToolApproval,
  sanitizedNameMap,
}: ToolApprovalIterationParams): Promise<StreamIterator> {
  try {
    validateToolApprovalAction(action);
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    const approvalOptions: BrainstrikeAgentStreamOptions & {
      runId: string;
      toolCallId: string;
    } = {
      ...buildToolLoopOptions(runtimeData),
      runId: action.runId,
      toolCallId: action.toolCallId,
      ...(runtimeData?.signal ? { abortSignal: runtimeData.signal } : {}),
      ...(memoryOption ? { memory: memoryOption } : {}),
      ...(runtimeData?.modelSettings ? { modelSettings: runtimeData.modelSettings } : {}),
      ...(runtimeData?.providerOptions ? { providerOptions: runtimeData.providerOptions } : {}),
      // Resume keeps the delegation rails so a resumed run still caps/rejects
      // subagent delegations consistently with the initial turn.
      ...(runtime.personasById.size > 0
        ? { delegation: createDelegationConfig({ logger, personasById: runtime.personasById }) }
        : {}),
      // Exempt Mastra-internal tools (updateWorkingMemory) from the run-wide
      // approval gate on the resume leg (D4).
      ...(requireToolApproval === undefined
        ? {}
        : { requireToolApproval: resolveResumeApprovalGate(requireToolApproval) }),
    };

    const streamResult =
      action.action === 'approve'
        ? await runtime.agent.approveToolCall(approvalOptions as AgentToolApprovalOptions)
        : await runtime.agent.declineToolCall(approvalOptions as AgentToolApprovalOptions);

    logger.info('mastra tool approval resume stream started', {
      action: action.action,
      code: 'mastra_agent_tool_approval_resume_started',
      runId: action.runId,
      toolCallId: action.toolCallId,
    });

    const fullStream = resolveFullStream(streamResult);
    if (!fullStream) {
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: 'empty_stream',
      });
    }

    return streamChunksFromMastra({
      runtime,
      stream: fullStream,
      ...(runtimeData ? { runtimeData } : {}),
      ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
    });
  } catch (err) {
    return await handleStreamFailure(err, runtime);
  }
}

async function handleStreamFailure(err: unknown, runtime: MastraAgentRuntime): Promise<never> {
  logger.error('mastra stream failed', {
    code: 'mastra_agent_stream_failed',
    error: err instanceof Error ? err.message : String(err),
  });
  try {
    await runtime.dispose();
  } catch (disposeError) {
    logger.warn('dispose after stream failure failed', {
      code: 'mastra_agent_runtime_dispose_failed',
      error: disposeError instanceof Error ? disposeError.message : String(disposeError),
    });
  }
  if (isMastraAgentError(err)) {
    throw err;
  }
  const errorDetail = err instanceof Error ? err.message : undefined;
  throw createMastraAgentError(
    'mastra_agent_stream_failure',
    errorDetail ? { cause: err, detail: errorDetail } : { cause: err }
  );
}

export async function streamMastraAgent(
  messages: AgentMessage[],
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  assertNoUnsupportedDirectStreamOptions(options);

  const runtimeData = options.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData);
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(options, runtimeResolution);

  // Per-call approval for `'ask'` tools comes from the PER-TOOL `requireApproval`
  // flag the permission gate set (see permission-tool-gate.ts), NOT from the
  // run-wide `requireToolApproval` — the global flag would suspend EVERY tool
  // call, including allowed read/mcp tools. We therefore only pass
  // `requireToolApproval` when the caller explicitly set it (e.g. a deliberate
  // approve-all run); an unset option leaves the run on the per-tool gate.
  const requireToolApproval = options.requireToolApproval;

  return createStreamIteratorFromRuntime({
    messages,
    runtime,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(requireToolApproval === undefined ? {} : { requireToolApproval }),
    ...(runtimeData ? { runtimeData } : {}),
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}

/**
 * Derive the native tool map + selected model from the runtime when the caller
 * did not set them explicitly on the options.
 *
 * The initial-turn path does this in `toAiSdkStyleStream` (message-utils.ts):
 * `runtime.mastraTools -> options.tools` and `runtime.model -> options.model`.
 * The approval RESUME (`streamMastraToolApprovalAction`) calls
 * `initializeMastraRuntime` DIRECTLY, so without this it rebuilds the Agent with
 * an EMPTY native tool map — the model then sees only Mastra's memory tools (e.g.
 * `updateWorkingMemory`) and reports the approved tool "missing" (the desktop
 * write-on-approval bug) — and would silently fall back to the provider's DEFAULT
 * model instead of the user's selected one. `mcpConfig` needs no threading here:
 * `createMastraAgentRuntime` already falls back to `sanitizedRuntime.mcpConfig`.
 */
function withRuntimeDerivedStreamOptions(
  options: MastraAgentRuntimeOptions
): MastraAgentRuntimeOptions {
  const runtimeData = options.runtime;
  if (!runtimeData) {
    return options;
  }
  const derived: MastraAgentRuntimeOptions = { ...options };
  if (derived.tools === undefined && runtimeData.mastraTools) {
    derived.tools = runtimeData.mastraTools;
  }
  if (derived.model === undefined && runtimeData.model) {
    derived.model = runtimeData.model;
  }
  // Personas ride the same resume-parity seam: without this, the approval-resume
  // path rebuilds the supervisor WITHOUT its `agent-<id>` delegation tools (the
  // documented write-on-approval bug class applied to delegation).
  if (derived.personas === undefined && runtimeData.personas) {
    derived.personas = runtimeData.personas;
  }
  return derived;
}

export async function streamMastraToolApprovalAction(
  action: AssistantToolApprovalAction,
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  assertNoUnsupportedDirectStreamOptions(options);
  validateToolApprovalAction(action);
  if (!options.storage) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Mastra workflow storage is required to resume tool approval.',
    });
  }

  const runtimeData = options.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData);
  // Thread runtime.mastraTools/model into the options so the rebuilt Agent keeps
  // the native tools on resume (see withRuntimeDerivedStreamOptions).
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(
    withRuntimeDerivedStreamOptions(options),
    runtimeResolution
  );

  return createToolApprovalIteratorFromRuntime({
    action,
    runtime,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.requireToolApproval === undefined
      ? {}
      : { requireToolApproval: options.requireToolApproval }),
    ...(runtimeData ? { runtimeData } : {}),
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}

export interface DiscoveredSuspendedApproval {
  readonly args?: unknown;
  readonly runId: string;
  /** ISO-8601 instant the run suspended (AgentRun.suspendedAt). */
  readonly suspendedAt: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface ListSuspendedApprovalsResult {
  readonly approvals: readonly DiscoveredSuspendedApproval[];
}

/**
 * Restart-safe discovery of pending tool approvals for a thread. Rebuilds a
 * FRESH runtime (like {@link streamMastraToolApprovalAction}) and calls the
 * sanctioned `agent.listSuspendedRuns` — it holds no in-memory stream handle, so
 * it works after a process restart / renderer reload given only the thread
 * context. It is INERT: listing performs no inference and never resumes a run.
 *
 * Returns ONLY approval-gated tool calls (`requiresApproval === true`) that carry
 * a `toolCallId` + `toolName`. Non-approval `suspend()` pauses (submitPlan/askUser)
 * and delegation-thread runs are tolerated and skipped without error (logged at
 * debug) — a unified suspend rediscovery is a follow-up. Storage is REQUIRED (no
 * storage ⇒ no discovery, never a silent empty result).
 */
export async function listSuspendedMastraRuns(
  filter: { readonly threadId: string; readonly resourceId: string },
  options: MastraAgentRuntimeOptions = {}
): Promise<ListSuspendedApprovalsResult> {
  assertNoUnsupportedDirectStreamOptions(options);
  if (!options.storage) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Mastra workflow storage is required to discover suspended approvals.',
    });
  }

  const runtimeResolution = resolveRuntimeConfiguration(options.runtime);
  // Listing performs NO inference: build the runtime with an inert model so no
  // provider/model is resolved. This is why the discovery route can pass a
  // keyless provider with no static default (e.g. ollama) without the
  // `No default model configured` init throw (the D1 fix).
  const { runtime } = await initializeMastraRuntime(
    withRuntimeDerivedStreamOptions({ ...options, modelOverride: createListingOnlyModel() }),
    runtimeResolution
  );

  try {
    const { runs } = await runtime.agent.listSuspendedRuns({
      resourceId: filter.resourceId,
      threadId: filter.threadId,
    });

    const approvals: DiscoveredSuspendedApproval[] = [];
    for (const run of runs) {
      const suspendedAt = run.suspendedAt.toISOString();
      for (const toolCall of run.toolCalls) {
        if (!(toolCall.requiresApproval && toolCall.toolCallId && toolCall.toolName)) {
          logger.debug('skipping non-approval suspended tool call', {
            code: 'mastra_agent_suspended_run_skipped',
            requiresApproval: toolCall.requiresApproval,
            runId: run.runId,
            toolName: toolCall.toolName,
          });
          continue;
        }
        approvals.push({
          runId: run.runId,
          suspendedAt,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          ...(toolCall.args === undefined ? {} : { args: toolCall.args }),
        });
      }
    }

    approvals.sort((a, b) => Date.parse(a.suspendedAt) - Date.parse(b.suspendedAt));

    logger.info('discovered suspended approvals', {
      approvalCount: approvals.length,
      code: 'mastra_agent_suspended_runs_discovered',
      runCount: runs.length,
      threadId: filter.threadId,
    });

    return { approvals };
  } finally {
    await runtime.dispose();
  }
}

// resumeStream's resumeData param is typed `any` by Mastra; we cast a typed
// `unknown` through this alias at the single call site (no other `any` here).
type AgentResumeStreamOptions = Parameters<Agent['resumeStream']>[1];

interface ToolResumeIterationParams {
  action: AssistantToolResumeAction;
  memory?: MastraMemory;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}

function validateToolResumeAction(action: AssistantToolResumeAction): void {
  if (!action.runId.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'tool resume action requires runId',
    });
  }
  if (!action.toolCallId.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'tool resume action requires toolCallId',
    });
  }
}

async function createToolResumeIteratorFromRuntime({
  runtime,
  runtimeData,
  action,
  memory,
  sanitizedNameMap,
}: ToolResumeIterationParams): Promise<StreamIterator> {
  try {
    validateToolResumeAction(action);
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    const resumeOptions = {
      ...buildToolLoopOptions(runtimeData),
      runId: action.runId,
      toolCallId: action.toolCallId,
      ...(runtimeData?.signal ? { abortSignal: runtimeData.signal } : {}),
      ...(memoryOption ? { memory: memoryOption } : {}),
      ...(runtimeData?.modelSettings ? { modelSettings: runtimeData.modelSettings } : {}),
      ...(runtimeData?.providerOptions ? { providerOptions: runtimeData.providerOptions } : {}),
      // Resume keeps the delegation rails so a resumed run (e.g. an askUser
      // pause→answer that then delegates) still caps/rejects subagent
      // delegations consistently with the initial + approval-resume iterators.
      ...(runtime.personasById.size > 0
        ? { delegation: createDelegationConfig({ logger, personasById: runtime.personasById }) }
        : {}),
    };

    // resumeData is validated by Mastra against the suspended tool's resumeSchema.
    const streamResult = await runtime.agent.resumeStream(
      action.resumeData as Parameters<typeof runtime.agent.resumeStream>[0],
      resumeOptions as AgentResumeStreamOptions
    );

    logger.info('mastra tool resume stream started', {
      code: 'mastra_agent_tool_resume_started',
      runId: action.runId,
      toolCallId: action.toolCallId,
    });

    const fullStream = resolveFullStream(streamResult);
    if (!fullStream) {
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: 'empty_stream',
      });
    }

    return streamChunksFromMastra({
      runtime,
      stream: fullStream,
      ...(runtimeData ? { runtimeData } : {}),
      ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
    });
  } catch (err) {
    return await handleStreamFailure(err, runtime);
  }
}

/**
 * Resume a SUSPENDED tool call (submitPlan/askUser) via
 * `agent.resumeStream(resumeData, { runId, toolCallId })`. Parallels
 * {@link streamMastraToolApprovalAction} but for the generic suspend transport:
 * `action.resumeData` is arbitrary (a plan decision or an answer) and validated
 * by Mastra against the tool's resumeSchema. Workflow storage is REQUIRED (the
 * snapshot must exist to resume — no silent fallback). `withRuntimeDerivedStreamOptions`
 * is mandatory so the rebuilt Agent keeps its native tools (the same desktop
 * write-on-approval fix). Stateless: it holds no in-memory runId, so a future
 * `listSuspendedRuns` rehydrator can call it with a discovered runId unchanged.
 * Does NOT pass `requireToolApproval` (that is approval-specific).
 */
export async function streamMastraToolResumeAction(
  action: AssistantToolResumeAction,
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  assertNoUnsupportedDirectStreamOptions(options);
  validateToolResumeAction(action);
  if (!options.storage) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Mastra workflow storage is required to resume a suspended tool.',
    });
  }

  const runtimeData = options.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData);
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(
    withRuntimeDerivedStreamOptions(options),
    runtimeResolution
  );

  return createToolResumeIteratorFromRuntime({
    action,
    runtime,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(runtimeData ? { runtimeData } : {}),
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}
