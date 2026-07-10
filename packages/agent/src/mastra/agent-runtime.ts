import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import { createLogger, generateUUID } from '@brainstrike/utils';
import { Agent, type AgentMemoryOption, type ToolsInput } from '@mastra/core/agent';
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
import {
  buildContextBudgetNote,
  buildCurrentTaskListNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
} from './default-instructions';
import { createMastraAgentError, isMastraAgentError } from './mastra-agent-error';
import { collectCombinedTools } from './mcp-tool-loader';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionAskToolMetadata,
  type PermissionToolGateSnapshot,
} from './permission-tool-gate';
import {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './runtime-configuration';
import {
  mapMastraToolEvent,
  readMastraStreamPartString,
  readMastraStreamPartValue,
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
   * Serializable permission posture + tool risk classification used to gate the
   * tool map before the Agent is built. Overrides `runtime.permissionPolicy`
   * when both are present. OPTIONAL — when neither is set the tool map is
   * unchanged (production-default).
   */
  permissionPolicy?: PermissionToolGateSnapshot;
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
  dispose: () => Promise<void>;
  mcpClient?: MCPClient;
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
    resolved,
    memory,
    storage,
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
  const gateResult = filterToolsByPermissionWithMetadata(
    guardedTools,
    permissionSnapshot,
    toolNameMap,
    logger
  );
  const { tools: gatedTools, askTools } = resolveAskToolsForRun(gateResult, Boolean(storage));

  // Create provider-specific model instance
  const modelName = model ?? getDefaultModel(normalizedProvider);
  const languageModel = instantiateLanguageModel(
    normalizedProvider,
    apiKey,
    modelName,
    sanitizedRuntime
  );

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
  // The built-in local model gets a compact instruction set: the hosted
  // playbook overwhelms a 2B on-device model and bloats the WebGPU prefill.
  const resolvedInstructions =
    instructions ??
    (normalizedProvider === 'local'
      ? buildLocalDefaultInstructions(toolNameMap)
      : buildDefaultInstructions(toolNameMap));
  // Order: instructions, budget note, then the task list LAST so it is the most
  // recent context the model sees.
  const composedInstructions = [resolvedInstructions, budgetNote, taskListNote]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const agent = new Agent({
    id: 'brainstrike-assistant',
    instructions: composedInstructions,
    model: languageModel,
    name: 'Brainstrike Assistant',
    tools: gatedTools,
    ...(memory ? { memory } : {}),
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
    dispose: async () => {
      await mastra?.shutdown();
      await mcpClient?.disconnect();
    },
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
  outputOnlyToolEvents: Map<string, OutputOnlyToolEvent>;
  terminalToolCallStates: Map<string, TerminalToolCallState>;
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

interface ProcessStreamPartResult {
  chunks: StreamChunk[];
  finished: boolean;
}

function processMastraStreamPart(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  sanitizedNameMap?: Map<string, string>,
  askTools?: ReadonlyMap<string, PermissionAskToolMetadata>
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
    case 'tool-call':
    case 'tool-call-input-streaming-start':
    case 'tool-call-delta':
    case 'tool-call-input-streaming-end':
    case 'tool-result':
    case 'tool-error':
    case 'tool-output': {
      const evt = mapMastraToolEvent(part, toolNames, sanitizedNameMap);
      if (!(evt && evt.type === 'tool-event')) {
        return { chunks: [], finished: false };
      }
      const runEvent = makeToolLifecycleRunEventChunk(evt, p.type, lifecycleState);
      return {
        chunks: runEvent ? [evt, runEvent] : [evt],
        finished: false,
      };
    }
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
      // This client cannot resume suspended tool calls yet, so stop at the
      // first pause instead of consuming later stream parts that would imply
      // forward progress.
      return {
        chunks: [
          ...makePendingToolOutputRunEventChunks(lifecycleState),
          ...makeUnsupportedApprovalChunks(part, toolNames, sanitizedNameMap, p.type),
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

interface BrainstrikeAgentStreamOptions {
  abortSignal?: AbortSignal;
  inputProcessors?: unknown[];
  maxSteps?: number;
  memory?: AgentMemoryOption;
  modelSettings?: RuntimeData['modelSettings'];
  providerOptions?: RuntimeData['providerOptions'];
  requireToolApproval?: boolean;
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
  const inputProcessors: unknown[] | undefined = inputTokenLimit
    ? [new TokenLimiter({ limit: inputTokenLimit, strategy: 'truncate', trimMode: 'contiguous' })]
    : undefined;

  return {
    maxSteps: maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
    ...(inputProcessors ? { inputProcessors } : {}),
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
        runtime.askTools
      );
      for (const chunk of chunks) {
        yield chunk;
      }

      if (finished) {
        return;
      }
    }
    if (!runtimeData?.signal?.aborted) {
      logger.warn('mastra stream ended without finish event', {
        code: 'mastra_agent_stream_missing_finish',
      });
      for (const chunk of makePendingToolOutputRunEventChunks(lifecycleState)) {
        yield chunk;
      }
      yield makeSyntheticFinishChunk();
    }
  } catch (error) {
    if (error instanceof StreamStalledError) {
      if (runtimeData?.signal?.aborted) {
        return;
      }
      for (const chunk of makeStreamStalledTermination(error, lifecycleState)) {
        yield chunk;
      }
      return;
    }
    throw error;
  } finally {
    if (runtimeData?.signal?.aborted) {
      logger.info('mastra stream aborted', { code: 'mastra_agent_stream_aborted' });
    } else {
      logger.info('mastra stream finished', { code: 'mastra_agent_stream_finished' });
    }
    await runtime?.dispose();
  }
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
      ...(requireToolApproval === undefined ? {} : { requireToolApproval }),
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
