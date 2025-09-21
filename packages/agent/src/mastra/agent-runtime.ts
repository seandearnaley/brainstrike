import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createOpenAI } from '@ai-sdk/openai';
import { createLogger } from '@brainstrike/utils';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { MCPClient, type MCPClientOptions } from '@mastra/mcp';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type { AgentMessage, RuntimeData, StreamChunk, StreamIterator } from '../index';
import type { McpConfig } from '../mcp/config';
import { mapMastraToolEvent } from './tool-event-mapper';

export interface MastraAgentRuntimeOptions {
  instructions?: string;
  model?: string;
  runtime?: RuntimeData;
  mcpConfig?: McpConfig;
  tools?: ToolsInput;
  // Optional timeout (ms) for initial MCP tool discovery
  mcpTimeoutMs?: number;
}

export interface MastraAgentRuntime {
  agent: Agent;
  mcpClient?: MCPClient;
  dispose: () => Promise<void>;
  toolNameMap: Map<string, string>;
}

const logger = createLogger('MastraAgent');

function resolveOpenAIApiKey(runtime?: RuntimeData): string | undefined {
  if (runtime?.apiKey && typeof runtime.apiKey === 'string' && runtime.apiKey.trim()) {
    return runtime.apiKey;
  }

  if (typeof process !== 'undefined') {
    const env = process.env ?? {};
    const fromEnv =
      env['OPENAI_API_KEY'] ??
      env['AI_OPENAI_API_KEY'] ??
      env['OPENAI_API_KEY_V1'] ??
      env['OPENAI_API_KEY_V2'] ??
      null;
    const trimmed = fromEnv?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function toOpenAIMode(model?: string): string {
  return model && model.length > 0 ? model : 'gpt-4o-mini';
}

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

function sanitizeTools(
  tools: ToolsInput | undefined,
  map: Map<string, string>
): ToolsInput | undefined {
  if (!tools) return undefined;

  const sanitized: ToolsInput = {};
  const usedNames = new Set<string>(map.keys());

  for (const [name, tool] of Object.entries(tools)) {
    const baseName = sanitizeToolNameBase(name);
    const uniqueName = ensureUniqueSanitizedName(baseName, name, usedNames);

    map.set(uniqueName, name);

    if (uniqueName !== name) {
      const cloned = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
      cloned.id = uniqueName;
      sanitized[uniqueName] = cloned;
    } else {
      sanitized[uniqueName] = tool;
    }
  }

  return sanitized;
}

function sanitizeToolNameBase(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized.trim().length > 0) {
    return sanitized;
  }
  return 'tool';
}

function ensureUniqueSanitizedName(
  baseName: string,
  originalName: string,
  usedNames: Set<string>
): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  const hash = createStableHashSuffix(originalName);
  let candidate = `${baseName}_${hash}`;
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }

  let counter = 1;
  while (true) {
    candidate = `${baseName}_${hash}_${counter}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    counter += 1;
  }
}

function createStableHashSuffix(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

async function* readableStreamIterator<T>(
  stream: NodeReadableStream<T> | ReadableStream<T>
): AsyncIterableIterator<T> {
  const webStream = stream as ReadableStream<T>;
  const reader = webStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function createMastraAgentRuntime(
  options: MastraAgentRuntimeOptions = {}
): Promise<MastraAgentRuntime> {
  const { runtime, instructions, model, mcpConfig, tools: localTools, mcpTimeoutMs } = options;
  const apiKey = resolveOpenAIApiKey(runtime);

  const servers = toMastraServerMap(mcpConfig);
  const hasServers = Object.keys(servers).length > 0;
  const mcpClient = hasServers ? new MCPClient({ servers }) : undefined;

  const toolNameMap = new Map<string, string>();
  const sanitizedLocalTools = sanitizeTools(localTools, toolNameMap);

  let combinedTools: ToolsInput = sanitizedLocalTools ? { ...sanitizedLocalTools } : {};
  if (mcpClient) {
    const timeoutMs = resolveMcpTimeoutMs(mcpTimeoutMs);
    const sanitizedMcpTools = await fetchMcpToolsWithTimeout(mcpClient, toolNameMap, timeoutMs);
    if (sanitizedMcpTools) {
      combinedTools = { ...combinedTools, ...sanitizedMcpTools } as ToolsInput;
    }
  }

  const openaiProvider = createOpenAI(apiKey ? { apiKey } : undefined);
  const agent = new Agent({
    name: 'Brainstrike Assistant',
    instructions:
      instructions ??
      `You are a helpful assistant for the Brainstrike IDE.
When the user asks to search documentation, call the web.searchDocs tool to find relevant entries.
When the user requests a documentation summary, call the web.docSummary tool with the matching doc id.
For echo requests, use the web.echo tool.
Provide concise answers after using tools.`,
    model: openaiProvider(toOpenAIMode(model)),
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

function resolveMcpTimeoutMs(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return 5000;
}

async function fetchMcpToolsWithTimeout(
  mcpClient: MCPClient | undefined,
  toolNameMap: Map<string, string>,
  timeoutMs: number
): Promise<ToolsInput | undefined> {
  if (!mcpClient) return undefined;
  const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
    return await new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('mcp_tool_discovery_timeout')), ms);
      p.then((v) => {
        clearTimeout(t);
        resolve(v);
      }).catch((e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  };
  try {
    const toolsFromClient = (await withTimeout(mcpClient.getTools(), timeoutMs)) as ToolsInput;
    return sanitizeTools(toolsFromClient, toolNameMap);
  } catch (err) {
    logger.warn('MCP tool discovery skipped', {
      code: 'mcp_tools_unavailable',
      reason: err instanceof Error ? err.message : String(err),
      timeoutMs,
    });
    return undefined;
  }
}

export async function streamMastraAgent(
  messages: AgentMessage[],
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  const runtimeData = options.runtime;
  const fail = (
    reason: 'missing_api_key' | 'runtime_init_failure' | 'stream_failure',
    cause?: unknown
  ): never => {
    const detail =
      cause instanceof Error && cause.message
        ? cause.message
        : cause && !(cause instanceof Error)
          ? String(cause)
          : '';
    const message = detail ? `mastra_agent_${reason}: ${detail}` : `mastra_agent_${reason}`;
    if (cause instanceof Error) {
      throw new Error(message, { cause });
    }
    throw new Error(message);
  };

  const apiKey = resolveOpenAIApiKey(runtimeData);
  if (!apiKey) {
    logger.warn('mastra agent missing api key', { code: 'mastra_agent_missing_api_key' });
    return fail('missing_api_key');
  }

  let sanitizedNameMap: Map<string, string> | undefined;
  const runtime = await (async () => {
    try {
      const instance = await createMastraAgentRuntime(options);
      logger.info('mastra runtime initialized', {
        code: 'mastra_agent_runtime_initialized',
        toolCount: Object.keys(options.tools ?? {}).length,
      });
      sanitizedNameMap = instance.toolNameMap;
      return instance;
    } catch (err) {
      logger.error('mastra runtime init failed', {
        code: 'mastra_agent_runtime_init_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return fail('runtime_init_failure', err);
    }
  })();

  const mastraMessages = convertMessagesToMastra(messages);

  try {
    const streamInput = mastraMessages as unknown as Parameters<
      typeof runtime.agent.streamVNext
    >[0];
    const result = await runtime.agent.streamVNext(streamInput);
    logger.info('mastra stream started', { code: 'mastra_agent_stream_started' });

    const stream = result.fullStream;
    if (!stream) {
      throw new Error('mastra_agent_empty_stream');
    }
    const toolNames = new Map<string, string>();

    const getDeltaText = (p: unknown): string => {
      const part = p as {
        text?: string;
        textDelta?: string;
        delta?: string;
        payload?: { text?: string; textDelta?: string; delta?: string };
      };
      const payloadText = part.payload?.text ?? part.payload?.textDelta ?? part.payload?.delta;
      return part.text ?? part.textDelta ?? part.delta ?? payloadText ?? '';
    };

    type UsageLike = {
      promptTokens?: number;
      completionTokens?: number;
      inputTokens?: number;
    };

    const makeFinishChunk = (p: unknown): StreamChunk => {
      const part = p as {
        usage?: UsageLike;
        payload?: {
          output?: { usage?: UsageLike };
          metadata?: { usage?: UsageLike };
          stepResult?: { reason?: string };
        };
      };
      const usageCandidates: Array<UsageLike | undefined> = [
        part.usage,
        part.payload?.output?.usage,
        part.payload?.metadata?.usage,
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
    };

    const readTripwireReason = (p: unknown): string | undefined => {
      const part = p as { tripwireReason?: string; payload?: { tripwireReason?: string } };
      return part.tripwireReason ?? part.payload?.tripwireReason;
    };

    const processStreamPart = function* (
      part: unknown,
      toolNames: Map<string, string>,
      sanitizedNameMap?: Map<string, string>
    ): Generator<StreamChunk, boolean> {
      const partType = (part as { type: string }).type;

      switch (partType) {
        case 'text-delta': {
          const delta = getDeltaText(part);
          if (delta.length > 0) {
            yield { type: 'text-delta', value: delta } as StreamChunk;
          }
          return false;
        }
        case 'finish': {
          yield makeFinishChunk(part);
          return true;
        }
        case 'tool-call':
        case 'tool-call-input-streaming-start':
        case 'tool-call-delta':
        case 'tool-call-input-streaming-end':
        case 'tool-result':
        case 'tool-error':
        case 'tool-output': {
          const evt = mapMastraToolEvent(part, toolNames, sanitizedNameMap);
          if (evt) yield evt;
          return false;
        }
        case 'error': {
          const payloadCandidate = part as {
            error?: unknown;
            payload?: { error?: unknown };
          };
          yield {
            type: 'tool-event',
            name: 'agent',
            status: 'error',
            payload: {
              error:
                payloadCandidate.error ?? payloadCandidate.payload?.error ?? 'agent_stream_error',
            },
          } as StreamChunk;
          return false;
        }
        case 'tripwire': {
          const reason = readTripwireReason(part);
          yield {
            type: 'tool-event',
            name: 'agent',
            status: 'error',
            payload: { error: reason ?? 'tripwire' },
          } as StreamChunk;
          yield makeFinishChunk(part);
          return true;
        }
        default:
          return false;
      }
    };

    async function* iterate(): AsyncIterableIterator<StreamChunk> {
      try {
        for await (const part of readableStreamIterator(stream)) {
          const generator = processStreamPart(part, toolNames, sanitizedNameMap);
          let result = generator.next();

          while (!result.done) {
            yield result.value;
            result = generator.next();
          }

          if (result.value) {
            return;
          }
        }
      } finally {
        logger.info('mastra stream finished', { code: 'mastra_agent_stream_finished' });
        await runtime?.dispose();
      }
    }

    return iterate();
  } catch (err) {
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
    return fail('stream_failure', err);
  }
}
