import type {
  JSONObject,
  SharedV2ProviderOptions,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type { RuntimeData as ContractRuntimeData } from '@brainstrike/assistant-contract';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import type { AgentMemoryOption, ToolsInput } from '@mastra/core/agent';
import type { McpConfig } from './mcp/config';
import type { RuntimeAssistantMemorySettings } from './memory-settings';
import type { LocalLlmHostClient } from './providers/local/llm-host-client';
import type { AssistantRunEvent } from './run-events';

// The 7 supporting types below are byte-identical and dependency-free in both
// @brainstrike/agent and @brainstrike/assistant-contract; the dependency-light
// contract package owns them, agent re-exports for public-API stability.
export type {
  RuntimeAgentLoopSettings,
  RuntimeModelSettings,
  RuntimeWorkspaceContextFileMetadata,
  RuntimeWorkspaceContextMetadata,
  RuntimeWorkspaceContextRangeMetadata,
  RuntimeWorkspaceIndexQueueProgress,
  RuntimeWorkspaceIndexStatusState,
  RuntimeWorkspaceRoot,
} from '@brainstrike/assistant-contract';

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

/**
 * Agent runtime data. Extends the dependency-light `assistant-contract`
 * `RuntimeData` (the canonical wire/UI contract) and overrides only the two
 * fields that bind to runtime libraries, plus three server-only fields. The 28
 * shared fields — including `provider` (which now inherits `'local'`) — live in
 * the contract; this is what removes the old "keep the two declarations in sync"
 * drift hazard.
 */
export interface RuntimeData extends Omit<ContractRuntimeData, 'memory' | 'providerOptions'> {
  /**
   * Host-injected client that proxies built-in local LLM inference to its
   * renderer host (desktop main → hidden llm-host window). Server-side only,
   * never serialized over IPC/HTTP. Agent-only.
   */
  localLlmHostClient?: LocalLlmHostClient;
  /** Mastra agent tools registry. Agent-only. */
  mastraTools?: ToolsInput;
  /** MCP server configuration. Agent-only. */
  mcpConfig?: McpConfig;
  /**
   * Mastra memory context. Agent keeps the Mastra-bound `memoryOptions`
   * (`AgentMemoryOption['options']`) — it intentionally diverges from the
   * contract's dependency-free mirror, so the contract package stays free of the
   * Mastra dependency. Do NOT move this to assistant-contract.
   */
  memory?: RuntimeMemoryContext;
  /**
   * Provider-specific runtime options. Agent keeps the AI-SDK-bound shape
   * (`@ai-sdk/provider` SharedV2/V3ProviderOptions) — diverges from the
   * contract's dependency-free mirror for the same dependency-isolation reason.
   * Do NOT move this to assistant-contract.
   */
  providerOptions?: RuntimeProviderOptions;
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
export interface StreamChunkToolApprovalRequired extends AssistantToolApprovalRequest {
  type: 'tool-approval-required';
}
export interface StreamChunkFinish {
  type: 'finish';
  usage: { promptTokens: number; completionTokens: number };
}

export type StreamFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown';

export interface StreamChunkMessageFinish {
  finishReason: StreamFinishReason;
  path: readonly number[];
  type: 'message-finish';
  usage: { promptTokens: number; completionTokens: number };
}
export type StreamChunk =
  | StreamChunkReasoning
  | StreamChunkRunEvent
  | StreamChunkText
  | StreamChunkTool
  | StreamChunkToolApprovalRequired
  | StreamChunkFinish
  | StreamChunkMessageFinish;

export type StreamIterator = AsyncIterable<StreamChunk>;
