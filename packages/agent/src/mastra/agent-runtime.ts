import { createOpenAI } from '@ai-sdk/openai';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { MCPClient, type MCPClientOptions } from '@mastra/mcp';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type { AgentMessage, RuntimeData, StreamChunk, StreamIterator } from '../index';
import type { McpConfig } from '../mcp/config';

export interface MastraAgentRuntimeOptions {
  instructions?: string;
  model?: string;
  runtime?: RuntimeData;
  mcpConfig?: McpConfig;
  tools?: ToolsInput;
}

export interface MastraAgentRuntime {
  agent: Agent;
  mcpClient?: MCPClient;
  dispose: () => Promise<void>;
  toolNameMap: Map<string, string>;
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
  for (const [name, tool] of Object.entries(tools)) {
    const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    map.set(sanitizedName, name);
    if (sanitizedName !== name) {
      const cloned = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
      cloned.id = sanitizedName;
      sanitized[sanitizedName] = cloned;
    } else {
      sanitized[name] = tool;
    }
  }
  return sanitized;
}

export async function createMastraAgentRuntime(
  options: MastraAgentRuntimeOptions = {}
): Promise<MastraAgentRuntime> {
  const { runtime, instructions, model, mcpConfig, tools: localTools } = options;
  const apiKey = (runtime as unknown as { apiKey?: string })?.apiKey;

  const servers = toMastraServerMap(mcpConfig);
  const hasServers = Object.keys(servers).length > 0;
  const mcpClient = hasServers ? new MCPClient({ servers }) : undefined;

  const toolNameMap = new Map<string, string>();
  const sanitizedLocalTools = sanitizeTools(localTools, toolNameMap);

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
    tools: (sanitizedLocalTools ?? {}) as ToolsInput,
  });

  if (mcpClient) {
    const toolsFromClient = (await mcpClient.getTools()) as ToolsInput;
    const sanitizedMcpTools = sanitizeTools(toolsFromClient, toolNameMap);
    agent.__setTools({ ...(sanitizedLocalTools ?? {}), ...(sanitizedMcpTools ?? {}) });
  }

  return {
    agent,
    dispose: async () => {
      await mcpClient?.disconnect();
    },
    toolNameMap,
    ...(mcpClient ? { mcpClient } : {}),
  };
}

function mapToolEvent(
  part: { type: string } & Record<string, unknown>,
  toolNames: Map<string, string>,
  sanitizedNames?: Map<string, string>
): StreamChunk | undefined {
  switch (part.type) {
    case 'tool-call': {
      toolNames.set(
        (part as unknown as { toolCallId: string }).toolCallId,
        (part as unknown as { toolName: string }).toolName
      );
      const toolName =
        sanitizedNames?.get((part as unknown as { toolName: string }).toolName) ??
        (part as unknown as { toolName: string }).toolName;
      return {
        type: 'tool-event',
        name: toolName,
        status: 'start',
        payload: {
          callId: (part as unknown as { toolCallId: string }).toolCallId,
          input: (part as unknown as { input?: unknown }).input,
          providerExecuted: (part as unknown as { providerExecuted?: boolean }).providerExecuted,
          dynamic: (part as unknown as { dynamic?: boolean }).dynamic,
          invalid: (part as unknown as { invalid?: boolean }).invalid,
          error: (part as unknown as { error?: unknown }).error,
        },
      } as StreamChunk;
    }
    case 'tool-result': {
      const id = (part as unknown as { toolCallId: string }).toolCallId;
      const toolNameMaybe =
        (part as unknown as { toolName?: string }).toolName ?? toolNames.get(id) ?? id;
      const originalName = sanitizedNames?.get(toolNameMaybe) ?? toolNameMaybe;
      return {
        type: 'tool-event',
        name: originalName,
        status: 'success',
        payload: {
          callId: id,
          input: (part as unknown as { input?: unknown }).input,
          output: (part as unknown as { output?: unknown }).output,
          providerExecuted: (part as unknown as { providerExecuted?: boolean }).providerExecuted,
          dynamic: (part as unknown as { dynamic?: boolean }).dynamic,
          preliminary: (part as unknown as { preliminary?: boolean }).preliminary,
        },
      } as StreamChunk;
    }
    case 'tool-error': {
      const id = (part as unknown as { toolCallId: string }).toolCallId;
      const toolNameMaybe =
        (part as unknown as { toolName?: string }).toolName ?? toolNames.get(id) ?? id;
      const originalName = sanitizedNames?.get(toolNameMaybe) ?? toolNameMaybe;
      return {
        type: 'tool-event',
        name: originalName,
        status: 'error',
        payload: {
          callId: id,
          input: (part as unknown as { input?: unknown }).input,
          error: (part as unknown as { error?: unknown }).error,
          providerExecuted: (part as unknown as { providerExecuted?: boolean }).providerExecuted,
          dynamic: (part as unknown as { dynamic?: boolean }).dynamic,
        },
      } as StreamChunk;
    }
    default:
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

  const apiKey = (runtimeData as RuntimeData | undefined)?.apiKey;
  if (!apiKey) {
    console.error('[MastraAgent] missing api key; aborting stream');
    return fail('missing_api_key');
  }

  let sanitizedNameMap: Map<string, string> | undefined;
  const runtime = await (async () => {
    try {
      const instance = await createMastraAgentRuntime(options);
      console.info(
        '[MastraAgent] runtime initialized with tools:',
        Object.keys(options.tools ?? {})
      );
      sanitizedNameMap = instance.toolNameMap;
      return instance;
    } catch (err) {
      console.error('[MastraAgent] failed to initialize runtime', err);
      return fail('runtime_init_failure', err);
    }
  })();

  const mastraMessages = convertMessagesToMastra(messages);

  try {
    const result = await runtime.agent.stream(mastraMessages);
    console.info('[MastraAgent] stream started');

    const stream = result.fullStream;
    const toolNames = new Map<string, string>();

    const getDeltaText = (p: unknown): string => {
      const part = p as { text?: string; textDelta?: string; delta?: string };
      return part.text ?? part.textDelta ?? part.delta ?? '';
    };

    const makeFinishChunk = (p: unknown): StreamChunk => {
      const part = p as { usage?: { promptTokens?: number; completionTokens?: number } };
      const promptTokens = Number.isFinite(part.usage?.promptTokens)
        ? (part.usage?.promptTokens as number)
        : 0;
      const completionTokens = Number.isFinite(part.usage?.completionTokens)
        ? (part.usage?.completionTokens as number)
        : 0;
      return {
        type: 'message-finish',
        finishReason: 'stop',
        usage: { promptTokens, completionTokens },
        path: [],
      } as StreamChunk;
    };

    async function* iterate(): AsyncIterableIterator<StreamChunk> {
      try {
        for await (const part of stream as AsyncIterable<unknown>) {
          switch ((part as { type: string }).type) {
            case 'text-delta': {
              const delta = getDeltaText(part);
              if (delta.length > 0) yield { type: 'text-delta', value: delta } as StreamChunk;
              break;
            }
            case 'finish': {
              yield makeFinishChunk(part);
              return;
            }
            case 'tool-call':
            case 'tool-result':
            case 'tool-error': {
              const evt = mapToolEvent(
                part as { type: string } & Record<string, unknown>,
                toolNames,
                sanitizedNameMap
              );
              if (evt) yield evt;
              break;
            }
            case 'error': {
              const p = part as { error: unknown };
              yield {
                type: 'tool-event',
                name: 'agent',
                status: 'error',
                payload: { error: p.error },
              } as StreamChunk;
              break;
            }
            default:
              // ignore other parts
              break;
          }
        }
      } finally {
        console.info('[MastraAgent] stream finished');
        await runtime?.dispose();
      }
    }

    return iterate();
  } catch (err) {
    console.error('[MastraAgent] streaming failed', err);
    try {
      await runtime.dispose();
    } catch (disposeError) {
      console.error('[MastraAgent] failed to dispose runtime after stream failure', disposeError);
    }
    return fail('stream_failure', err);
  }
}
