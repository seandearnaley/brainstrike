import type {
  JSONObject,
  SharedV2ProviderOptions,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type { ToolsInput } from '@mastra/core/agent';
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
  | readonly AssistantUiNode[];

// Recommended stricter message shape for first-party API boundaries.
export interface AssistantUiMessageStrict {
  id?: string | undefined;
  role?: 'user' | 'assistant' | 'system' | undefined;
  text?: string | undefined;
}

// Assistant UI input message (intentionally permissive; normalized at runtime)
export interface AssistantUiMessage {
  id?: string | number | null;
  role?: string | null;
  text?: AssistantUiScalar | undefined;
  content?: AssistantUiNode;
  parts?: AssistantUiNode;
}

export interface RuntimeData {
  projectId?: string;
  /** AI provider to use. Defaults to 'openai' if not specified. */
  provider?: 'openai' | 'anthropic' | 'google' | 'openrouter' | string;
  /** Model name to use. Uses provider-specific default if not specified. */
  model?: string;
  /** Active embedding set ID for retrieval tools. */
  embeddingSetId?: string;
  /** Optional selection file paths (relative to project root). */
  selectionFilePaths?: readonly string[];
  /** Optional selection snapshot id to scope retrieval. */
  selectionSnapshotId?: string;
  /** Optional folder id for selection/token cache resolution. */
  selectionFolderId?: string;
  /** Optional absolute workspace root path for workspace read tools. */
  workspaceRootPath?: string;
  /** Optional token budget override for context packing. */
  tokenBudget?: number;
  /** Include a selected-file report block in assistant context. */
  includeFileReport?: boolean;
  /** Include a workspace tree block in assistant context. */
  includeProjectTree?: boolean;
  /** Approximate context token count from the UI token counter. */
  contextTokenCount?: number;
  /** Optional model-level settings (e.g., max output tokens). */
  modelSettings?: RuntimeModelSettings;
  /** Optional provider-specific runtime options. */
  providerOptions?: RuntimeProviderOptions;
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
  /** API key for the specified provider. Falls back to environment variables if not provided. */
  apiKey?: string;
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

export interface RuntimeModelSettings {
  maxOutputTokens?: number;
}

export type RuntimeProviderOptions = (SharedV2ProviderOptions | SharedV3ProviderOptions) & {
  openai?: OpenAiProviderOptions & JSONObject;
  anthropic?: AnthropicProviderOptions & JSONObject;
  google?: GoogleProviderOptions & JSONObject;
};

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
  path: readonly number[];
}
export type StreamChunk =
  | StreamChunkText
  | StreamChunkTool
  | StreamChunkFinish
  | StreamChunkMessageFinish;

export type StreamIterator = AsyncIterable<StreamChunk>;
