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
  OpenRouterModelMetadataSnapshot,
  PermissionToolGateSnapshot,
  ProviderAuthStartMethod,
  ProviderAuthStatus,
  ProviderVerificationSnapshot,
  ToolRiskCategory,
} from '@brainstrike/assistant-contract';
import type { AssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import type { McpTaskHandle } from '@brainstrike/assistant-contract/mcp-task-presentation';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { RuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';
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
import type { McpHostToolBinding } from './adapters/mcp.js';
import type { HostAuthVerdict } from './auth-wire.js';
import type {
  HostEditOp,
  HostEvent,
  HostLegacyImport,
  HostLoginCredential,
  HostRunSnapshot,
} from './protocol.js';

/** One committed tool-output overlay entry (the legacy ToolProjectionRewriteEntry). */
export type HostProjectionRewrite = Extract<
  HostEvent,
  { type: 'tool.projection.rewritten' }
>['rewrites'][number];

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

export interface HostToolContext {
  /** The thread's committed-output artifact reader, supplied by Core. */
  readonly artifacts?: ScopedToolOutputArtifactReader | undefined;
  /** Present for every Core-dispatched execution; file tools must refuse without it. */
  readonly edits?: HostWorkspaceEditTracker | undefined;
  readonly mcp?: HostMcpExecution | undefined;
  /** Validated committed response to this tool's intrinsic human interaction. */
  readonly resumeData?: unknown;
  readonly runId: string;
  readonly signal: AbortSignal;
  /** Present for every Core-dispatched execution; stateful tools must refuse without it. */
  readonly state?: HostToolState | undefined;
  readonly threadId: string;
  readonly toolCallId: string;
  /** Existing native/MCP progress is committed by the run-log owner. */
  readonly write?: (chunk: unknown) => Promise<void>;
}
export interface HostRunContext {
  /** A typed, committed reason this run received no observational memory. */
  recordObservationWithheld?(reason: 'branched-thread'): Promise<void>;
  /** These receipts append through HostCore, before publication and terminal join. */
  recordObserverUsage?(receipt: {
    readonly kind: 'observation' | 'reflection';
    readonly modelId: string;
    readonly usage: LanguageModelUsage;
  }): Promise<void>;
  recordProviderRequest?(receipt: {
    readonly accounting: ProviderRequestAccounting;
    readonly breakdown: AssistantContextBreakdown;
    readonly modelId: string;
    readonly provider: string;
  }): Promise<void>;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly threadId: string;
  /**
   * BST-1932: false for a read-only persona's child run, which keeps the
   * parent's Memory on its own thread but never reads or writes working memory.
   */
  readonly workingMemory?: false;
}
/** Fence new work and join every provider, memory, storage and hook tail. */
export interface HostRunOwner {
  close(): Promise<void>;
  /** Native Memory may consume only the step that the host already committed. */
  commitHostStep?(): Promise<void>;
  /** Enclose the selected concrete model at its final public provider boundary. */
  prepareHostModel?(model: LanguageModel): LanguageModel;
  /** Public Memory context selection before the existing provider request boundary. */
  prepareHostStep?(request: {
    readonly messages: readonly ModelMessage[];
    readonly stepNumber: number;
  }): Promise<{ readonly messages: ModelMessage[]; readonly system?: string }>;
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

/** The run's user-authored lifecycle hooks, from the composition's hooks configuration. */
export interface HostRunHooks {
  /**
   * Whether a PreToolUse hook would run for this tool (its catalog ID). A
   * provider-executed tool never reaches the approval point where hooks run.
   */
  matchesPreToolUse(toolName: string): boolean;
  /** Before a tool the policy would allow or ask about: a hook may block it, with a reason. */
  preToolUse(call: {
    readonly input: unknown;
    /** The tool's catalog ID (`brainstrike.readWorkspaceFile`), which hook matchers name. */
    readonly toolName: string;
  }): Promise<HostPreToolUseVerdict>;
}

/** One immutable selection retained across approval legs, never re-read from Settings. */
export interface HostRunAdmission {
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
  /** Title an untitled thread's first completed run through this run's model. */
  readonly generatesThreadTitle?: boolean;
  /** Present only when the composition loaded at least one hook for this run. */
  readonly hooks?: HostRunHooks | undefined;
  /** The selected provider input budget; host compaction keeps requests inside it. */
  readonly inputTokenLimit?: number | undefined;
  readonly model: LanguageModel;
  /**
   * The resolved provider's own web search (Anthropic, OpenAI), built with the
   * run's provider auth. Core swaps it in for the catalog web search only when
   * that tool resolves to `allow` at admission; it has no local execute.
   */
  readonly nativeWebSearch?: Tool;
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  readonly provider?: HostProviderPort;
  readonly snapshot: HostRunSnapshot;
  readonly tools: Readonly<Record<string, HostTool>>;
  /** Configured MCP servers this run proceeds without; committed with `run.started`. */
  readonly unavailableMcpServers?: readonly HostMcpUnavailableServer[];
  /** BST-1932: a read-only child's admission withholds working memory from its run owner. */
  readonly workingMemory?: false;
}

/**
 * The host's single credential writer, token holder and OAuth refresher.
 * `connect` and subscription use require the private desktop origin.
 */
export interface HostAuthService {
  cancel(provider: string): Promise<ProviderAuthStatus>;
  clear(): Promise<boolean>;
  /** `openExternal` asks the requesting client to open the sign-in page. */
  connect(
    provider: string,
    method: ProviderAuthStartMethod | undefined,
    origin: HostClientOrigin | undefined,
    openExternal: (url: string) => Promise<void>
  ): Promise<ProviderAuthStatus>;
  deleteCredential(account: string): Promise<boolean>;
  disconnect(provider: string): Promise<ProviderAuthStatus>;
  /** Idempotent; settles every credential use a launch-declared pending import holds. */
  importLegacy(
    input: HostLegacyImport
  ): Promise<{ readonly alreadyPresent: number; readonly migrated: number }>;
  /** A Settings-namespace entry under its existing account (provider, tool or MCP key). */
  setCredential(account: string, credential: HostLoginCredential): Promise<void>;
  status(provider: string): Promise<ProviderAuthStatus>;
  /** A provider login, validated against the provider's authentication form. */
  storeProviderCredential(provider: string, credential: HostLoginCredential): Promise<void>;
  /** Refresh-aware session liveness through the one refresher; never a token. */
  verify(provider: string): Promise<HostAuthVerdict>;
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
  readonly signal: AbortSignal;
  /** Reopen the committed selection, rejecting changed executors rather than substituting. */
  readonly snapshot?: HostRunSnapshot;
  readonly threadId: string;
  /** Core-owned immutable thread binding; the adapter must resolve its live IDs. */
  readonly workspaceBinding?: ThreadWorkspaceBinding;
}

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
export interface HostMcpRuntime {
  readonly authority: McpHostPort;
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
  readonly mcpAuthority?: import('./protocol.js').McpToolAuthority;
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
export interface HostProviderService {
  openRouterModel(modelId: string): Promise<OpenRouterModelMetadataSnapshot>;
  /** The availability payload Settings and the assistant panel gate on. */
  status(): Promise<Readonly<Record<string, unknown>>>;
  /** A subscription probe needs the desktop origin, like a subscription run. */
  verify(provider: string, origin: HostClientOrigin): Promise<ProviderVerificationSnapshot>;
}

/** Credentials and process-local capabilities never become protocol payloads. */
export interface HostPlatform {
  admitRun?(request: HostRunAdmissionRequest): Promise<HostRunAdmission>;
  /** The host's credential authority; absent where the host owns no credential store. */
  readonly auth?: HostAuthService;
  close(): Promise<void>;
  /** The default admission's delegation capability; `admitRun` sets it per admission. */
  readonly delegation?: HostDelegation | undefined;
  /** Purge process-local caches scoped to a thread Core just deleted. */
  forgetThread?(threadId: string): void;
  /** The default admission's auto-title capability; `admitRun` sets it per admission. */
  readonly generatesThreadTitles?: boolean | undefined;
  /** Supplied by the existing run configuration, not a second host default. */
  readonly maxSteps?: number | undefined;
  /** Run-scoped construction; cached shared memory must not capture a run signal. */
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  /** Provider reads from the host's own store; absent where it owns none. */
  readonly providers?: HostProviderService;
  readPermissionPolicy(
    threadId?: string
  ): PermissionToolGateSnapshot | Promise<PermissionToolGateSnapshot>;
  resolveModel?(modelId: string): Promise<LanguageModel>;
  /**
   * The live absolute path of a mounted workspace root, for revert
   * revalidation. Rejects an unknown root; absence refuses `checkpoint/revert`.
   */
  resolveWorkspaceRoot?(request: {
    readonly rootId: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
  /** The native-tool output rewrite policy; Core commits what it selects. */
  selectProjectionRewrites?(
    request: HostProjectionRewriteRequest
  ): readonly HostProjectionRewrite[];
  /** Borrowed existing native writer; startup acquires it before interrupted purge replay. */
  readonly stateIndexer?: StateStoreIndexerPort;
  readonly tools?: Readonly<Record<string, HostTool>> | undefined;
  validateWorkspaceBinding?(request: {
    readonly binding: ThreadWorkspaceBinding;
    readonly signal: AbortSignal;
    readonly threadId: string;
  }): Promise<void>;
}
export type HostSdkTools = ToolSet;
