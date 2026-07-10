import type {
  JSONObject,
  SharedV2ProviderOptions,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type { RuntimeData as ContractRuntimeData } from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import type { AssistantToolSuspendRequest } from '@brainstrike/assistant-contract/tool-suspend';
import type { AgentMemoryOption, ToolsInput } from '@mastra/core/agent';
import type { AssistantPermissionPolicyRequest } from './mastra/permission-policy-request';
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
   * Serializable permission posture + caller-provided tool risk classification.
   * When present, the runtime gates the agent's tool map by the policy BEFORE
   * the immutable Mastra `Agent` is built (`filterToolsByPermissionWithMetadata`):
   * `'allow'` keeps a tool, `'deny'` omits it, and `'ask'` keeps a CLONE carrying
   * Mastra's PER-TOOL `requireApproval: true` so the run SUSPENDS for approval
   * only when that tool is called (allowed tools run free; the run-wide
   * `requireToolApproval` is NOT forced). Never silently run; when no storage
   * exists to resume, `'ask'` falls back to a fail-safe omit. OPTIONAL — when
   * absent, the tool map is unchanged (production-default). Agent-only. See
   * `mastra/permission-tool-gate.ts`.
   *
   * This is the TRUSTED, server-built snapshot (risk classification is
   * registry-side). The renderer never sets it directly — it sends the OPT-IN
   * `permissionPolicyRequest` below, and the assistant server resolves that into
   * this field via `resolveRequestPermissionPolicy`.
   */
  permissionPolicy?: PermissionToolGateSnapshot;
  /**
   * The renderer-supplied permission snapshot from the user's
   * `permission-policy-store`, carried over the wire. The server reads it and,
   * when `enforce === true`, builds the trusted `permissionPolicy` above
   * (`resolveRequestPermissionPolicy`); when `enforce` is absent/false the
   * server leaves `permissionPolicy` unset (passthrough). It carries NO
   * `riskByTool` — tool risk classification is server-owned, never client-
   * supplied. Cleared from the runtime before the agent is built. Agent-only.
   */
  permissionPolicyRequest?: AssistantPermissionPolicyRequest;
  /**
   * Built-in subagent personas the supervisor may delegate to (server-set,
   * agent-only, mirrors `mastraTools`). Threaded through on both the initial turn
   * and the approval-resume path so the rebuilt supervisor keeps its `agent-<id>`
   * delegation tools. Skipped for the built-in local provider (agent-side, D10).
   */
  personas?: readonly AssistantPersonaDefinition[];
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
/**
 * A live, incremental slice of a running shell command's output. Transient
 * (never persisted — see SHELL_OUTPUT_DATA_NAME); the final captured output
 * still returns as the tool result.
 */
export interface StreamChunkShellOutput {
  chunk: string;
  stream: 'stdout' | 'stderr';
  toolCallId: string;
  truncated?: boolean;
  type: 'shell-output';
}
export interface StreamChunkToolApprovalRequired extends AssistantToolApprovalRequest {
  type: 'tool-approval-required';
}
export interface StreamChunkToolSuspendRequired extends AssistantToolSuspendRequest {
  type: 'tool-suspend-required';
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
  | StreamChunkShellOutput
  | StreamChunkText
  | StreamChunkTool
  | StreamChunkToolApprovalRequired
  | StreamChunkToolSuspendRequired
  | StreamChunkFinish
  | StreamChunkMessageFinish;

export type StreamIterator = AsyncIterable<StreamChunk>;
