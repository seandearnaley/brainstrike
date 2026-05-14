import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createLogger, generateUUID } from '@brainstrike/utils';
import { Agent, type AgentMemoryOption, type ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { MastraMemory } from '@mastra/core/memory';
import { TokenLimiter } from '@mastra/core/processors';
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
import { createMastraAgentError, isMastraAgentError } from './mastra-agent-error';
import { collectCombinedTools } from './mcp-tool-loader';
import {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './runtime-configuration';
import { mapMastraToolEvent } from './tool-event-mapper';
import { sanitizeTools } from './tool-sanitizer';

export interface MastraAgentRuntimeOptions {
  instructions?: string;
  mcpConfig?: McpConfig;
  // Optional timeout (ms) for initial MCP tool discovery
  mcpTimeoutMs?: number;
  memory?: MastraMemory;
  model?: string;
  resolved?: ResolvedRuntimeConfiguration;
  runtime?: RuntimeData;
  tools?: ToolsInput;
}

export interface MastraAgentRuntime {
  agent: Agent;
  dispose: () => Promise<void>;
  mcpClient?: MCPClient;
  toolNameMap: Map<string, string>;
}

const logger = createLogger('MastraAgent');

const BRAINSTRIKE_CONTEXT_TOOL_IDS = {
  listWorkspaceContext: 'brainstrike.listWorkspaceContext',
  readWorkspaceContext: 'brainstrike.readWorkspaceContext',
  readWorkspaceFile: 'brainstrike.readWorkspaceFile',
  listEmbeddingSpaces: 'brainstrike.listEmbeddingSpaces',
  queryEmbeddingSpace: 'brainstrike.queryEmbeddingSpace',
  updateWorkspaceContextSelection: 'brainstrike.updateWorkspaceContextSelection',
  updateWorkspaceTapestrySelections: 'brainstrike.updateWorkspaceTapestrySelections',
} as const;

function buildOriginalToModelFacingToolNameMap(
  toolNameMap: ReadonlyMap<string, string>
): Map<string, string> {
  const originalToModelFacing = new Map<string, string>();
  for (const [modelFacingName, originalName] of toolNameMap.entries()) {
    originalToModelFacing.set(originalName, modelFacingName);
  }
  return originalToModelFacing;
}

function resolveModelFacingToolName(
  originalToModelFacingToolNameMap: ReadonlyMap<string, string>,
  originalToolId: string
): string {
  return originalToModelFacingToolNameMap.get(originalToolId) ?? originalToolId;
}

function getModelFacingToolNames(toolNameMap: ReadonlyMap<string, string>): {
  listWorkspaceContext: string;
  readWorkspaceContext: string;
  readWorkspaceFile: string;
  listEmbeddingSpaces: string;
  queryEmbeddingSpace: string;
  updateWorkspaceContextSelection: string;
  updateWorkspaceTapestrySelections: string;
} {
  const originalToModelFacing = buildOriginalToModelFacingToolNameMap(toolNameMap);
  return {
    listWorkspaceContext: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.listWorkspaceContext
    ),
    readWorkspaceContext: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.readWorkspaceContext
    ),
    readWorkspaceFile: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.readWorkspaceFile
    ),
    listEmbeddingSpaces: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.listEmbeddingSpaces
    ),
    queryEmbeddingSpace: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.queryEmbeddingSpace
    ),
    updateWorkspaceContextSelection: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.updateWorkspaceContextSelection
    ),
    updateWorkspaceTapestrySelections: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.updateWorkspaceTapestrySelections
    ),
  };
}

function buildDefaultInstructions(toolNameMap: ReadonlyMap<string, string>): string {
  const names = getModelFacingToolNames(toolNameMap);

  return `You are a helpful assistant for the Brainstrike IDE.
Use tools when they help you answer accurately.
Project files, context explorer selections, file trees, token estimates, and embedding spaces are not preloaded into your prompt.
When project or codebase context is needed, use Brainstrike native tools explicitly. First inspect available selected context, token budgets, Tapestry ranges, project-tree token counts, and the workspace index hint with ${names.listWorkspaceContext}. For broad codebase questions, call ${names.listEmbeddingSpaces} and prefer the space marked recommendedForWorkspaceSearch because it is the workspace index; then pass that explicit embeddingSetId to ${names.queryEmbeddingSpace}. Use ${names.readWorkspaceContext} or ${names.readWorkspaceFile} afterward when you need surrounding file contents beyond the retrieved source line ranges.
When the user asks you to curate ideal reusable context, use ${names.queryEmbeddingSpace} to find candidate files and semantic chunks with persisted source line ranges, then call ${names.updateWorkspaceContextSelection} to bulk select files and ${names.updateWorkspaceTapestrySelections} to keep only relevant line ranges. Read files when surrounding lines are needed to refine the ranges. Keep the curation token-aware and prefer Tapestry ranges over whole files when a whole file would waste context.
Do not assume selected files or embedding spaces are already included. Keep file and retrieval budgets small, and report skipped or truncated tool results when they affect the answer.
If an expected Brainstrike native tool is unavailable, say exactly which tool ID is missing and continue with another available tool only when that still answers the user.
If the user asks what tools you have available, list the tool IDs you can call in this session and briefly describe each one.
Only run state-changing tools after the user confirms.
Provide concise answers after using tools.`;
}

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

  return {
    agent,
    dispose: async () => {
      await mcpClient?.disconnect();
    },
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

  throw createMastraAgentError('mastra_agent_unsupported_model_runtime', {
    detail: `AI SDK v1 model runtime is not supported for Brainstrike chat streaming: ${provider}/${model}`,
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
  return 'stop';
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

interface BrainstrikeAgentStreamOptions {
  abortSignal?: AbortSignal;
  inputProcessors?: unknown[];
  maxSteps?: number;
  memory?: AgentMemoryOption;
  modelSettings?: RuntimeData['modelSettings'];
  providerOptions?: RuntimeData['providerOptions'];
  stopWhen?: unknown[];
}

const DEFAULT_AGENT_MAX_STEPS = 20;

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
): Pick<BrainstrikeAgentStreamOptions, 'inputProcessors' | 'maxSteps' | 'stopWhen'> {
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
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: 'Mastra stream ended without a finish event',
      });
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
  const runtimeData = options.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData);
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(options, runtimeResolution);

  return createStreamIteratorFromRuntime({
    runtime,
    messages,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(runtimeData ? { runtimeData } : {}),
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}
