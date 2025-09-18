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

export interface AssistantUiMessage {
  id?: unknown;
  role?: unknown;
  text?: unknown;
  content?: unknown;
  parts?: unknown;
}

type NormalizedRole = 'user' | 'assistant' | 'system';

function normalizeRole(role: unknown, fallback?: NormalizedRole): NormalizedRole | undefined {
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

function ensureMessageId(value: unknown): string {
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
  const seenObjects = new Set<unknown>();

  const toText = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    return undefined;
  };

  const push = (value: unknown) => {
    const raw = toText(value);
    if (!raw) return;
    const text = raw.trim();
    if (text.length === 0) return;
    if (seenValues.has(text)) return;
    seenValues.add(text);
    segments.push(text);
  };

  const walk = (value: unknown): void => {
    if (value == null) return;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object') {
      if (seenObjects.has(value)) return;
      seenObjects.add(value);
      const record = value as Record<string, unknown>;
      push(record['text']);
      push(record['value']);
      walk(record['content']);
      walk(record['parts']);
      walk(record['children']);
      walk(record['values']);
      walk(record['result']);
      walk(record['message']);
      walk(record['messages']);
    }
  };

  push(source.text);
  walk(source.content);
  walk(source.parts);

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
