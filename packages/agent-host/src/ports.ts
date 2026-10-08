import type { ProviderRequestAccounting } from '@brainstrike/agent/provider-request';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import type { ScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import type {
  McpElicitationPresentationWire,
  McpElicitationSettlement,
  McpHostCloseReport,
  McpHostPort,
  PermissionToolGateSnapshot,
  ToolRiskCategory,
} from '@brainstrike/assistant-contract';
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
import type { HostLoginCredential, HostRunSnapshot } from './protocol.js';

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
}

export interface HostToolContext {
  readonly mcp?: HostMcpExecution | undefined;
  /** Validated committed response to this tool's intrinsic human interaction. */
  readonly resumeData?: unknown;
  readonly runId: string;
  readonly signal: AbortSignal;
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

/** One immutable selection retained across approval legs, never re-read from Settings. */
export interface HostRunAdmission {
  /** Join resources selected before the run is committed, including failed admission. */
  close?(): Promise<void>;
  readonly configuration: Readonly<RuntimeData>;
  /** Present when this run may delegate; its tools are already in `tools`. */
  readonly delegation?: HostDelegation | undefined;
  /** Title an untitled thread's first completed run through this run's model. */
  readonly generatesThreadTitle?: boolean;
  readonly model: LanguageModel;
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  readonly provider?: HostProviderPort;
  readonly snapshot: HostRunSnapshot;
  readonly tools: Readonly<Record<string, HostTool>>;
  /** BST-1932: a read-only child's admission withholds working memory from its run owner. */
  readonly workingMemory?: false;
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
  readonly prompt?: string;
  readonly signal: AbortSignal;
  /** Reopen the committed selection, rejecting changed executors rather than substituting. */
  readonly snapshot?: HostRunSnapshot;
  readonly threadId: string;
  /** Core-owned immutable thread binding; the adapter must resolve its live IDs. */
  readonly workspaceBinding?: ThreadWorkspaceBinding;
}

/** The existing configured authority and its generation-qualified executors. */
export interface HostMcpToolSelection {
  readonly bindings: Readonly<Record<string, McpHostToolBinding>>;
  /** Release this run's borrowed client after its executions and watches join. */
  close(): Promise<void>;
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

/** Credentials and process-local capabilities never become protocol payloads. */
export interface HostPlatform {
  admitRun?(request: HostRunAdmissionRequest): Promise<HostRunAdmission>;
  close(): Promise<void>;
  /** The default admission's delegation capability; `admitRun` sets it per admission. */
  readonly delegation?: HostDelegation | undefined;
  /** The default admission's auto-title capability; `admitRun` sets it per admission. */
  readonly generatesThreadTitles?: boolean | undefined;
  /** Supplied by the existing run configuration, not a second host default. */
  readonly maxSteps?: number | undefined;
  /** Run-scoped construction; cached shared memory must not capture a run signal. */
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  readPermissionPolicy(
    threadId?: string
  ): PermissionToolGateSnapshot | Promise<PermissionToolGateSnapshot>;
  resolveModel?(modelId: string): Promise<LanguageModel>;
  /** Borrowed existing native writer; startup acquires it before interrupted purge replay. */
  readonly stateIndexer?: StateStoreIndexerPort;
  /** The host's own credential store, its single writer; absent where none is owned. */
  storeProviderCredential?(provider: string, credential: HostLoginCredential): Promise<void>;
  readonly tools?: Readonly<Record<string, HostTool>> | undefined;
  validateWorkspaceBinding?(request: {
    readonly binding: ThreadWorkspaceBinding;
    readonly signal: AbortSignal;
    readonly threadId: string;
  }): Promise<void>;
}
export type HostSdkTools = ToolSet;
