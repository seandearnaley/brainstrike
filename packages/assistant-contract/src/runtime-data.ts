import {
  type BedrockReasoningEffort,
  type GoogleThinkingLevel,
  OPENAI_REASONING_EFFORT_VALUES,
  type OpenAiReasoningEffort,
  type OpenAiReasoningSummary,
} from '@brainstrike/types';
import type { AssistantTaskItem } from './assistant-task-list.js';
import type { RuntimeAssistantMemorySettings } from './memory-settings.js';
import type { SkillsContextRequest } from './skills.js';

export type RuntimeJsonObject = Record<string, unknown>;

export interface RuntimeAgentLoopSettings {
  inputTokenLimit?: number;
  maxSteps?: number;
}

/**
 * In-memory mid-run steering control (BST-588). Injected server-side (like
 * `signal`); never serialized. `stopRequested()` is polled by the agent loop
 * at step boundaries.
 */
export interface AssistantRunSteeringControl {
  stopRequested(): boolean;
}

/**
 * Re-exported, never re-declared. `@brainstrike/types` is the leaf that owns
 * these reasoning vocabularies; a second declaration here would be free to
 * drift from the pickers that read them.
 */
export {
  type BedrockReasoningEffort,
  type GoogleThinkingLevel,
  OPENAI_REASONING_EFFORT_VALUES,
  type OpenAiReasoningEffort,
  type OpenAiReasoningSummary,
};

export interface OpenAiProviderOptions extends RuntimeJsonObject {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
}

export interface OpenRouterProviderOptions extends RuntimeJsonObject {
  provider: {
    // biome-ignore lint/style/useNamingConvention: OpenRouter wire field.
    require_parameters: true;
  };
  reasoning?: {
    enabled?: boolean;
    effort?: OpenAiReasoningEffort;
    /**
     * OpenRouter RETURNS reasoning by default; `exclude: true` is the
     * documented way to suppress it. Visibility therefore only ever adds a
     * field on explicit opt-out — never on the default path. That matters
     * because `provider.require_parameters` narrows routing to endpoints
     * supporting every supplied parameter, so an unconditional extra field
     * would shrink the eligible upstream pool for every request.
     */
    exclude?: boolean;
    summary?: OpenAiReasoningSummary;
  };
}

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Mirrors the `thinking` discriminated union of the installed
 * `@ai-sdk/anthropic` (4.0.49), held there by
 * `scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs`.
 *
 * `budgetTokens` is OPTIONAL upstream and required here on purpose: an
 * `enabled` request without an explicit budget is not a shape this app emits.
 * The mirror contract compares union membership, not field optionality, so
 * that narrowing stays deliberate rather than becoming an accident.
 *
 * `adaptive` is the modern form and the only one carrying `display`, which
 * governs whether reasoning is RETURNED. `display` defaults to `omitted`
 * provider-side on current models, so reasoning must be asked for explicitly —
 * that silence was why Claude runs showed no thinking. `enabled` + an explicit
 * `budgetTokens` remains supported for older models.
 *
 * `updates` — thinking returned BETWEEN tool calls — is new in this provider
 * range and is mirrored because the wire accepts it, not because the app emits
 * it: the producer in `assistant-ui-panel-wrapper-runtime` still projects
 * `resolveReasoningVisible` onto `summarized`/`omitted` only. Leaving it out
 * would make this union strictly narrower than the provider, the exact failure
 * mode the mirror contract exists to catch.
 */
export type AnthropicThinkingOptions =
  | { type: 'adaptive'; display?: 'omitted' | 'summarized' | 'updates' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' };

export interface AnthropicProviderOptions extends RuntimeJsonObject {
  effort?: AnthropicEffort;
  thinking?: AnthropicThinkingOptions;
}

/**
 * Mirrors `reasoningConfig` of the installed `@ai-sdk/amazon-bedrock` (5.0.57).
 *
 * Deliberately NOT a discriminated union: `type: 'enabled'` carries
 * `budgetTokens` for Claude routes and `maxReasoningEffort` for Amazon Nova,
 * so the same tag has two valid payloads and a union on `type` would be a lie.
 * WHICH payload a route accepts is a registry fact
 * (`LlmModelDefinition.bedrockReasoning`), not something this shape can encode.
 *
 * `type` is REQUIRED here though optional upstream: a config with no type is
 * not a shape this app emits.
 *
 * `display` is the VISIBILITY knob and is honored by the SDK only for
 * `type: 'adaptive'` — the same asymmetry first-party Anthropic has, where the
 * legacy `enabled` + budget form carries no display either.
 */
export interface BedrockReasoningConfig {
  budgetTokens?: number;
  display?: 'omitted' | 'summarized';
  maxReasoningEffort?: BedrockReasoningEffort;
  type: 'adaptive' | 'disabled' | 'enabled';
}

export interface BedrockProviderOptions extends RuntimeJsonObject {
  reasoningConfig?: BedrockReasoningConfig;
}

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
  bedrock?: BedrockProviderOptions;
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

/**
 * Mirrors `WorkspaceCollectionSyncState` (`@brainstrike/app-state/stores/workspace-collection-sync-status-store`)
 * for this dependency-light wire contract — this package must not import
 * app-state, so the union is duplicated deliberately and must be kept in
 * sync by hand. `unconfigured` (BST-1335): no workspace root has been
 * selected yet; setup is incomplete, not a failure.
 */
export type RuntimeWorkspaceIndexStatusState =
  | 'blocked'
  | 'disabled'
  | 'idle'
  | 'paused'
  | 'recovering'
  | 'unconfigured'
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

/** Renderer-attached opt-in for the self-improvement signal injection (BST-1241). */
export interface SelfImprovementSignalPreferenceRequest {
  readonly enabled?: boolean;
}

/**
 * Renderer-attached experiment enrollment for this run (BST-1250, recursive
 * self-improvement phase 2A). Persisted verbatim in the per-run treatment
 * record so control/intervention runs stay attributable; absent = un-enrolled.
 * The pair is atomic, so both fields are REQUIRED (review: optional fields
 * let a well-behaved producer typecheck its way into a warn loop); the
 * server-side strict parse remains the untrusted-wire guard. The renderer
 * producer is the experiment-assignment preference store (BST-1251, phase
 * 2B): the pair only rides the wire when both fields are set, and absent
 * still means un-enrolled.
 */
export interface ExperimentAssignmentRequest {
  readonly experimentId: string;
  readonly variant: string;
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
  /**
   * Durable DB root identity bound to the selected assistant thread. Desktop
   * validates it against the live server-resolved root inventory before tools
   * use it. When present, native workspace calls that omit `root` resolve to
   * this root; explicit mounted-root selectors remain valid cross-root calls.
   */
  boundWorkspaceRootId?: string;
  callTool?: (
    name: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown) => void }
  ) => Promise<unknown>;
  contextTokenCount?: number;
  embeddingSetId?: string;
  enabledNativeToolIds?: readonly string[];
  experimentAssignment?: ExperimentAssignmentRequest;
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
   * the tool map to risk ∈ {read, mcp} (edit/execute tools are omitted;
   * `submitPlan`/`askUser` survive because they are classified `read`, not
   * because they suspend) and prepends a PLAN-MODE instruction block, so the model
   * investigates and proposes a plan for approval before any changes. Sent over
   * the wire ONLY when `true`, but read the VALUE rather than key presence: the
   * request-lifecycle producer writes the key unconditionally and lets
   * `JSON.stringify` drop an explicit `undefined`. Pinned by "leaves the opt-in
   * keys PRESENT with undefined values" in `use-assistant-request-lifecycle.test.ts`;
   * same shape as `permissionPolicyRequest`, whose declaration in
   * `packages/agent/src/types.ts` carries the full rationale.
   * Excluded for the built-in local provider. Agent-only enforcement.
   */
  planMode?: boolean;
  projectId?: string;
  provider?: 'anthropic' | 'google' | 'local' | 'openai' | 'openrouter' | string;
  providerOptions?: RuntimeProviderOptions;
  /**
   * The user's explicit reasoning-effort selection. Absent means Auto; this is
   * intentionally distinct from providerOptions, which carries the resolved
   * wire effort after catalog defaults/auto profiles are applied.
   */
  requestedReasoningEffort?: OpenAiReasoningEffort;
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
  selfImprovementSignalPreference?: SelfImprovementSignalPreferenceRequest;
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
   * Mid-run steering control (BST-588). IN-MEMORY ONLY, exactly like `signal`:
   * the server injects it after request validation; it never rides the wire.
   * When `stopRequested()` turns true, the agent loop ends the run gracefully
   * at the next step boundary (a `run.steered` event + normal finish) so the
   * queued steer message can dispatch as the next turn on the same thread.
   * Seam is shaped for a future swap onto Mastra's signals `sendMessage`
   * live-delivery once that API graduates from beta.
   */
  steering?: AssistantRunSteeringControl;
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
   * source of truth. An empty array is the authoritative zero-root state.
   * Absent means unresolved/legacy; desktop tools may then use the explicitly
   * focused `workspaceRootPath` compatibility path, but the initial manifest
   * reports the root inventory as unavailable rather than fabricating an id.
   */
  workspaceRoots?: readonly RuntimeWorkspaceRoot[];
}
