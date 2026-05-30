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
import type { McpConfig } from '../mcp/config';
import { createProvider, getDefaultModel } from '../providers/provider-factory';
import type {
  AssistantRunEventKind,
  AssistantRunEventMetadata,
  AssistantRunEventStatus,
} from '../run-events';
import { readableStreamIterator } from '../stream/readable-stream-iterator';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type {
  AgentMessage,
  RuntimeData,
  StreamChunk,
  StreamFinishReason,
  StreamIterator,
} from '../types';
import { buildDefaultInstructions } from './default-instructions';
import { createMastraAgentError, isMastraAgentError } from './mastra-agent-error';
import { collectCombinedTools } from './mcp-tool-loader';
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
  requireToolApproval?: boolean;
  resolved?: ResolvedRuntimeConfiguration;
  runtime?: RuntimeData;
  storage?: MastraCompositeStore;
  tools?: ToolsInput;
}

export interface MastraAgentRuntime {
  agent: Agent;
  dispose: () => Promise<void>;
  mastra?: Mastra;
  mcpClient?: MCPClient;
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
      detail,
      context: { provider, model: modelName },
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
      result.push({ role: message.role, content: textParts.join('\n\n') });
    }
  }
  return result;
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
    sanitizedLocalTools,
    mcpClient,
    mcpConfig: mcpConfig ?? sanitizedRuntime.mcpConfig,
    toolNameMap,
    timeoutOverrideMs: mcpTimeoutMs,
  });

  // Create provider-specific model instance
  const modelName = model ?? getDefaultModel(normalizedProvider);
  const languageModel = instantiateLanguageModel(
    normalizedProvider,
    apiKey,
    modelName,
    sanitizedRuntime
  );

  assertModernLanguageModel(languageModel, normalizedProvider, modelName);

  const agent = new Agent({
    id: 'brainstrike-assistant',
    name: 'Brainstrike Assistant',
    instructions: instructions ?? buildDefaultInstructions(toolNameMap),
    model: languageModel,
    tools: combinedTools,
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
    dispose: async () => {
      await mcpClient?.disconnect();
    },
    ...(mastra ? { mastra } : {}),
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
    detail: `AI SDK v1 model runtime is not supported for Brainstrike chat streaming: ${provider}/${model}. Select a provider/model backed by the modern AI SDK v2 streaming runtime before retrying.`,
    context: { provider, model, specificationVersion: spec },
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
    type: 'message-finish',
    finishReason: readFinishReason(part),
    usage: { promptTokens, completionTokens },
    path: [],
  };
}

function makeSyntheticFinishChunk(): StreamChunk {
  return {
    type: 'message-finish',
    finishReason: 'other',
    usage: { promptTokens: 0, completionTokens: 0 },
    path: [],
  };
}

function makeErrorFinishChunk(): StreamChunk {
  return {
    type: 'message-finish',
    finishReason: 'error',
    usage: { promptTokens: 0, completionTokens: 0 },
    path: [],
  };
}

function makeToolCallsFinishChunk(): StreamChunk {
  return {
    type: 'message-finish',
    finishReason: 'tool-calls',
    usage: { promptTokens: 0, completionTokens: 0 },
    path: [],
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
  metadata?: AssistantRunEventMetadata
): StreamChunk {
  return {
    type: 'run-event',
    event: {
      id: `run-event-${generateUUID()}`,
      kind,
      label,
      status,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    },
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
    missingToolCallId,
    missingRunId,
    ...(runId ? { runId } : {}),
    toolCallId,
    toolName,
  });

  return [
    {
      type: 'tool-event',
      name: toolName,
      status: 'error',
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
  sanitizedNameMap: Map<string, string> | undefined
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

  logger.info('mastra tool approval pause surfaced for client approval', {
    code: 'mastra_agent_tool_approval_required',
    runId,
    toolCallId,
    toolName,
  });

  return [
    {
      type: 'tool-approval-required',
      runId,
      toolCallId,
      toolName,
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
  sanitizedNameMap?: Map<string, string>
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
      return evt ? { chunks: [evt], finished: false } : { chunks: [], finished: false };
    }
    case 'tool-call-approval':
      // Stop at the first approval pause and surface resumable metadata. Later
      // stream parts are only valid after an explicit approve/decline action.
      return {
        chunks: makeApprovalRequiredChunks(part, toolNames, sanitizedNameMap),
        finished: true,
      };
    case 'tool-call-suspended':
      // This client cannot resume suspended tool calls yet, so stop at the
      // first pause instead of consuming later stream parts that would imply
      // forward progress.
      return {
        chunks: makeUnsupportedApprovalChunks(part, toolNames, sanitizedNameMap, p.type),
        finished: true,
      };
    case 'error': {
      // Top-level provider errors (e.g. Ollama returning HTTP 400 because the
      // selected model does not support tool calling) arrive as `'error'`
      // chunks. Throwing here propagates them to the data-stream session's
      // `handleError` which emits a real `error` data-stream chunk + finish
      // message to the client. Previously we tried to map this to a synthetic
      // `tool-event` with `name: 'agent'` and no `toolCallId`, which the
      // data-stream mapper silently drops -- producing the "stream finished
      // with no output" failure mode reported for local Ollama models that
      // can't satisfy the registered tool set.
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: extractErrorMessage(p.error ?? p.payload?.error) ?? 'agent_stream_error',
      });
    }
    case 'tripwire': {
      // Same rationale as `'error'`: the previous tool-event mapping was
      // silently dropped. Surface tripwires (content policy violations, etc.)
      // as real errors so the user sees the reason.
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: readTripwireReason(part) ?? 'tripwire',
      });
    }
    default:
      return { chunks: [], finished: false };
  }
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
      runtime: runtimeResolution.runtime,
      resolved: runtimeResolution,
    });
    const resolvedModel =
      options.model && options.model.length > 0
        ? options.model
        : (getDefaultModel(runtimeResolution.provider) ?? '');
    logger.info('mastra runtime initialized', {
      code: 'mastra_agent_runtime_initialized',
      provider: runtimeResolution.provider,
      // Empty string means the caller did not specify a model AND the
      // provider has no static default (e.g. local runtimes whose models are
      // discovered dynamically). This is a real failure mode worth logging.
      model: resolvedModel.length > 0 ? resolvedModel : '<unset>',
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
    detail: `Unsupported Mastra stream option(s): ${providedUnsupportedKeys.join(', ')}`,
    context: { unsupportedOptions: providedUnsupportedKeys },
  });
}

function resolvePositiveIntegerOption(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: `${fieldName} must be a positive finite number`,
      context: { fieldName, value },
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
    thread: memoryContext.threadId,
    resource: memoryContext.resourceId,
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

  try {
    for await (const part of readableStreamIterator(stream, runtimeData?.signal)) {
      const { chunks, finished } = processMastraStreamPart(part, toolNames, sanitizedNameMap);
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
      yield makeSyntheticFinishChunk();
    }
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
      // Until approve/decline/resume is implemented, enabling this makes tool calls
      // pause and surface as terminal unsupported-action errors.
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
  sanitizedNameMap,
}: ToolApprovalIterationParams): Promise<StreamIterator> {
  validateToolApprovalAction(action);

  try {
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

  return createStreamIteratorFromRuntime({
    runtime,
    messages,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.requireToolApproval === undefined
      ? {}
      : { requireToolApproval: options.requireToolApproval }),
    ...(runtimeData ? { runtimeData } : {}),
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}

export async function streamMastraToolApprovalAction(
  action: AssistantToolApprovalAction,
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  assertNoUnsupportedDirectStreamOptions(options);
  if (!options.storage) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Mastra workflow storage is required to resume tool approval.',
    });
  }

  const runtimeData = options.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData);
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(options, runtimeResolution);

  return createToolApprovalIteratorFromRuntime({
    action,
    runtime,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(runtimeData ? { runtimeData } : {}),
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}
