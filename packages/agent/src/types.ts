import type {
  JSONObject,
  SharedV2ProviderOptions,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type { AgentMemoryOption, ToolsInput } from '@mastra/core/agent';
import type { McpConfig } from './mcp/config';
import type { RuntimeAssistantMemorySettings } from './memory-settings';
import type { AssistantRunEvent } from './run-events';

export interface AgentMessagePartText {
  text: string;
  type: 'text';
}
export interface AgentMessagePartTool {
  errorText?: string;
  input?: unknown;
  output?: unknown;
  state: 'input-available' | 'input-streaming' | 'output-available' | 'output-error';
  type: `tool-${string}`;
}
export type AgentMessagePart = AgentMessagePartText | AgentMessagePartTool;

export interface AgentMessage {
  id: string;
  parts: AgentMessagePart[];
  role: 'user' | 'assistant' | 'system';
}

export type AssistantUiScalar = string | number | bigint | boolean | null;

export interface AssistantUiNodeObject {
  children?: AssistantUiNode;
  content?: AssistantUiNode;
  message?: AssistantUiNode;
  messages?: AssistantUiNode;
  parts?: AssistantUiNode;
  result?: AssistantUiNode;
  text?: AssistantUiScalar;
  value?: AssistantUiScalar;
  values?: AssistantUiNode;
  [key: string]: AssistantUiScalar | AssistantUiNode | undefined;
}

export type AssistantUiNode =
  | AssistantUiScalar
  | AssistantUiNodeObject
  | readonly AssistantUiNode[];

// Recommended stricter message shape for first-party API boundaries.
export interface AssistantUiMessageStrict {
  id?: string | undefined;
  role?: 'user' | 'assistant' | 'system' | undefined;
  text?: string | undefined;
}

// Assistant UI input message (intentionally permissive; normalized at runtime)
export interface AssistantUiMessage {
  content?: AssistantUiNode;
  id?: string | number | null;
  parts?: AssistantUiNode;
  role?: string | null;
  text?: AssistantUiScalar | undefined;
}

export interface RuntimeData {
  /** API key for the specified provider. Falls back to environment variables if not provided. */
  apiKey?: string;
  // Optional tool dispatcher provided by host (desktop main via IPC)
  callTool?: (
    name: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown) => void }
  ) => Promise<unknown>;
  /** Approximate context token count from the UI token counter. */
  contextTokenCount?: number;
  /** Active embedding set ID for retrieval tools. */
  embeddingSetId?: string;
  /** Include a selected-file report block in assistant context. */
  includeFileReport?: boolean;
  /** Include a workspace tree block in assistant context. */
  includeProjectTree?: boolean;
  mastraTools?: ToolsInput;
  mcpConfig?: McpConfig;
  mcpEnabled?: boolean;
  /** Mastra memory context for durable thread/resource-scoped conversation state. */
  memory?: RuntimeMemoryContext;
  /** Model name to use. Uses provider-specific default if not specified. */
  model?: string;
  /** Optional model-level settings (e.g., max output tokens). */
  modelSettings?: RuntimeModelSettings;
  projectId?: string;
  /** AI provider to use. Defaults to 'openai' if not specified. */
  provider?: 'openai' | 'anthropic' | 'google' | 'openrouter' | string;
  /** Optional provider-specific runtime options. */
  providerOptions?: RuntimeProviderOptions;
  /** Optional selection file paths (relative to project root). */
  selectionFilePaths?: readonly string[];
  /** Optional folder id for selection/token cache resolution. */
  selectionFolderId?: string;
  /** Optional selection snapshot id to scope retrieval. */
  selectionSnapshotId?: string;
  signal?: AbortSignal;
  /** Optional token budget override for context packing. */
  tokenBudget?: number;
  /** Optional absolute workspace root path for workspace read tools. */
  workspaceRootPath?: string;
}

export interface RuntimeMemoryContext {
  memoryOptions?: AgentMemoryOption['options'];
  memorySettings?: RuntimeAssistantMemorySettings;
  resourceId: string;
  runId?: string;
  threadId: string;
}

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'detailed';

export interface OpenAiProviderOptions extends JSONObject {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
}

export type AnthropicEffort = 'low' | 'medium' | 'high';

export interface AnthropicProviderOptions extends JSONObject {
  effort?: AnthropicEffort;
  thinking?: { type: 'enabled'; budgetTokens: number };
}

export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface GoogleProviderOptions extends JSONObject {
  thinkingConfig?: {
    thinkingLevel?: GoogleThinkingLevel;
    thinkingBudget?: number;
    includeThoughts?: boolean;
  };
}

export interface LocalProviderOptions extends JSONObject {
  thinking?: {
    enabled?: boolean;
  };
}

/**
 * Per-request transport config for a local runtime (Ollama or LM Studio).
 * `baseUrl` points the factory at a non-default host (e.g. a LAN GPU box) and
 * `apiToken` is sent as `Authorization: Bearer <token>` — used for Ollama
 * Turbo/Cloud and for LM Studio 0.4.0+ servers that opted into token auth.
 */
export interface LocalRuntimeProviderOptions extends JSONObject {
  apiToken?: string;
  baseUrl?: string;
}

export interface RuntimeModelSettings {
  maxOutputTokens?: number;
}

export type RuntimeProviderOptions = (SharedV2ProviderOptions | SharedV3ProviderOptions) & {
  openai?: OpenAiProviderOptions & JSONObject;
  anthropic?: AnthropicProviderOptions & JSONObject;
  google?: GoogleProviderOptions & JSONObject;
  local?: LocalProviderOptions & JSONObject;
  ollama?: LocalRuntimeProviderOptions & JSONObject;
  lmstudio?: LocalRuntimeProviderOptions & JSONObject;
};

export interface StreamChunkText {
  type: 'text-delta';
  value: string;
}
export interface StreamChunkReasoning {
  type: 'reasoning-delta';
  value: string;
}
export interface StreamChunkRunEvent {
  event: AssistantRunEvent;
  type: 'run-event';
}
export interface StreamChunkTool {
  name: string;
  payload?: unknown;
  status: 'start' | 'progress' | 'success' | 'error';
  type: 'tool-event';
}
export interface StreamChunkFinish {
  type: 'finish';
  usage: { promptTokens: number; completionTokens: number };
}
export interface StreamChunkMessageFinish {
  finishReason: 'stop';
  path: readonly number[];
  type: 'message-finish';
  usage: { promptTokens: number; completionTokens: number };
}
export type StreamChunk =
  | StreamChunkReasoning
  | StreamChunkRunEvent
  | StreamChunkText
  | StreamChunkTool
  | StreamChunkFinish
  | StreamChunkMessageFinish;

export type StreamIterator = AsyncIterable<StreamChunk>;
