import type { ToolsInput } from '@mastra/core/agent';
import type { MastraAgentRuntimeOptions } from './mastra/agent-runtime';
import { streamMastraAgent } from './mastra/agent-runtime';
import type { McpConfig } from './mcp/config';

export interface AgentMessagePartText {
  type: 'text';
  text: string;
}
export interface AgentMessagePartTool {
  type: `tool-${string}`;
  state: 'input-available' | 'input-streaming' | 'output-available' | 'output-error';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}
export type AgentMessagePart = AgentMessagePartText | AgentMessagePartTool;

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: AgentMessagePart[];
}

export type AssistantUiScalar = string | number | bigint | boolean | null;

export interface AssistantUiNodeObject {
  text?: AssistantUiScalar;
  value?: AssistantUiScalar;
  content?: AssistantUiNode;
  parts?: AssistantUiNode;
  children?: AssistantUiNode;
  values?: AssistantUiNode;
  result?: AssistantUiNode;
  message?: AssistantUiNode;
  messages?: AssistantUiNode;
  [key: string]: AssistantUiScalar | AssistantUiNode | undefined;
}

export type AssistantUiNode =
  | AssistantUiScalar
  | AssistantUiNodeObject
  | ReadonlyArray<AssistantUiNode>;

export interface AssistantUiMessage {
  id?: string | number | null;
  role?: string | null;
  text?: AssistantUiScalar | undefined;
  content?: AssistantUiNode;
  parts?: AssistantUiNode;
}

type NormalizedRole = 'user' | 'assistant' | 'system';

function normalizeRole(
  role: AssistantUiMessage['role'],
  fallback?: NormalizedRole
): NormalizedRole | undefined {
  if (typeof role === 'string') {
    const lower = role.toLowerCase();
    if (lower === 'user' || lower === 'assistant' || lower === 'system') {
      return lower;
    }
  }
  return fallback;
}

function randomMessageId(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `msg_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureMessageId(value: AssistantUiMessage['id']): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return randomMessageId();
}

function extractTextSegments(source: AssistantUiMessage): string[] {
  const segments: string[] = [];
  const seenValues = new Set<string>();
  const seenObjects = new Set<AssistantUiNodeObject>();

  const pushText = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0 || seenValues.has(text)) {
      return;
    }
    seenValues.add(text);
    segments.push(text);
  };

  const knownObjectKeys: ReadonlySet<string> = new Set([
    'text',
    'value',
    'content',
    'parts',
    'children',
    'values',
    'result',
    'message',
    'messages',
  ]);

  const pushScalar = (value: AssistantUiScalar | undefined) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      pushText(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      pushText(String(value));
      return;
    }
    if (typeof value === 'boolean') {
      pushText(value ? 'true' : 'false');
    }
  };

  const isScalarValue = (value: AssistantUiNode | undefined): value is AssistantUiScalar => {
    return (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean'
    );
  };

  const visitArray = (nodes: ReadonlyArray<AssistantUiNode>): void => {
    for (const item of nodes) {
      visit(item);
    }
  };

  const visitObject = (record: AssistantUiNodeObject): void => {
    if (seenObjects.has(record)) {
      return;
    }
    seenObjects.add(record);

    pushScalar(record.text);
    pushScalar(record.value);

    visit(record.content);
    visit(record.parts);
    visit(record.children);
    visit(record.values);
    visit(record.result);
    visit(record.message);
    visit(record.messages);

    for (const [key, nested] of Object.entries(record)) {
      if (knownObjectKeys.has(key)) continue;
      if (isScalarValue(nested as AssistantUiNode | undefined)) {
        pushScalar(nested as AssistantUiScalar | undefined);
      } else {
        visit(nested as AssistantUiNode);
      }
    }
  };

  const visit = (value: AssistantUiNode | undefined): void => {
    if (value == null) return;
    if (isScalarValue(value)) {
      pushScalar(value);
      return;
    }
    if (Array.isArray(value)) {
      visitArray(value);
      return;
    }
    visitObject(value as AssistantUiNodeObject);
  };

  pushScalar(source.text);
  visit(source.content);
  visit(source.parts);

  return segments;
}

function toAgentMessage(
  message: AssistantUiMessage | null | undefined,
  fallbackRole?: NormalizedRole
): AgentMessage | null {
  if (!message) return null;
  const segments = extractTextSegments(message);
  if (segments.length === 0) return null;
  const role = normalizeRole(message.role, fallbackRole);
  if (!role) return null;
  return {
    id: ensureMessageId(message.id),
    role,
    parts: segments.map((text) => ({ type: 'text', text }) satisfies AgentMessagePartText),
  } satisfies AgentMessage;
}

export function convertAssistantUiMessages(
  messages: ReadonlyArray<AssistantUiMessage | null | undefined>
): AgentMessage[] {
  const converted: AgentMessage[] = [];
  for (const message of messages) {
    const agentMessage = toAgentMessage(message);
    if (agentMessage) {
      converted.push(agentMessage);
    }
  }
  if (converted.length > 0) {
    return converted;
  }
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const fallback = toAgentMessage(last ?? null, 'user');
  return fallback ? [fallback] : [];
}

export interface RuntimeData {
  projectId?: string;
  provider?: string;
  model?: string;
  mcpEnabled?: boolean;
  signal?: AbortSignal;
  // Optional tool dispatcher provided by host (desktop main via IPC)
  callTool?: (
    name: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown) => void }
  ) => Promise<unknown>;
  mcpConfig?: McpConfig;
  mastraTools?: ToolsInput;
  apiKey?: string;
}

export interface StreamChunkText {
  type: 'text-delta';
  value: string;
}
export interface StreamChunkTool {
  type: 'tool-event';
  name: string;
  status: 'start' | 'progress' | 'success' | 'error';
  payload?: unknown;
}
export interface StreamChunkFinish {
  type: 'finish';
  usage: { promptTokens: number; completionTokens: number };
}
export interface StreamChunkMessageFinish {
  type: 'message-finish';
  finishReason: 'stop';
  usage: { promptTokens: number; completionTokens: number };
  path: ReadonlyArray<number>;
}
export type StreamChunk =
  | StreamChunkText
  | StreamChunkTool
  | StreamChunkFinish
  | StreamChunkMessageFinish;

export type StreamIterator = AsyncIterable<StreamChunk>;

export {
  convertMessagesToMastra,
  createMastraAgentRuntime,
  type MastraAgentRuntime,
  type MastraAgentRuntimeOptions,
  streamMastraAgent,
} from './mastra/agent-runtime';
export { webTools } from './mastra/web-tools';
// Minimal placeholder agent: echoes user text in a streamed fashion.
// Memory store for early development
export { InMemoryMemoryStore } from './memory/in-memory';
export {
  type FilesystemListInput,
  type FilesystemReadInput,
  type FilesystemSearchInput,
  validateToolInput,
  type WebDocSummaryInput,
  type WebSearchDocsInput,
} from './tools/schemas';

// Adapter to Vercel AI SDK v5 style data stream if needed by routes
export async function toAiSdkStyleStream(
  messages: AgentMessage[],
  runtime?: RuntimeData
): Promise<StreamIterator> {
  const options: MastraAgentRuntimeOptions = {};
  if (runtime) {
    options.runtime = runtime;
  }
  if (runtime?.model) {
    options.model = runtime.model;
  }
  if (runtime?.mcpConfig) {
    options.mcpConfig = runtime.mcpConfig;
  }
  if (runtime?.mastraTools) {
    options.tools = runtime.mastraTools;
  }

  return streamMastraAgent(messages, options);
}
// MCP config types and parser (desktop-only usage typically)
export type { McpConfig, McpServer } from './mcp/config';
export { McpConfigSchema, McpServerSchema, McpTransportEnum, parseMcpConfig } from './mcp/config';
export {
  cloneJsonSafe,
  sanitizeStreamChunk,
  toJsonSafe,
} from './stream/json';
export {
  completeToolCall,
  createToolRegistry,
  recordToolProgress,
  startToolCall,
  type ToolCallControllerLike,
  type ToolRegistry,
  type ToolRegistryEntry,
} from './stream/tool-registry';
