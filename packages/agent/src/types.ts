import type {
  JSONObject,
  SharedV2ProviderOptions,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type {
  AssistantChildAttachment,
  RuntimeData as ContractRuntimeData,
} from '@brainstrike/assistant-contract';
import type { AssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import type {
  DelegatedConversationBaseline,
  DelegatedRunIdentity,
} from '@brainstrike/assistant-contract/delegated-conversation-stream';
import type { HookTrustRequest } from '@brainstrike/assistant-contract/hook-trust-request';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { AssistantChildRunUsage } from '@brainstrike/assistant-contract/run-usage';
import type {
  AssistantToolApprovalAnswered,
  AssistantToolApprovalRequest,
} from '@brainstrike/assistant-contract/tool-approval';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import type { AssistantToolSuspendRequest } from '@brainstrike/assistant-contract/tool-suspend';
import {
  type BedrockReasoningEffort,
  type GoogleThinkingLevel,
  OPENAI_REASONING_EFFORT_VALUES,
  type OpenAiReasoningEffort,
  type OpenAiReasoningSummary,
} from '@brainstrike/types';
import type { AgentMemoryOption, ToolsInput } from '@mastra/core/agent';
import type { WorkspaceSkills } from '@mastra/core/skills';
import type { AssistantPermissionPolicyRequest } from './mastra/permission-policy-request';
import type { McpConfig } from './mcp/config';
import type { RuntimeAssistantMemorySettings } from './memory-settings';
import type { LocalLlmHostClient } from './providers/local/llm-host-client';
import type { AssistantRunEvent } from './run-events';
import type { AgentHookRunner } from './tools/hook-runner';

interface ToolProjectionRewriteEntryBase {
  readonly markerText: string;
  readonly toolCallId: string;
}

export type ToolProjectionRewriteEntry =
  | (ToolProjectionRewriteEntryBase & {
      readonly kind: 'prune';
      readonly supersededByToolCallId: null;
    })
  | (ToolProjectionRewriteEntryBase & {
      readonly kind: 'supersession';
      readonly supersededByToolCallId: string;
    });

/** Desktop-injected, read-only access to durable request-build overlays. */
export interface ToolProjectionRewriteLookup {
  readonly listActiveRewrites: (
    threadId: string
  ) => Promise<ReadonlyMap<string, ToolProjectionRewriteEntry>>;
}

/** One durable compaction summary and the exact raw message ids it replaces. */
export interface CompactionRangeEntry {
  readonly compactedMessageIds: readonly string[];
  readonly compactionMessageId: string;
}

/** Desktop-injected, read-only access to durable compaction overlays. */
export interface CompactionRangeLookup {
  readonly listActiveCompactionRanges: (
    threadId: string
  ) => Promise<readonly CompactionRangeEntry[]>;
}

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
/**
 * An inline file carried by a USER message (v1: validated image attachments
 * only — see `@brainstrike/assistant-contract` assistant-attachments). `data`
 * is a base64 `data:` URL; it must NEVER be flattened into prompt text.
 */
export interface AgentMessagePartFile {
  data: string;
  filename?: string | undefined;
  mediaType: string;
  type: 'file';
}
export type AgentMessagePart = AgentMessagePartText | AgentMessagePartTool | AgentMessagePartFile;

export interface AgentMessage {
  id: string;
  parts: AgentMessagePart[];
  role: 'user' | 'assistant' | 'system';
}

export type AssistantUiScalar = string | number | boolean | null;

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
 * fields that bind to runtime libraries, plus server-only fields. The
 * shared fields — including `provider` (which now inherits `'local'`) — live
 * in the contract; this is what removes the old "keep the two declarations in
 * sync" drift hazard.
 */
export interface RuntimeData extends Omit<ContractRuntimeData, 'memory' | 'providerOptions'> {
  /**
   * Server-validated assistant-ui message id for this response. The runtime
   * uses it as Mastra's first generated assistant id so persisted content,
   * streamed UI state, and branch topology share one identity. Agent-only.
   */
  assistantMessageId?: string;
  /**
   * Desktop-injected lookup for durable conversation-compaction overlays.
   * The input-step processor filters only the transient ID-bearing message
   * list; durable Mastra rows remain unchanged. Server-side only.
   */
  compactionOverlayLookup?: CompactionRangeLookup;
  /**
   * Desktop-injected recovery callback for terminal provider context overflow.
   * It may commit deterministic compaction, but never retries the current turn.
   */
  contextOverflowRecovery?: () => Promise<{ readonly applied: boolean }>;
  /**
   * Server-injected tool-lifecycle hook runner (desktop). Composed into the
   * tool-execute seam so PreToolUse hooks can block a permitted tool and
   * PostToolUse hooks can append bounded context. Never serialized over
   * IPC/HTTP (an in-process closure over the main-process HookManager).
   * Agent-only — mirrors `localLlmHostClient`.
   */
  hookRunner?: AgentHookRunner;
  /**
   * Renderer-supplied hook-trust snapshot (wire). The server resolves it into
   * per-root trust (re-hashing disk) and STRIPS it before the agent is built —
   * the client must never set the trusted `hookRunner` directly. Agent-only.
   */
  hookTrustRequest?: HookTrustRequest;
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
   * the FUNCTION form of Mastra's PER-TOOL `requireApproval` (the runtime's live
   * gate, `mastra/approval-gate.ts`) so the run SUSPENDS for approval only when
   * that tool is called and no remembered session grant allows it (allowed
   * tools run free; the run-wide `requireToolApproval` is NOT forced). Never silently run; when no storage
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
   *
   * WIRE SHAPE (canonical note — neighbours point here) — read the VALUE, never
   * key presence. The sole producer (`prepareRequestData` in
   * `use-assistant-request-lifecycle.ts`) writes this key UNCONDITIONALLY: the
   * snapshot when the transport is permission-enforceable and `enforce` is set,
   * otherwise an explicit `undefined`. The shape therefore DIVERGES by vantage
   * point — PRESENT-and-undefined on the producer's object, absent on the wire
   * once `JSON.stringify` drops it. That is not the presence-means-on
   * convention some neighbours (e.g. `subagentPersonasRequest`) use, where the
   * key is genuinely omitted.
   *
   * Being precise about where that bites: a server consumer reading the
   * DESERIALIZED request would get the right answer from a
   * `'permissionPolicyRequest' in runtimeData` check today — but only because
   * serialization happens to erase the difference. The same check is already
   * wrong for anything reading the producer's object before it is serialized,
   * and would silently turn enforcement on for an opted-out user the moment a
   * non-serializing or in-process transport appears. Pass the value to
   * `resolveRequestPermissionPolicy`, which treats absent and `undefined`
   * identically, and the distinction never matters.
   *
   * `tsc` cannot catch drift here: `exactOptionalPropertyTypes` (on repo-wide)
   * would REJECT that explicit `undefined` against this `?:` declaration, and
   * the producer only escapes it because `prepareRequestData` is typed
   * `Promise<Record<string, unknown>>`.
   */
  permissionPolicyRequest?: AssistantPermissionPolicyRequest;
  /**
   * API keys for providers that pinned personas target (server-resolved from
   * the secrets bridge, agent-only, NEVER client-supplied). Keyed by provider
   * id. The parent provider's key is NOT duplicated here — the pin resolver
   * reuses `apiKey` when the pin targets the parent provider.
   */
  personaProviderApiKeys?: Readonly<Record<string, string>>;
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
  /**
   * Desktop-injected lookup for superseded native-tool projection overlays.
   * The input processor consults it only while building a provider request;
   * durable Mastra message content is never changed. Server-side only, never
   * serialized over IPC/HTTP. Agent-only — mirrors `hookRunner`.
   */
  toolProjectionRewriteLookup?: ToolProjectionRewriteLookup;
  /**
   * Server-injected Agent Skills engine (desktop). When present (and the
   * provider is not the built-in local model), the runtime folds Mastra's
   * `skill`/`skill_read`/`skill_search` tools into the local tool map BEFORE
   * guards/hooks/plan-mode/permission, and composes a `SkillsProcessor` into
   * the per-call input processors so available-skills metadata reaches the
   * system context. Never serialized over IPC/HTTP (an in-process object over
   * the main-process skills scan). Agent-only — mirrors `hookRunner`.
   */
  workspaceSkills?: WorkspaceSkills;
}

export interface RuntimeMemoryContext {
  memoryOptions?: AgentMemoryOption['options'];
  memorySettings?: RuntimeAssistantMemorySettings;
  resourceId: string;
  runId?: string;
  threadId: string;
}

/**
 * Re-exported, never re-declared. This package is the one that actually hands
 * `providerOptions` to the SDK, so a local copy narrower than the picker's
 * would drop a selected value on the floor with nothing to catch it.
 */
export {
  type BedrockReasoningEffort,
  type GoogleThinkingLevel,
  OPENAI_REASONING_EFFORT_VALUES,
  type OpenAiReasoningEffort,
  type OpenAiReasoningSummary,
};

export interface OpenAiProviderOptions extends JSONObject {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
}

export interface OpenRouterProviderOptions extends JSONObject {
  reasoning?: {
    enabled?: boolean;
    effort?: OpenAiReasoningEffort;
    summary?: OpenAiReasoningSummary;
  };
}

/** Mirrors the `effort` enum of the installed `@ai-sdk/anthropic` (4.0.49). */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Mirrors the `thinking` discriminated union of the installed
 * `@ai-sdk/anthropic` (4.0.49). `display` governs whether reasoning is
 * RETURNED and defaults to `omitted` provider-side, so it must be asked for.
 * `updates` — thinking returned BETWEEN tool calls — is new in this provider
 * range; the provider adds the `thinking-display-updates-2026-08-18` beta
 * header for it. It is mirrored because the wire accepts it, not because the
 * app emits it yet: the producer in `assistant-ui-panel-wrapper-runtime` still
 * projects `resolveReasoningVisible` onto `summarized`/`omitted` only.
 * Kept in step with the identical declaration in
 * `@brainstrike/assistant-contract` — this package is what actually hands
 * `providerOptions` to the SDK, so a narrower type here would silently fail
 * to represent what the app sends. Both this copy and that one are compared
 * against the installed provider by
 * `scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs`.
 */
export type AnthropicThinkingOptions =
  | { type: 'adaptive'; display?: 'omitted' | 'summarized' | 'updates' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' };

export interface AnthropicProviderOptions extends JSONObject {
  effort?: AnthropicEffort;
  thinking?: AnthropicThinkingOptions;
}

/**
 * Mirrors `reasoningConfig` of the installed `@ai-sdk/amazon-bedrock` (5.0.57).
 * Kept in step with the identical declaration in
 * `@brainstrike/assistant-contract` — this package is what actually hands
 * `providerOptions` to the SDK, so a narrower type here would silently fail to
 * represent what the app sends. Not a discriminated union on purpose:
 * `type: 'enabled'` takes `budgetTokens` on Claude routes and
 * `maxReasoningEffort` on Amazon Nova, and which one applies is a registry
 * fact (`LlmModelDefinition.bedrockReasoning`), not a property of this shape.
 */
// biome-ignore lint/style/useConsistentTypeDefinitions: must stay a type ALIAS. `BedrockProviderOptions` extends `JSONObject`, whose string index signature an interface member does not satisfy (TS2411); a type alias gets the implicit index signature. Same reason `AnthropicThinkingOptions` is an alias.
export type BedrockReasoningConfig = {
  budgetTokens?: number;
  display?: 'omitted' | 'summarized';
  maxReasoningEffort?: BedrockReasoningEffort;
  type: 'adaptive' | 'disabled' | 'enabled';
};

export interface BedrockProviderOptions extends JSONObject {
  reasoningConfig?: BedrockReasoningConfig;
}

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
 * These namespaces are transport-only and must be stripped before Mastra
 * receives per-generation `providerOptions`; otherwise their fields become
 * chat-completions request parameters.
 */
export interface LocalRuntimeProviderOptions extends JSONObject {
  apiToken?: string;
  baseUrl?: string;
}

export type RuntimeProviderOptions = (SharedV2ProviderOptions | SharedV3ProviderOptions) & {
  openai?: OpenAiProviderOptions & JSONObject;
  anthropic?: AnthropicProviderOptions & JSONObject;
  bedrock?: BedrockProviderOptions & JSONObject;
  google?: GoogleProviderOptions & JSONObject;
  local?: LocalProviderOptions & JSONObject;
  ollama?: LocalRuntimeProviderOptions & JSONObject;
  lmstudio?: LocalRuntimeProviderOptions & JSONObject;
  openrouter?: OpenRouterProviderOptions & JSONObject;
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
  /**
   * `'declined'` is the approval lifecycle's DECLINE terminal (@mastra/core
   * 1.59 `tool-output-denied`, BST-1282). It is its own status, not a flavour
   * of `'error'`, precisely because the two must diverge downstream: both
   * settle the call, but a decline must NOT queue the visible
   * "I couldn't complete the tool action because it failed" fallback, and must
   * not paint the tool card with destructive failure chrome. Nothing ran and
   * nothing broke — the user made a choice.
   */
  status: 'start' | 'progress' | 'success' | 'error' | 'declined';
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
/**
 * Prompt-composition breakdown computed at prompt assembly, emitted once at run
 * start. Transient (never persisted — the run-event persistence tap ignores
 * non-run-event chunks; see CONTEXT_BREAKDOWN_DATA_NAME, mirroring the
 * shell-output precedent).
 */
export interface StreamChunkContextBreakdown {
  breakdown: AssistantContextBreakdown;
  type: 'context-breakdown';
}
/**
 * Child model-call usage (BST-953): an OM observer/reflector cycle or a
 * subagent delegation leg. The desktop server persists it as a durable
 * `run_kind`-tagged usage row and forwards it to the renderer as a transient
 * `brainstrike.child-run-usage` aui-data part (display refresh only).
 */
export interface StreamChunkChildRunUsage {
  type: 'child-run-usage';
  value: AssistantChildRunUsage;
}
/**
 * Internal run-end payload consumed by the desktop durable telemetry sink.
 * `occurredAt` is captured at the actual tool-call/projection moment (epoch
 * ms), not at run-end flush time — a long run's calls must not all collapse
 * onto the same timestamp (review fix).
 */
export interface ToolCallTelemetrySample {
  /** BST-1247: candidate-set cap hit in the search substrate (not output clipping). */
  readonly candidatesTruncated: boolean;
  /** Live-pass engine for search tools; absent for non-search tools. */
  readonly engine?: 'js-walk' | 'ripgrep' | 'skipped';
  readonly isPaginationFollowup: boolean;
  readonly modelFacingChars: number;
  readonly occurredAt: number;
  /** BST-1247: bounded scan/walk cap hit in the search substrate. */
  readonly scanLimited: boolean;
  readonly toolId: string;
  /** Model-facing output was clipped — output clipping ONLY (BST-1247). */
  readonly truncated: boolean;
  readonly zeroMatch?: boolean;
}
export interface StreamChunkToolCallTelemetry {
  readonly type: 'tool-call-telemetry';
  readonly value: readonly ToolCallTelemetrySample[];
}
/**
 * Run-end calibration pair over the final prompt's estimator-visible share.
 * `estimatedPromptTokens` counts model-visible tool-output projections plus
 * tool definitions once; `finalStepPromptTokens` is the most recent provider
 * step's prompt size, which contains prior tool outputs once via Mastra's resend
 * behavior. Conversation/system-prompt text outside those shares is excluded.
 */
export interface TokenEstimateCalibrationSample {
  readonly estimatedPromptTokens: number;
  readonly finalStepPromptTokens: number;
  readonly model: string;
  readonly modelVisibleProjectionCount: number;
  readonly occurredAt: number;
  /** System instructions + task list + tool definitions from this run's prompt breakdown. */
  readonly promptBreakdownBaselineTokens?: number;
  readonly provider: string;
  readonly resolvedDomainBudgetTokens?: number;
  readonly resolvedTransportBudgetTokens?: number;
  readonly stepCount: number;
}
export interface StreamChunkTokenEstimateCalibration {
  readonly type: 'token-estimate-calibration';
  readonly value: TokenEstimateCalibrationSample;
}
export interface StreamChunkToolApprovalRequired extends AssistantToolApprovalRequest {
  type: 'tool-approval-required';
}
/** A parked sibling approval the host answered under a session grant. */
export interface StreamChunkToolApprovalAnswered extends AssistantToolApprovalAnswered {
  type: 'tool-approval-answered';
}
export interface StreamChunkToolSuspendRequired extends AssistantToolSuspendRequest {
  /**
   * `false` when this build has no registered resume UI for the tool
   * (`hasRegisteredSuspendResumeUi`). The mapper then SETTLES the tool call as
   * an error instead of leaving a Running card nothing can ever resolve.
   * Omitted (i.e. resumable) for the registered suspending tools, whose card is
   * legitimately waiting for the user's answer.
   */
  resumeSupported?: false;
  type: 'tool-suspend-required';
}
export interface StreamChunkFinish {
  billedCostUsd?: number;
  type: 'finish';
  usage: { promptTokens: number; completionTokens: number };
}

export type StreamFinishReason =
  | 'absent'
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown'
  | 'unrecognized';

export interface StreamChunkMessageFinish {
  billedCostUsd?: number;
  finishReason: StreamFinishReason;
  path: readonly number[];
  type: 'message-finish';
  usage: {
    promptTokens: number;
    completionTokens: number;
    /** Latest provider-step prompt size for context occupancy, not billed run input. */
    contextInputTokens?: number;
    /** Latest provider-step completion size for next-prompt occupancy. */
    contextOutputTokens?: number;
    /** Anthropic prompt-cache write tokens (billed at the cache-write rate). */
    cacheCreationInputTokens?: number;
    /** Anthropic prompt-cache read tokens (billed at the cache-read rate). */
    cacheReadInputTokens?: number;
  };
}
export interface StreamChunkChildUserMessage {
  readonly attachments?: readonly AssistantChildAttachment[];
  readonly createdAt: string;
  readonly id: string;
  readonly text: string;
  readonly type: 'child-user-message';
}

export type ConversationStreamChunk =
  | StreamChunkChildUserMessage
  | StreamChunkChildRunUsage
  | StreamChunkContextBreakdown
  | StreamChunkReasoning
  | StreamChunkRunEvent
  | StreamChunkShellOutput
  | StreamChunkText
  | StreamChunkTokenEstimateCalibration
  | StreamChunkToolCallTelemetry
  | StreamChunkTool
  | StreamChunkToolApprovalRequired
  | StreamChunkToolApprovalAnswered
  | StreamChunkToolSuspendRequired
  | StreamChunkFinish
  | StreamChunkMessageFinish;

export interface StreamChunkDelegatedConversation {
  readonly baseline?: DelegatedConversationBaseline;
  readonly chunk: ConversationStreamChunk;
  readonly continuationId?: string;
  readonly identity: DelegatedRunIdentity;
  readonly messageId: string;
  readonly partId?: string;
  readonly type: 'delegated-conversation-chunk';
}

export interface StreamChunkChildContinuation {
  readonly baseline?: DelegatedConversationBaseline;
  readonly chunk: ConversationStreamChunk;
  readonly continuationId: string;
  readonly messageId: string;
  readonly nativeRunId: string;
  readonly threadId: string;
  readonly type: 'child-continuation-chunk';
}
export type StreamChunk =
  | ConversationStreamChunk
  | StreamChunkDelegatedConversation
  | StreamChunkChildContinuation;

export type StreamIterator = AsyncIterable<StreamChunk>;
