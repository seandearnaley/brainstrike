import type { ProviderRequestAccounting } from '@brainstrike/agent/provider-request';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import type {
  ScaledToolResultBudget,
  ScopedToolOutputArtifactReader,
} from '@brainstrike/agent/tool-runtime';
import type {
  McpElicitationPresentationWire,
  McpElicitationSettlement,
  McpHostCloseReport,
  McpHostPort,
  McpHostTaskOwner,
  OpenRouterModelMetadataSnapshot,
  PermissionToolGateSnapshot,
  ProviderCredential,
  ProviderVerificationSnapshot,
  ReferencedFileFailure,
  SkillsScanResultSummary,
  ToolRiskCategory,
  UserSlashCommandsListResult,
} from '@brainstrike/assistant-contract';
import type {
  AssistantContextBreakdown,
  PromptToolCallWindow,
} from '@brainstrike/assistant-contract/context-breakdown';
import type { McpTaskHandle } from '@brainstrike/assistant-contract/mcp-task-presentation';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { RuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';
import type { MemoryRecallTelemetry } from '@brainstrike/assistant-contract/tool-telemetry';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import type {
  FlexibleSchema,
  LanguageModel,
  LanguageModelCallOptions,
  LanguageModelUsage,
  ModelMessage,
  streamText,
  Tool,
  ToolSet,
} from 'ai';
import type { McpHostToolBinding } from './adapters/mcp.ts';
import type { HostMemoryEmbedderIdentity } from './adapters/memory-failure.ts';
import type {
  HostApprovalTargetRoot,
  HostEditOp,
  HostEvent,
  HostHookSkip,
  HostLogRow,
  HostMemoryModels,
  HostObservationalMemoryState,
  HostParams,
  HostResults,
  HostRewindConflict,
  HostRewindFileOutcome,
  HostRunSnapshot,
  HostTurnSnapshot,
  HostTurnSnapshotRoot,
} from './protocol.ts';
import type { GIT_WORKSPACE_METHOD_SCHEMAS, GitWorkspaceEvent } from './protocol-git-workspace.ts';
import type { McpPresentationEvent } from './protocol-mcp-presentation.ts';
import type { McpSettingsEvent } from './protocol-mcp-settings.ts';
import type { TERMINAL_METHOD_SCHEMAS, TerminalEvent } from './protocol-terminals.ts';
import type {
  WORKSPACE_FILES_METHOD_SCHEMAS,
  WorkspaceFilesEvent,
} from './protocol-workspace-files.ts';
import type {
  WORKSPACE_INDEX_METHOD_SCHEMAS,
  WorkspaceIndexEvent,
} from './protocol-workspace-index.ts';
import type { HostStateSearch, HostStateSearchVectors } from './thread-search.ts';

/** One committed tool-output overlay entry (the legacy ToolProjectionRewriteEntry). */
export type HostProjectionRewrite = Extract<
  HostEvent,
  { type: 'tool.projection.rewritten' }
>['rewrites'][number];

/** A memory cycle's committed facts, without the run they belong to (BST-2224). */
export type HostMemoryCycle = Omit<Extract<HostEvent, { type: 'memory.cycle' }>, 'runId' | 'type'>;

/** One committed tool call on a request's branch, with its committed model-facing result. */
export interface HostToolInvocation {
  readonly args: unknown;
  readonly modelOutput: unknown;
  /** The raw committed `effect.finished` output; absent when no effect committed one. */
  readonly output: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface HostProjectionRewriteRequest {
  readonly currentTurnToolCallIds: ReadonlySet<string>;
  /** Branch order, oldest first; calls that already have a committed rewrite are left out. */
  readonly invocations: readonly HostToolInvocation[];
}

/** Private native authority. Validation never resolves or sends an answer. */
export interface HostMcpInputCapability {
  assertCurrent(): Promise<void>;
  readonly presentation: McpElicitationPresentationWire;
  settle(answer: McpElicitationSettlement): Promise<'local-finalized' | 'remote-acknowledged'>;
  readonly signal: AbortSignal;
  validate(answer: McpElicitationSettlement): Promise<void>;
}
export interface HostMcpTaskCapability {
  assertCurrent(): Promise<void>;
  readonly handle: McpTaskHandle;
}
export interface HostMcpExecution {
  /** Joins the Core binding commit before native polling/presentation starts. */
  bindTask(task: HostMcpTaskCapability): Promise<void>;
  /** Joins the safe request commit before any client is notified. */
  requestInput(input: HostMcpInputCapability): Promise<void>;
  /** The thread whose run admitted this call; its deletion erases the call's task rows. */
  readonly threadId: string;
}

/** One file mutation a native tool performs inside an admitted workspace root. */
export interface HostWorkspaceEdit {
  /** Absolute path of the edited file (a rename's destination). */
  readonly absolutePath: string;
  /** Absolute rename source; required for, and only for, `rename`. */
  readonly fromAbsolutePath?: string;
  readonly op: HostEditOp;
  readonly rootId: string;
  /** The absolute root the tool admitted; revert revalidates it with the live root owner. */
  readonly rootPath: string;
}
/** Core-owned attribution: baselines are committed with the edit, in the run log. */
export interface HostWorkspaceEditTracker {
  /** Observe, run `mutate`, then commit the edit (also when `mutate` failed after changing disk). */
  track<T>(edit: HostWorkspaceEdit, mutate: () => Promise<T>): Promise<T>;
}

/** Core-owned per-thread tool state; every write is a committed `tool.state.updated`. */
export interface HostToolState {
  /** The latest committed value of every key starting with `prefix`. */
  entries(prefix: string): readonly (readonly [string, unknown])[];
  read(key: string): unknown;
  /** Atomic per (thread, key): `next` sees the latest committed value; `undefined` writes nothing. */
  update(key: string, next: (current: unknown) => unknown): Promise<void>;
}

/** A worktree a shell command made and the desktop's worktree ledger adopted. */
export interface HostShellWorktree {
  readonly branch: string | null;
  readonly path: string;
  readonly worktreeId: string;
}
/** A worktree a root run's call created, already open as a folder (ADR-0028 step 3). */
export interface HostEnteredWorktree {
  readonly branch: string | null;
  /** The folder the worktree was created from: the person's own checkout. */
  readonly localRootId: string;
  readonly root: { readonly displayName: string; readonly path: string; readonly rootId: string };
  readonly worktreeId: string;
}
export interface HostToolContext {
  /** The thread's committed-output artifact reader, supplied by Core. */
  readonly artifacts?: ScopedToolOutputArtifactReader | undefined;
  /** Present for every Core-dispatched execution; file tools must refuse without it. */
  readonly edits?: HostWorkspaceEditTracker | undefined;
  /**
   * ADR-0028 step 3, a root run's calls only: bind the thread to the worktree
   * this call created. The run ends after this step, and the host starts the
   * thread's next run in the worktree. A child never moves its parent.
   */
  readonly enterWorktree?: ((worktree: HostEnteredWorktree) => Promise<void>) | undefined;
  readonly mcp?: HostMcpExecution | undefined;
  /** Validated committed response to this tool's intrinsic human interaction. */
  readonly resumeData?: unknown;
  readonly runId: string;
  /**
   * The worktrees this call's shell command made, once the desktop's ledger
   * adopts them. Core retains the work in the call's run, so Stop and finish
   * join it, and commits each as `worktree.created` under the call.
   */
  readonly shellWorktrees?: ((adopted: Promise<readonly HostShellWorktree[]>) => void) | undefined;
  readonly signal: AbortSignal;
  /** Present for every Core-dispatched execution; stateful tools must refuse without it. */
  readonly state?: HostToolState | undefined;
  readonly threadId: string;
  readonly toolCallId: string;
  /** Existing native/MCP progress is committed by the run-log owner. */
  readonly write?: (chunk: unknown) => Promise<void>;
}
export interface HostRunContext {
  /**
   * The threads' committed rows that Core's hydration keeps, as Core already
   * decoded them, threads by id and each by seq: the run's Memory history.
   */
  readCommittedRows(threadIds: ReadonlySet<string>): readonly HostLogRow[];
  /**
   * One observation or reflection cycle's facts (BST-2224), committed through
   * HostCore before the run's owner joins, like its spend.
   */
  recordMemoryCycle?(cycle: HostMemoryCycle): Promise<void>;
  /** A typed, committed reason this run received no observational memory. */
  recordObservationWithheld?(reason: 'branched-thread'): Promise<void>;
  /** These receipts append through HostCore, before publication and terminal join. */
  recordObserverUsage?(receipt: {
    readonly kind: 'observation' | 'reflection' | 'embedding';
    readonly modelId: string;
    readonly usage: LanguageModelUsage;
  }): Promise<void>;
  recordProviderRequest?(receipt: {
    readonly accounting: ProviderRequestAccounting;
    readonly breakdown: AssistantContextBreakdown;
    readonly modelId: string;
    readonly provider: string;
    readonly toolCallWindow: PromptToolCallWindow;
  }): Promise<void>;
  /**
   * One semantic recall's diagnostics (BST-2225), sent live on the run's
   * stream as uncommitted `run/telemetry` (ADR-0011 amendment).
   */
  recordRecall?(recall: MemoryRecallTelemetry): void;
  /**
   * A failed semantic recall's typed detail (BST-2202): the turn answers
   * without recall, and Core commits this as the run's notice.
   */
  recordRecallFailed?(detail: string): Promise<void>;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly threadId: string;
  /**
   * BST-1932: false for a read-only persona's child run, which keeps the
   * parent's Memory on its own thread but never reads or writes working memory.
   */
  readonly workingMemory?: false;
}
/** One step's request as the run's Memory selected it. */
export interface HostPreparedStep {
  /**
   * The earlier committed turns (their run ids) whose messages this request
   * holds, from the branch or recalled. Pre-request compaction measures this
   * request, and only this thread's branch turns among them can leave it
   * (ADR-0013): a turn recalled from another thread is that thread's history.
   */
  readonly historyRunIds: ReadonlySet<string>;
  readonly messages: ModelMessage[];
  /**
   * The same step's request reassembled from the committed log after Core
   * committed a compaction, so the compacted turns leave it. Memory's own step
   * preparation and recall do not run again.
   */
  rebuild(): Promise<HostPreparedStep>;
  /**
   * The committed tool-output rewrites the provider request applies to these
   * messages, from every thread the request reads (resource-wide with
   * resource-scoped recall), so the request is measured as it is sent.
   */
  readonly rewrites: ReadonlyMap<string, HostProjectionRewrite>;
  readonly system?: string;
}
/** Fence new work and join every provider, memory, storage and hook tail. */
export interface HostRunOwner {
  close(): Promise<void>;
  /** Native Memory may consume only the step that the host already committed. */
  commitHostStep?(): Promise<void>;
  /**
   * The run's foreground work, joined before its `run.finished`; a
   * HostRunOwnerFailure is the run's outcome. Background work the owner still
   * runs (Mastra's buffered observation) joins in `close`, after the run ends.
   * An owner without it joins its whole `close` before the run ends.
   */
  endTurn?(): Promise<void>;
  /** Enclose the selected concrete model at its final public provider boundary. */
  prepareHostModel?(model: LanguageModel): LanguageModel;
  /** Public Memory context selection before the existing provider request boundary. */
  prepareHostStep?(request: {
    readonly messages: readonly ModelMessage[];
    readonly stepNumber: number;
  }): Promise<HostPreparedStep>;
}

/** Trusted run configuration; credential resolution stays inside the adapter. */
export interface HostProviderRequest {
  readonly configuration: Readonly<RuntimeData>;
  readonly messages: readonly ModelMessage[];
  readonly modelId: string;
  readonly signal: AbortSignal;
  /** The run's step about to start; a child reserves its last step for a summary. */
  readonly stepNumber?: number;
}

export interface HostPreparedModelRequest extends LanguageModelCallOptions {
  /** A step may withhold every tool, as a child's summary step does. */
  readonly activeTools?: string[];
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  readonly providerOptions?: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  readonly system?: string;
  readonly toolChoice?: 'none';
}

/** Shipped provider selection and request hygiene, with no second agent loop. */
export interface HostProviderPort {
  prepare(request: HostProviderRequest): Promise<HostPreparedModelRequest>;
}

/** A lifecycle hook's verdict on one tool call; hooks refine a permitted decision, never widen it. */
export type HostPreToolUseVerdict =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly reason: string };

/** A fresh run's prompt, past its UserPromptSubmit hooks: blocked, or with added context. */
export type HostUserPromptVerdict =
  | { readonly blocked: true; readonly reason: string }
  | { readonly additionalContext?: string; readonly blocked: false };

/** A hook's run verdict, which the host commits as a `hook` label. */
export interface HostHookRunVerdict {
  readonly detail?: string;
  readonly verdict: 'failed' | 'mixed' | 'succeeded';
}

/** The run's user-authored lifecycle hooks, from the composition's hooks configuration. */
export interface HostRunHooks {
  /**
   * Whether a PreToolUse hook would run for this tool (its catalog ID). A
   * provider-executed tool never reaches the approval point where hooks run.
   */
  matchesPreToolUse(toolName: string): boolean;
  /** After a tool ran: a hook may add context the model reads with that result. */
  postToolUse(call: {
    readonly error: boolean;
    readonly input: unknown;
    readonly output: unknown;
    /** The tool's catalog ID, which hook matchers name. */
    readonly toolName: string;
  }): Promise<{ readonly additionalContext?: string }>;
  /** Before a tool the policy would allow or ask about: a hook may block it, with a reason. */
  preToolUse(call: {
    readonly input: unknown;
    /** The tool's catalog ID (`brainstrike.readWorkspaceFile`), which hook matchers name. */
    readonly toolName: string;
  }): Promise<HostPreToolUseVerdict>;
  /** At the run's end, before its terminal row: a hook may label the run with a verdict. */
  stop(end: {
    /** The run's assistant text, tail-bounded, so a hook can grade the final answer. */
    readonly assistantMessage?: string;
    readonly reason: 'aborted' | 'complete' | 'error';
  }): Promise<{ readonly verdict?: HostHookRunVerdict }>;
  /** Before a fresh run's first step: a hook may block the prompt or add context for the run. */
  userPromptSubmit(prompt: string): Promise<HostUserPromptVerdict>;
}

/** One turn boundary of a run, for the platform's workspace snapshot owner. */
export interface HostTurnBoundaryRequest {
  readonly boundary: 'turn-start' | 'turn-end';
  /** The turn-start roots, for the turn's end; at its start the platform reads the run's roots. */
  readonly roots?: readonly HostTurnSnapshotRoot[];
  readonly runId: string;
  readonly threadId: string;
}

/**
 * Hosted tool discovery (the legacy Mastra catalog search): a deferred tool
 * stays off the model's surface until the run commits a `load_tool` for it.
 */
export interface HostToolDiscovery {
  /** The tools the run's next step offers: eager, discovery and loaded, from its committed steps. */
  activeTools(run: { readonly runId: string; readonly threadId: string }): Promise<string[]>;
  /**
   * Its own tools (`search_tools`, `load_tool`, `list_available_tools`). Like
   * legacy's processor-added tools, which joined after the permission gate and
   * so were never in its ask set, they are outside the permission catalog:
   * no policy decision, no prompt and no lifecycle hook.
   */
  readonly toolIds: ReadonlySet<string>;
}

/** One immutable selection retained across approval legs, never re-read from Settings. */
export interface HostRunAdmission {
  /**
   * Snapshot the run's workspace roots at a turn boundary, for its Changes
   * review. A root whose capture failed returns the null object ID; a capture
   * that fails as a whole rejects. Omitted where no snapshot owner exists (CLI).
   */
  readonly captureTurnBoundary?: (
    request: HostTurnBoundaryRequest
  ) => Promise<readonly HostTurnSnapshot[]>;
  /**
   * BST-1932: the host-supplied context (date, skills, workspace instructions)
   * a delegated child receives beside its persona instructions; never the
   * root's supervisor instructions.
   */
  readonly childSystem?: string | undefined;
  /** Join resources selected before the run is committed, including failed admission. */
  close?(): Promise<void>;
  readonly configuration: Readonly<RuntimeData>;
  /** Present when this run may delegate; its tools are already in `tools`. */
  readonly delegation?: HostDelegation | undefined;
  /** Present when the run defers tools behind discovery; its tools include the discovery tools. */
  readonly discovery?: HostToolDiscovery | undefined;
  /** Title an untitled thread's first completed run through this run's model. */
  readonly generatesThreadTitle?: boolean;
  /** The hook files the composition did not load for this run; Core commits them visibly. */
  readonly hookSkips?: readonly HostHookSkip[] | undefined;
  /** Present only when the composition loaded at least one hook for this run. */
  readonly hooks?: HostRunHooks | undefined;
  /** The selected provider input budget; host compaction keeps requests inside it. */
  readonly inputTokenLimit?: number | undefined;
  /** The observer and embedder this admission's memory uses, for `thread/memory/read`. */
  readonly memoryModels?: HostMemoryModels;
  readonly model: LanguageModel;
  /**
   * The resolved provider's own web search (Anthropic, OpenAI), built with the
   * run's provider auth. Core swaps it in for the catalog web search only when
   * that tool resolves to `allow` at admission; it has no local execute.
   */
  readonly nativeWebSearch?: Tool;
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  readonly provider?: HostProviderPort;
  /**
   * Observational memory as this admission configures it, with the thread's
   * committed record when it is on. Absent means off.
   */
  readObservation?(threadId: string): Promise<HostObservationalMemoryState>;
  readonly referencedFileFailures?: readonly ReferencedFileFailure[];
  /**
   * The tool-result budget this run's model was selected with, as the
   * projection owner resolved it. The effect commit needs it to tell an MCP
   * result that merely exceeds the model budget from one that fits. Absent on
   * a platform that registers its own tools directly, which projects them
   * unbounded — there is no clipping to recover from there. It stays out of
   * the ledger on purpose: the decision is committed, not the input it was
   * made from, so a later change to the budget constants cannot re-answer a
   * question an already-committed output settled.
   */
  readonly resolvedToolResultBudget?: ScaledToolResultBudget;
  readonly snapshot: HostRunSnapshot;
  readonly tools: Readonly<Record<string, HostTool>>;
  /** Configured MCP servers this run proceeds without; committed with `run.started`. */
  readonly unavailableMcpServers?: readonly HostMcpUnavailableServer[];
  /** BST-1932: a read-only child's admission withholds working memory from its run owner. */
  readonly workingMemory?: false;
}

/** The host's single credential writer and token holder. */
export interface HostAuthService {
  clear(): Promise<boolean>;
  deleteCredential(account: string): Promise<boolean>;
  /** A Settings-namespace entry under its existing account (provider, tool or MCP key). */
  setCredential(account: string, credential: ProviderCredential): Promise<void>;
  /** A provider login, validated against the provider's authentication form. */
  storeProviderCredential(provider: string, credential: ProviderCredential): Promise<void>;
}

/**
 * The transport a run-admitting command arrived on. `desktop-ui` is only a port
 * the launching desktop handed over its private parent channel; every public
 * socket client (the CLI included) is `public-socket`. Absent means no live
 * client admitted it (restart recovery).
 */
export type HostClientOrigin = 'desktop-ui' | 'public-socket';

export interface HostRunAdmissionRequest {
  /** Canonical non-secret UI settings/context captured with this input command. */
  readonly configuration?: HostRunSnapshot['configuration'];
  readonly modelId: string;
  /** The admitting client's transport; capabilities bound to an origin refuse others. */
  readonly origin?: HostClientOrigin;
  /** Plan mode: admit only what reads and proposes a plan, and say so to the model. */
  readonly planMode?: true;
  readonly prompt?: string;
  /**
   * The run this admission is for, minted before admission and committed with
   * its run.started (a reopen passes the committed run's). A platform keys what
   * it binds at admission by it, so a child borrowing this admission and the
   * thread's next run never share one platform selection.
   */
  readonly runId: string;
  readonly signal: AbortSignal;
  /** Reopen the committed selection, rejecting changed executors rather than substituting. */
  readonly snapshot?: HostRunSnapshot;
  readonly threadId: string;
  /** Core-owned immutable thread binding; the adapter must resolve its live IDs. */
  readonly workspaceBinding?: ThreadWorkspaceBinding;
}

/**
 * What a run would be admitted with, before any run exists: an admission
 * request without its run. thread/memory/read evaluates preconditions on it.
 */
export type HostRunIntentRequest = Omit<HostRunAdmissionRequest, 'runId'>;

/** A configured MCP server whose tools a run proceeds without, and why. */
export interface HostMcpUnavailableServer {
  readonly reason: string;
  readonly serverId: string;
}

/** The existing configured authority and its generation-qualified executors. */
export interface HostMcpToolSelection {
  readonly bindings: Readonly<Record<string, McpHostToolBinding>>;
  /** Release this run's borrowed client after its executions and watches join. */
  close(): Promise<void>;
  /** Servers whose discovery failed; Core commits each with the run's start. */
  readonly unavailable: readonly HostMcpUnavailableServer[];
}
export interface HostMcpToolRequest {
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  readonly snapshot?: HostRunSnapshot;
  readonly toolTimeoutMs: number;
}
/** An MCP App's own tool call, once Core admitted it under the thread's policy. */
export interface HostMcpAppToolCall {
  readonly arguments: import('./protocol.ts').HostParams<'mcp/app/call'>['arguments'];
  readonly serverId: string;
  readonly toolName: string;
}
export interface HostMcpRuntime {
  /** Core's ownership of its recovered tasks, supplied once when Core opens (BST-1930 c3). */
  attachTaskOwner?(owner: McpHostTaskOwner): void;
  readonly authority: McpHostPort;
  /** One `tools/call` on the app's server; a created task goes to the task authority. */
  callAppTool(call: HostMcpAppToolCall, signal: AbortSignal): Promise<unknown>;
  close(): Promise<McpHostCloseReport>;
  executableTools(request: HostMcpToolRequest): Promise<HostMcpToolSelection>;
}
/**
 * BST-1932: the personas a run may delegate to and the user's subagent limits,
 * resolved by the existing settings owner for this admission. HostCore owns
 * the `agent-<persona>` tools built from it and dispatches them itself.
 */
export interface HostDelegation {
  readonly personas: readonly AssistantPersonaDefinition[];
  readonly settings: RuntimeSubagentSettings;
}

export interface HostTool {
  /**
   * BST-1990 (D4): the workspace folder this call targets, through the same
   * resolution the tool's execute uses; undefined when the call names a folder
   * the run cannot use (its execute refuses it). Core commits it on the call's
   * approval request so the card names the folder.
   */
  readonly approvalTarget?: (input: unknown) => HostApprovalTargetRoot | undefined;
  /**
   * BST-1178: the web origin this call opens. A person answers the first call
   * to each origin; their Always allow or Don't allow is saved by the host and
   * answers every later call to it. Undefined where the call names no origin
   * it could open (its execute refuses the URL).
   */
  readonly browserOrigin?: (input: unknown) => string | undefined;
  /**
   * Whether this call's own input asks for network a person must allow, per
   * call, before it executes (run_python's requested domains). Never remembered
   * and never answered by a grant or policy.
   */
  readonly consent?: (input: unknown) => boolean;
  /**
   * A system note this tool contributes before each step, from its thread's
   * committed tool state (the legacy `<current-task-list>` re-injection).
   */
  readonly contextNote?: (state: Pick<HostToolState, 'entries' | 'read'>) => string | undefined;
  /** HostCore-dispatched persona delegation; `execute` is never called for it. */
  readonly delegation?: AssistantPersonaDefinition;
  readonly description: string;
  execute(input: unknown, context: HostToolContext): Promise<unknown>;
  /** Existing executor/server-generation identity, bound into pending decisions. */
  readonly identity: string;
  readonly inputSchema: FlexibleSchema<unknown>;
  readonly interaction?: {
    readonly kind: 'question' | 'plan';
    readonly resumeSchema: FlexibleSchema<unknown>;
  };
  readonly mcpAuthority?: import('./protocol.ts').McpToolAuthority;
  /** Existing configured owner, supplied directly rather than parsed from a tool name. */
  readonly mcpBinding?: { readonly configuredServerId: string; readonly generation: number };
  /** Existing catalog ID used by Settings policy, before provider-name sanitization. */
  readonly permissionToolId?: string;
  /** Tool-owned recovery of runtime meaning that JSON cannot retain. */
  reconstructApprovalInput?(rawInput: unknown): Promise<unknown>;
  readonly risk: ToolRiskCategory;
  readonly strict?: boolean;
  readonly toModelOutput?: Tool<unknown, unknown>['toModelOutput'];
}

/**
 * Provider reads a client makes by id: availability, a credential probe and
 * OpenRouter model metadata. Keys resolve inside the host and never cross.
 */
/** What `memory/embedder/probe` asks a platform to resolve (BST-2227). */
export interface HostMemoryEmbedderRequest {
  /** The client's Assistant Memory settings, as a run's configuration carries them. */
  readonly memorySettings: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}
/** A resolved memory embedder and the identity its failures name. */
export interface HostMemoryEmbedderTarget {
  readonly embedder: MastraEmbeddingModel<string>;
  readonly identity: HostMemoryEmbedderIdentity;
}
export interface HostProviderService {
  /** `signal` is the request's: its abort cancels this caller's network wait with its reason. */
  openRouterModel(modelId: string, signal: AbortSignal): Promise<OpenRouterModelMetadataSnapshot>;
  /** The availability payload Settings and the assistant panel gate on. */
  status(): Promise<Readonly<Record<string, unknown>>>;
  verify(provider: string, signal: AbortSignal): Promise<ProviderVerificationSnapshot>;
}

/**
 * ADR-0029 stage 2: the skills and user slash commands on the platform's live
 * roots and home directory, for the Settings panel and the composer's "/" menu.
 */
export interface HostWorkspaceDiscovery {
  commands(signal: AbortSignal): Promise<UserSlashCommandsListResult>;
  skills(signal: AbortSignal): Promise<SkillsScanResultSummary>;
}

/** The git cluster's request methods; `workspace/git/subscribe` is the connection's own. */
export type HostGitWorkspaceMethod = Exclude<
  keyof typeof GIT_WORKSPACE_METHOD_SCHEMAS,
  'workspace/git/subscribe'
>;

/**
 * ADR-0029 stage 2: the desktop's git cluster (the git panel, Changes, forge
 * pull-request awareness and managed worktrees), owned by the host that owns
 * the workspace catalog. Each method answers its own wire method.
 */
export type HostGitWorkspaceMethods = {
  readonly [M in HostGitWorkspaceMethod]: (
    params: HostParams<M>,
    signal: AbortSignal
  ) => Promise<HostResults[M]>;
};
export type HostGitWorkspace = HostGitWorkspaceMethods & {
  /** Repository and pull-request changes, for every subscribed client. */
  subscribe(listener: (event: GitWorkspaceEvent) => void): () => void;
};

type HostTerminalWireMethod = keyof typeof TERMINAL_METHOD_SCHEMAS;
export type HostTerminalMethod = Extract<HostTerminalWireMethod, `terminal/${string}`>;
export type HostCommandSessionMethod = Extract<
  HostTerminalWireMethod,
  `command-sessions/${string}`
>;

export type HostTerminalSessionMethods = {
  readonly [M in HostTerminalMethod]: (params: HostParams<M>) => Promise<HostResults[M]>;
};
export type HostCommandSessionMethods = {
  readonly [M in HostCommandSessionMethod]: (params: HostParams<M>) => Promise<HostResults[M]>;
};

/** One client's terminals: their events go only to it, and they end when it closes. */
export type HostTerminalSession = HostTerminalSessionMethods & {
  /** Ends every terminal this client started and joins their exits. */
  close(): Promise<void>;
};

/**
 * ADR-0029 stage 3: the Terminal panel's interactive terminals and the
 * inventory of the command sessions the host's runs start.
 */
export type HostTerminals = HostCommandSessionMethods & {
  /** Opens one client's terminals; each of their events goes to `send`. */
  open(send: (event: TerminalEvent) => void): HostTerminalSession;
};

type HostWorkspaceFilesWireMethod = keyof typeof WORKSPACE_FILES_METHOD_SCHEMAS;
/** The watch methods, whose watchers belong to the client that started them. */
export type HostWorkspaceWatchMethod = Extract<
  HostWorkspaceFilesWireMethod,
  'files/unwatch' | 'files/watch' | 'files/watch-retry'
>;
export type HostWorkspaceFileMethod = Exclude<
  HostWorkspaceFilesWireMethod,
  HostWorkspaceWatchMethod
>;
export type HostWorkspaceWatchSessionMethods = {
  readonly [M in HostWorkspaceWatchMethod]: (params: HostParams<M>) => Promise<HostResults[M]>;
};
export type HostWorkspaceFileMethods = {
  readonly [M in HostWorkspaceFileMethod]: (params: HostParams<M>) => Promise<HostResults[M]>;
};

/** One client's watchers: their events go only to it, and they stop when it closes. */
export type HostWorkspaceWatchSession = HostWorkspaceWatchSessionMethods & {
  /** Stops every watcher this client started and joins their native retirement. */
  close(): Promise<void>;
};

/**
 * ADR-0029 stage 4: the desktop's workspace folders, Explorer reads and
 * watchers, over the one root registry the host's tools and index borrow.
 */
export type HostWorkspaceFiles = HostWorkspaceFileMethods & {
  /** Opens one client's watchers; each of their events goes to `send`. */
  open(send: (event: WorkspaceFilesEvent) => void): HostWorkspaceWatchSession;
};

/** The index's request methods; `index/subscribe` is the connection's own. */
export type HostWorkspaceIndexMethod = Exclude<
  keyof typeof WORKSPACE_INDEX_METHOD_SCHEMAS,
  'index/subscribe'
>;
export type HostWorkspaceIndexMethods = {
  readonly [M in HostWorkspaceIndexMethod]: (params: HostParams<M>) => Promise<HostResults[M]>;
};

/**
 * ADR-0029 stage 4: the desktop's native search index (Search, coverage, a
 * file's chunks, rebuild and retry) and its saved settings. Each method
 * answers its own wire method.
 */
export type HostWorkspaceIndex = HostWorkspaceIndexMethods & {
  /** Lifecycle and settings changes, for every subscribed client. */
  subscribe(listener: (event: WorkspaceIndexEvent) => void): () => void;
};

/** Core's reads of its threads, for a platform service that asks which runs are live. */
export interface HostThreadReads {
  listThreads(): HostResults['thread/list']['threads'];
  read(threadId: string, fromSeq: number): Promise<HostLogRow[]>;
  readLedger(): HostResults['ledger/read'];
}

/**
 * The desktop host's MCP settings authority (BST-1930 c5a): the config file, the
 * global extension dials, and the discovered tools with their saved preferences.
 * It also reports the runtime's server status and runs lifecycle control (c5b).
 */
export interface HostMcpSettingsService {
  configPath(): Promise<HostResults['mcp/config/path']>;
  configStatus(): Promise<HostResults['mcp/config/status']>;
  /** A connect, disconnect or reauthorize also reloads the discovered tools. */
  control(request: HostParams<'mcp/server/control'>): Promise<HostResults['mcp/server/control']>;
  createSampleConfig(): Promise<HostResults['mcp/config/sample']>;
  extensions(): Promise<HostResults['mcp/extensions/read']>;
  /** Appends one catalog server to the profile's config, storing its token when it has one. */
  installCatalogServer(
    request: HostParams<'mcp/config/install'>
  ): Promise<HostResults['mcp/config/install']>;
  readConfigText(): Promise<HostResults['mcp/config/read']>;
  reloadToolPreferences(): Promise<void>;
  resetTools(): Promise<void>;
  setConfigPath(
    request: HostParams<'mcp/config/path/set'>
  ): Promise<HostResults['mcp/config/path/set']>;
  setExtensions(
    request: HostParams<'mcp/extensions/set'>
  ): Promise<HostResults['mcp/extensions/set']>;
  setServerToolsEnabled(request: HostParams<'mcp/tools/server/set'>): Promise<void>;
  setToolsEnabled(request: HostParams<'mcp/tools/set'>): Promise<void>;
  snapshot(): Promise<HostResults['mcp/settings/subscribe']>;
  status(): HostResults['mcp/status/read'];
  /** Every later settings and status change; the returned function stops them. */
  subscribe(listener: (event: McpSettingsEvent) => void): () => void;
  toolStats(): Promise<HostResults['mcp/tools/stats']>;
  tools(): Promise<HostResults['mcp/tools/list']>;
  writeConfigText(
    request: HostParams<'mcp/config/write'>
  ): Promise<HostResults['mcp/config/write']>;
}

/**
 * The desktop's MCP content browsing (BST-1930 c5d): one connected server
 * generation's resource body, prompt messages or argument completions. A
 * refusal answers in the content taxonomy, never with a server's own text.
 */
export interface HostMcpContentService {
  complete(
    request: HostParams<'mcp/content/complete'>
  ): Promise<HostResults['mcp/content/complete']>;
  prompt(request: HostParams<'mcp/content/prompt'>): Promise<HostResults['mcp/content/prompt']>;
  read(request: HostParams<'mcp/content/read'>): Promise<HostResults['mcp/content/read']>;
}

/**
 * The desktop's MCP presentations (BST-1930 c5c): durable Tasks status cards
 * and their actions, and server input no run owns. Its windows read, answer
 * and follow them; only one presenter shows server input, and it stays
 * attached once a window first follows it.
 */
export interface HostMcpPresentationService {
  act(request: HostParams<'mcp/tasks/act'>): Promise<HostResults['mcp/tasks/act']>;
  settle(settlement: HostParams<'mcp/elicitation/settle'>): Promise<void>;
  /** Every later task change and server input; the returned function stops them. */
  subscribe(listener: (event: McpPresentationEvent) => void): () => void;
  tasks(): HostResults['mcp/tasks/list'];
}

/** Credentials and process-local capabilities never become protocol payloads. */
/**
 * The platform's snapshot owner restores a thread's roots for a rewind
 * (restore to before a message) and its redo. Core decides what to restore
 * and commits each intent before any file changes; the owner fingerprints,
 * restores and revalidates each root against its live owner.
 */
export interface HostRewindFiles {
  /** Restore each root to its target snapshot, after a pre-revert snapshot keyed by `rewindId`. */
  apply(request: {
    readonly previewId: string;
    readonly rewindId: string;
    readonly targets: readonly HostTurnSnapshot[];
    readonly threadId: string;
  }): Promise<readonly HostRewindFileOutcome[]>;
  /** The paths that changed since the preview; nothing changes. */
  drift(request: {
    readonly previewId: string;
    readonly threadId: string;
  }): Promise<readonly HostRewindConflict[]>;
  /** Fingerprint the target roots' live files for a preview; nothing changes. */
  preview(request: {
    readonly targets: readonly HostTurnSnapshot[];
    readonly threadId: string;
  }): Promise<{ readonly previewId: string }>;
  /** Restore each root's pre-revert snapshot for `rewindId`; acknowledged paths are forced. */
  redo(request: {
    readonly acknowledged: readonly HostRewindConflict[];
    readonly rewindId: string;
    readonly targets: readonly HostTurnSnapshot[];
    readonly threadId: string;
  }): Promise<readonly HostRewindFileOutcome[]>;
  /** The paths that changed since the rewind restored them; nothing changes. */
  redoConflicts(request: {
    readonly rewindId: string;
    readonly targets: readonly HostTurnSnapshot[];
    readonly threadId: string;
  }): Promise<readonly HostRewindConflict[]>;
}

export interface HostPlatform {
  admitRun?(request: HostRunAdmissionRequest): Promise<HostRunAdmission>;
  /**
   * Core hands the MCP runtime its ownership of the durable tasks its runs
   * bound, when it opens and before any run can discover MCP tools (BST-1930 c3).
   */
  attachMcpTaskOwner?(owner: McpHostTaskOwner): void;
  /** Core hands its thread reads to the platform once it has hydrated them. */
  attachThreadReads?(reads: HostThreadReads): void;
  /** The host's credential authority; absent where the host owns no credential store. */
  readonly auth?: HostAuthService;
  /**
   * A content clear: the derived state this platform keeps beside the store (the desktop's
   * workspace index and its folder bookkeeping) retires before Core closes and the store clears.
   */
  clearRetainedContent?(): Promise<void>;
  close(): Promise<void>;
  /** The default admission's delegation capability; `admitRun` sets it per admission. */
  readonly delegation?: HostDelegation | undefined;
  /** The desktop's workspace folders, Explorer reads and watchers; absent in the CLI. */
  readonly files?: HostWorkspaceFiles;
  /** Purge process-local caches scoped to a thread Core just deleted. */
  forgetThread?(threadId: string): void;
  /** The default admission's auto-title capability; `admitRun` sets it per admission. */
  readonly generatesThreadTitles?: boolean | undefined;
  /** The desktop's git cluster; absent where the host owns no workspace git (the CLI). */
  readonly gitWorkspace?: HostGitWorkspace;
  /** The desktop's native search index and its settings; absent in the CLI. */
  readonly index?: HostWorkspaceIndex;
  /** Supplied by the existing run configuration, not a second host default. */
  readonly maxSteps?: number | undefined;
  /** Runs the MCP App tool calls Core admits; absent where the host has no MCP. */
  readonly mcp?: Pick<HostMcpRuntime, 'callAppTool'> | undefined;
  /** The desktop's MCP content browsing; absent where no window browses content. */
  readonly mcpContent?: HostMcpContentService;
  /** The desktop's MCP Tasks cards and server input; absent where no window presents them. */
  readonly mcpPresentation?: HostMcpPresentationService;
  /** The desktop's MCP settings authority; absent where the host owns no MCP config. */
  readonly mcpSettings?: HostMcpSettingsService;
  /** Run-scoped construction; cached shared memory must not capture a run signal. */
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  /** Provider reads from the host's own store; absent where it owns none. */
  readonly providers?: HostProviderService;
  /**
   * thread/memory/read: the admission's pure preconditions for this request
   * (no acquisition, MCP discovery or model warmup) and the observation they
   * configure for `threadId`. Absent where the host has no composer.
   */
  readMemoryReadiness?(
    request: HostRunIntentRequest,
    threadId: string
  ): Promise<HostResults['thread/memory/read']>;
  readPermissionPolicy(
    threadId?: string
  ): PermissionToolGateSnapshot | Promise<PermissionToolGateSnapshot>;
  /**
   * BST-2227 `memory/embedder/probe`: the embedder these memory settings
   * select, resolved and credentialed as a run's admission resolves it, with
   * the identity its failures are read against. Absent where the host has no
   * composer.
   */
  resolveMemoryEmbedder?(request: HostMemoryEmbedderRequest): Promise<HostMemoryEmbedderTarget>;
  resolveModel?(modelId: string): Promise<LanguageModel>;
  /**
   * The live absolute path of a mounted workspace root, for revert
   * revalidation. Rejects an unknown root; absence refuses `checkpoint/revert`.
   */
  resolveWorkspaceRoot?(request: {
    readonly rootId: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
  /** The snapshot owner's rewind restores; absent where none exists (the CLI). */
  readonly rewindFiles?: HostRewindFiles | undefined;
  /** Gap 10: the host's derived state index search, for `thread/search`. */
  readonly searchState?: HostStateSearch;
  /** The semantic arm's index operations, for `thread/search` and its backlog methods. */
  readonly searchStateVectors?: HostStateSearchVectors;
  /** Read scoped source text from the composing platform's existing native index. */
  searchWorkspace?(
    request: HostParams<'workspace/search'>,
    signal: AbortSignal
  ): Promise<HostResults['workspace/search']>;
  /** The native-tool output rewrite policy; Core commits what it selects. */
  selectProjectionRewrites?(
    request: HostProjectionRewriteRequest
  ): readonly HostProjectionRewrite[];
  /** Borrowed existing native writer; startup acquires it before interrupted purge replay. */
  readonly stateIndexer?: StateStoreIndexerPort;
  /** The desktop's Terminal panel; absent where no window opens terminals (the CLI). */
  readonly terminals?: HostTerminals;
  readonly tools?: Readonly<Record<string, HostTool>> | undefined;
  validateWorkspaceBinding?(request: {
    readonly binding: ThreadWorkspaceBinding;
    /**
     * The run being admitted, when this checks an admission: the platform
     * revalidates that run's selection. A binding update names no run.
     */
    readonly runId?: string;
    readonly signal: AbortSignal;
    readonly threadId: string;
  }): Promise<void>;
  /** Skills and user slash commands on the live roots; absent where the host has none. */
  readonly workspaceDiscovery?: HostWorkspaceDiscovery;
}
export type HostSdkTools = ToolSet;
