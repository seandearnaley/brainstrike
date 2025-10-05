import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createLogger } from '@brainstrike/utils';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { MCPClient, type MCPClientOptions } from '@mastra/mcp';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type { AgentMessage, RuntimeData, StreamChunk, StreamIterator } from '../index';
import type { McpConfig } from '../mcp/config';
import { createProvider, getDefaultModel } from '../providers/provider-factory';
import { readableStreamIterator } from '../stream/readable-stream-iterator';
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
  model?: string;
  runtime?: RuntimeData;
  mcpConfig?: McpConfig;
  tools?: ToolsInput;
  // Optional timeout (ms) for initial MCP tool discovery
  mcpTimeoutMs?: number;
  resolved?: ResolvedRuntimeConfiguration;
}

export interface MastraAgentRuntime {
  agent: Agent;
  mcpClient?: MCPClient;
  dispose: () => Promise<void>;
  toolNameMap: Map<string, string>;
}

const logger = createLogger('MastraAgent');

function toMastraServerMap(config: McpConfig | undefined): MCPClientOptions['servers'] {
  if (!config || !Array.isArray(config.servers)) return {};

  const map: Record<string, MCPClientOptions['servers'][string]> = {};

  const buildStdio = (
    command: string,
    args?: string[] | undefined,
    env?: Record<string, string> | undefined
  ): { command: string; args?: string[]; env?: Record<string, string> } => {
    const entry: { command: string; args?: string[]; env?: Record<string, string> } = { command };
    if (Array.isArray(args) && args.length > 0) entry.args = args;
    if (env && Object.keys(env).length > 0) entry.env = env;
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
      return undefined;
    }
  };

  for (const server of config.servers) {
    if (!server?.name) continue;
    if (server.transport === 'stdio') {
      map[server.name] = buildStdio(server.command, server.args, server.env);
      continue;
    }
    if (server.transport === 'sse') {
      const entry = buildSse(server.url, server.headers);
      if (entry) map[server.name] = entry;
    }
  }

  return map;
}

export function convertMessagesToMastra(
  messages: AgentMessage[]
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return messages
    .map((message) => {
      const textParts = message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text.trim())
        .filter((text) => text.length > 0);

      if (textParts.length === 0) {
        return null;
      }

      return {
        role: message.role,
        content: textParts.join('\n\n'),
      };
    })
    .filter((value): value is { role: 'user' | 'assistant' | 'system'; content: string } =>
      Boolean(value)
    );
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
  const mcpClient = hasServers ? new MCPClient({ servers }) : undefined;

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
  const languageModel = createProvider(normalizedProvider, apiKey, modelName);

  const agent = new Agent({
    name: 'Brainstrike Assistant',
    instructions:
      instructions ??
      `You are a helpful assistant for the Brainstrike IDE.
When the user asks to search documentation, call the web.searchDocs tool to find relevant entries.
When the user requests a documentation summary, call the web.docSummary tool with the matching doc id.
For echo requests, use the web.echo tool.
Provide concise answers after using tools.`,
    model: languageModel,
    tools: combinedTools,
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

type UsageLike = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
};

function makeFinishChunk(part: unknown): StreamChunk {
  const usageCandidates: Array<UsageLike | undefined> = [
    (part as { usage?: UsageLike }).usage,
    (part as { payload?: { output?: { usage?: UsageLike } } }).payload?.output?.usage,
    (part as { payload?: { metadata?: { usage?: UsageLike } } }).payload?.metadata?.usage,
  ];
  const usage = usageCandidates.find((candidate) => candidate !== undefined) ?? {};
  const promptTokensRaw = usage.promptTokens ?? usage.inputTokens;
  const promptTokens = Number.isFinite(promptTokensRaw) ? (promptTokensRaw as number) : 0;
  const completionTokens = Number.isFinite(usage.completionTokens)
    ? (usage.completionTokens as number)
    : 0;
  return {
    type: 'message-finish',
    finishReason: 'stop',
    usage: { promptTokens, completionTokens },
    path: [],
  } as StreamChunk;
}

function getDeltaText(part: unknown): string {
  const candidate = part as {
    text?: string;
    textDelta?: string;
    delta?: string;
    payload?: { text?: string; textDelta?: string; delta?: string };
  };
  const payloadText =
    candidate.payload?.text ?? candidate.payload?.textDelta ?? candidate.payload?.delta;
  return candidate.text ?? candidate.textDelta ?? candidate.delta ?? payloadText ?? '';
}

function readTripwireReason(part: unknown): string | undefined {
  const candidate = part as { tripwireReason?: string; payload?: { tripwireReason?: string } };
  return candidate.tripwireReason ?? candidate.payload?.tripwireReason;
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
  const partType = (part as { type: string }).type;

  switch (partType) {
    case 'text-delta': {
      const delta = getDeltaText(part);
      return delta.length > 0
        ? { chunks: [{ type: 'text-delta', value: delta } as StreamChunk], finished: false }
        : { chunks: [], finished: false };
    }
    case 'finish': {
      return { chunks: [makeFinishChunk(part)], finished: true };
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
      const payloadCandidate = part as {
        error?: unknown;
        payload?: { error?: unknown };
      };
      return {
        chunks: [
          {
            type: 'tool-event',
            name: 'agent',
            status: 'error',
            payload: {
              error:
                payloadCandidate.error ?? payloadCandidate.payload?.error ?? 'agent_stream_error',
            },
          } as StreamChunk,
        ],
        finished: false,
      };
    }
    case 'tripwire': {
      const reason = readTripwireReason(part);
      return {
        chunks: [
          {
            type: 'tool-event',
            name: 'agent',
            status: 'error',
            payload: { error: reason ?? 'tripwire' },
          } as StreamChunk,
          makeFinishChunk(part),
        ],
        finished: true,
      };
    }
    default:
      return { chunks: [], finished: false };
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
    logger.info('mastra runtime initialized', {
      code: 'mastra_agent_runtime_initialized',
      toolCount: Object.keys(options.tools ?? {}).length,
    });
    return { runtime: instance, sanitizedNameMap: instance.toolNameMap };
  } catch (err) {
    logger.error('mastra runtime init failed', {
      code: 'mastra_agent_runtime_init_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    const errorDetail = err instanceof Error ? err.message : undefined;
    throw createMastraAgentError(
      'mastra_agent_runtime_init_failed',
      errorDetail ? { cause: err, detail: errorDetail } : { cause: err }
    );
  }
}

interface StreamIterationParams {
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  messages: AgentMessage[];
  sanitizedNameMap?: Map<string, string>;
}

interface StreamGeneratorParams {
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  stream: NodeReadableStream<unknown> | ReadableStream<unknown>;
  sanitizedNameMap?: Map<string, string>;
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
  sanitizedNameMap,
}: StreamIterationParams): Promise<StreamIterator> {
  const mastraMessages = convertMessagesToMastra(messages);

  try {
    const streamInput = mastraMessages as unknown as Parameters<
      typeof runtime.agent.streamVNext
    >[0];
    const streamOptions = runtimeData?.signal ? { abortSignal: runtimeData.signal } : undefined;
    const result = await runtime.agent.streamVNext(streamInput, streamOptions);
    logger.info('mastra stream started', { code: 'mastra_agent_stream_started' });

    const stream = result.fullStream;
    if (!stream) {
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: 'empty_stream',
      });
    }
    return streamChunksFromMastra({
      runtime,
      stream,
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
    ...(runtimeData ? { runtimeData } : {}),
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}
