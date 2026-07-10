import type { AssistantTaskItem } from './assistant-task-list.js';
import type { RuntimeAssistantMemorySettings } from './memory-settings.js';

export type RuntimeJsonObject = Record<string, unknown>;

export interface RuntimeAgentLoopSettings {
  inputTokenLimit?: number;
  maxSteps?: number;
}

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'detailed';

export interface OpenAiProviderOptions extends RuntimeJsonObject {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
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
  maxOutputTokens?: number;
}

export type RuntimeProviderOptions = RuntimeJsonObject & {
  anthropic?: AnthropicProviderOptions;
  google?: GoogleProviderOptions;
  lmstudio?: LocalRuntimeProviderOptions;
  local?: LocalProviderOptions;
  ollama?: LocalRuntimeProviderOptions;
  openai?: OpenAiProviderOptions;
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

export interface RuntimeMemoryContext {
  memoryOptions?: RuntimeMemoryOptions;
  memorySettings?: RuntimeAssistantMemorySettings;
  resourceId: string;
  runId?: string;
  threadId: string;
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
   * The current per-thread assistant task list, read server-side at request
   * start and re-serialized into the system instructions every turn (see the
   * `<current-task-list>` block in the agent runtime). Populated server-side
   * only — the client never sends it.
   */
  taskList?: readonly AssistantTaskItem[];
  tokenBudget?: number | null;
  workspaceContext?: RuntimeWorkspaceContextMetadata;
  workspaceIndexBlockedReason?: string | null;
  workspaceIndexEmbeddingSetId?: string;
  workspaceIndexingEnabled?: boolean;
  workspaceIndexingMode?: string;
  workspaceIndexingPaused?: boolean;
  workspaceIndexLastError?: string | null;
  workspaceIndexQueueProgress?: RuntimeWorkspaceIndexQueueProgress | null;
  workspaceIndexStatusState?: RuntimeWorkspaceIndexStatusState;
  workspaceRootPath?: string;
  /**
   * Active workspace roots (multi-root). Resolved server-side from the DB
   * `roots` table so search-result root ids and read-tool root paths share one
   * source of truth. Empty/absent => single-root or legacy: tools fall back to
   * a single root synthesized from `workspaceRootPath`.
   */
  workspaceRoots?: readonly RuntimeWorkspaceRoot[];
}
