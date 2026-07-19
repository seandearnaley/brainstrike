import type { AssistantTaskItem } from './assistant-task-list.js';
import type { RuntimeAssistantMemorySettings } from './memory-settings.js';
import type { SkillsContextRequest } from './skills.js';

export type RuntimeJsonObject = Record<string, unknown>;

export interface RuntimeAgentLoopSettings {
  inputTokenLimit?: number;
  maxSteps?: number;
}

export type OpenAiReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
export type OpenAiReasoningSummary = 'auto' | 'detailed';

export interface OpenAiProviderOptions extends RuntimeJsonObject {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
}

export interface OpenRouterProviderOptions extends RuntimeJsonObject {
  reasoning?: {
    effort?: OpenAiReasoningEffort;
    summary?: OpenAiReasoningSummary;
  };
}

export type AnthropicEffort = 'low' | 'medium' | 'high';

export interface AnthropicProviderOptions extends RuntimeJsonObject {
  effort?: AnthropicEffort;
  thinking?: { type: 'enabled'; budgetTokens: number };
}

export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface GoogleProviderOptions extends RuntimeJsonObject {
  thinkingConfig?: {
    thinkingBudget?: number;
    thinkingLevel?: GoogleThinkingLevel;
    includeThoughts?: boolean;
  };
}

export interface LocalProviderOptions extends RuntimeJsonObject {
  thinking?: {
    enabled?: boolean;
  };
}

export interface LocalRuntimeProviderOptions extends RuntimeJsonObject {
  apiToken?: string;
  baseUrl?: string;
}

export interface RuntimeModelSettings {
  frequencyPenalty?: number;
  maxOutputTokens?: number;
  presencePenalty?: number;
  temperature?: number;
  topP?: number;
}

export type RuntimeProviderOptions = RuntimeJsonObject & {
  anthropic?: AnthropicProviderOptions;
  google?: GoogleProviderOptions;
  lmstudio?: LocalRuntimeProviderOptions;
  local?: LocalProviderOptions;
  ollama?: LocalRuntimeProviderOptions;
  openai?: OpenAiProviderOptions;
  openrouter?: OpenRouterProviderOptions;
};

export interface RuntimeWorkspaceContextRangeMetadata {
  approxTokens?: number | null;
  endLine: number;
  isActive?: boolean;
  startLine: number;
}

export interface RuntimeWorkspaceContextFileMetadata {
  approxTokens?: number | null;
  outputApproxTokens?: number | null;
  path: string;
  ranges?: readonly RuntimeWorkspaceContextRangeMetadata[];
  /** Display name of the root, for disambiguating the same relative path across roots. */
  rootDisplayName?: string;
  /** Durable RootId of the file's root (multi-root); absent for legacy snapshots. */
  rootId?: string;
}

/**
 * One active workspace root (multi-root). Resolved server-side from the DB
 * `roots` table so the root identity here matches `file_records.root_id` — the
 * same id surfaced on search results — and the path matches what read tools
 * resolve against. One source of truth for both.
 */
export interface RuntimeWorkspaceRoot {
  /** Human display name (typically the last path segment); the model can use it to qualify a root. */
  displayName: string;
  /** Absolute filesystem path of the root. */
  path: string;
  /** Durable root id (DB `roots.id`; matches `file_records.root_id`). */
  rootId: string;
}

export interface RuntimeWorkspaceContextMetadata {
  files?: readonly RuntimeWorkspaceContextFileMetadata[];
  includeProjectTree?: boolean;
  projectTreeApproxTokens?: number | null;
  projectTreeTokenCountLoading?: boolean;
  selectedOutputApproxTokens?: number | null;
  selectedSourceApproxTokens?: number | null;
  tokenBudget?: number;
}

export type RuntimeWorkspaceIndexStatusState =
  | 'blocked'
  | 'disabled'
  | 'idle'
  | 'paused'
  | 'recovering'
  | 'waiting'
  | 'scanning'
  | 'importing'
  | 'chunking'
  | 'embedding'
  | 'error';

export interface RuntimeWorkspaceIndexQueueProgress {
  failed: number;
  lastError?: string | null;
  pending: number;
  processed: number;
  totalQueued: number;
}

export type RuntimeMemoryOptions = RuntimeJsonObject;

/**
 * Renderer-supplied preference for auto-injecting a mounted root's workspace
 * instructions file (`AGENTS.md`/`AGENT.md`/`CLAUDE.md`) into the assistant's
 * system context (see docs/agents/workspace-context.md "WORKSPACE INSTRUCTIONS CONTEXT"). Mirrors the
 * persisted `workspace-instructions-preferences-store` slice as plain JSON.
 *
 * Threshold-hybrid policy: a file that FITS the per-file char budget is injected
 * whole by default; an OVERSIZED file is injected (truncated) only for a root
 * whose id is `true` in `oversizedOptInByRootId`. Absent/`undefined` =>
 * master-enabled default (feature on), no oversized opt-ins.
 */
export interface WorkspaceInstructionsContextRequest {
  /** Master opt-out. Absent is treated as ON (the store default). */
  masterEnabled?: boolean;
  /**
   * Per-root opt-in to inject an OVERSIZED context file (truncated). Keyed by the
   * durable DB `roots.id`; only `true` entries are meaningful.
   */
  oversizedOptInByRootId?: Record<string, boolean>;
}

/**
 * Renderer preference for subagent persona availability (see the
 * subagent-personas preferences store). Presence-means-non-default: the
 * renderer attaches it only when something diverges from "delegation on,
 * nothing disabled".
 */
export interface SubagentPersonasAvailabilityRequest {
  /** Master switch. Absent is treated as ON (the store default). */
  delegationEnabled?: boolean;
  /** Persona ids (built-in or user) the user toggled OFF. */
  disabledPersonaIds?: readonly string[];
}

export interface RuntimeMemoryContext {
  memoryOptions?: RuntimeMemoryOptions;
  memorySettings?: RuntimeAssistantMemorySettings;
  resourceId: string;
  runId?: string;
  threadId: string;
}

/**
 * Client-authored observability metadata for history images elided from one
 * wire request. A trust boundary may validate and discard it, but must never
 * interpret it as runtime configuration or forward it to the model.
 */
export interface RuntimeTransportImageElision {
  readonly elidedImageBytes: number;
  readonly elidedImageCount: number;
  readonly keptImageBytes: number;
  readonly strategy: 'newest-first-combined-image-budget';
  /** Counted in elidedImageCount but excluded from elidedImageBytes. */
  readonly unmeasurableImageCount?: number;
}

export interface RuntimeData {
  agentLoop?: RuntimeAgentLoopSettings;
  apiKey?: string;
  callTool?: (
    name: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown) => void }
  ) => Promise<unknown>;
  contextTokenCount?: number;
  embeddingSetId?: string;
  enabledNativeToolIds?: readonly string[];
  includeFileReport?: boolean;
  includeProjectTree?: boolean;
  /**
   * The client's declared MAIN root (activeRootIds[0] in the file-explorer
   * store) — the assistant's operating root. An ORDERING HINT for the
   * server's workspace-root enrichment (the matching root moves to the front
   * of `workspaceRoots`, so hooks cwd and the model-facing "main root path"
   * follow it); a preference, not a security boundary. NEVER treat the id as
   * a path — it is a durable identity (DB `roots.id` on desktop). Absent =>
   * server keeps `created_at ASC` order (legacy tiebreak).
   */
  mainRootId?: string;
  /**
   * Absolute path of the declared main root (from the client root
   * descriptor). Fallback matcher for the server reorder when the client
   * root id diverges from the DB `roots.id` (legacy id spaces); same
   * ordering-hint trust posture as `mainRootId`. Absent for roots without an
   * absolute path (web FSA).
   */
  mainRootPath?: string;
  mcpEnabled?: boolean;
  memory?: RuntimeMemoryContext;
  model?: string;
  modelSettings?: RuntimeModelSettings;
  /**
   * Plan mode (opt-in, per-request). When `true`, the agent runtime constrains
   * the tool map to read-only + `submitPlan`/`askUser` (edit/execute tools are
   * omitted) and prepends a PLAN-MODE instruction block, so the model
   * investigates and proposes a plan for approval before any changes. Sent over
   * the wire ONLY when `true` (presence-means-on, like `permissionPolicyRequest`).
   * Excluded for the built-in local provider. Agent-only enforcement.
   */
  planMode?: boolean;
  projectId?: string;
  provider?: 'anthropic' | 'google' | 'local' | 'openai' | 'openrouter' | string;
  providerOptions?: RuntimeProviderOptions;
  selectionFilePaths?: readonly string[];
  /**
   * Multi-root: selected files belonging to ACTIVE roots OTHER than the
   * assistant's workspace root. The assistant's file tools are single-root
   * (anchored at workspaceRootPath), so these files are not addressable —
   * the count is surfaced (never silently dropped) so the model can tell
   * the user part of their selection is outside the current workspace.
   */
  selectionFilePathsFromOtherRoots?: number;
  selectionFolderId?: string;
  selectionSnapshotId?: string;
  signal?: AbortSignal;
  /**
   * Renderer-supplied Agent Skills preference (from the skills preferences
   * store). A preference, not a security boundary — it can only REDUCE the
   * skill set (master off / per-skill disable), never inject skills. Absent =>
   * master enabled, nothing disabled. The desktop server resolves it into the
   * TRUSTED `workspaceSkills` engine (agent-side field); a client-supplied
   * engine is stripped.
   */
  skillsPreference?: SkillsContextRequest;
  /**
   * Renderer-supplied subagent persona availability (from the subagent-personas
   * preferences store). A preference, not a security boundary — it can only
   * REDUCE the persona set (disable delegation or individual personas), never
   * inject personas or credentials. Absent => delegation on, nothing disabled.
   */
  subagentPersonasRequest?: SubagentPersonasAvailabilityRequest;
  /**
   * The current per-thread assistant task list, read server-side at request
   * start and re-serialized into the system instructions every turn (see the
   * `<current-task-list>` block in the agent runtime). Populated server-side
   * only — the client never sends it.
   */
  taskList?: readonly AssistantTaskItem[];
  tokenBudget?: number | null;
  transportImageElision?: RuntimeTransportImageElision;
  workspaceContext?: RuntimeWorkspaceContextMetadata;
  workspaceIndexBlockedReason?: string | null;
  workspaceIndexEmbeddingSetId?: string;
  workspaceIndexingEnabled?: boolean;
  workspaceIndexingMode?: string;
  workspaceIndexingPaused?: boolean;
  workspaceIndexLastError?: string | null;
  workspaceIndexQueueProgress?: RuntimeWorkspaceIndexQueueProgress | null;
  workspaceIndexStatusState?: RuntimeWorkspaceIndexStatusState;
  /**
   * Renderer-supplied preference for auto-injecting a root's workspace
   * instructions file into the system context. A preference, not a security
   * boundary — the server reads it directly. Absent => master-enabled default.
   */
  workspaceInstructionsPreference?: WorkspaceInstructionsContextRequest;
  workspaceRootPath?: string;
  /**
   * Active workspace roots (multi-root). Resolved server-side from the DB
   * `roots` table so search-result root ids and read-tool root paths share one
   * source of truth. Empty/absent => single-root or legacy: tools fall back to
   * a single root synthesized from `workspaceRootPath`.
   */
  workspaceRoots?: readonly RuntimeWorkspaceRoot[];
}
