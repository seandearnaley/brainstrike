import type { ProviderRequestAccounting } from '@brainstrike/agent/provider-request';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import type { ScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import type {
  McpHostCloseReport,
  McpHostPort,
  PermissionToolGateSnapshot,
  ToolRiskCategory,
} from '@brainstrike/assistant-contract';
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
import type { HostRunSnapshot } from './protocol.js';

export interface HostToolContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly toolCallId: string;
  /** Existing native/MCP progress is committed by the run-log owner. */
  readonly write?: (chunk: unknown) => Promise<void>;
}
export interface HostRunContext {
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
}

export interface HostPreparedModelRequest extends LanguageModelCallOptions {
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  readonly providerOptions?: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  readonly system?: string;
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
  readonly model: LanguageModel;
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  readonly provider?: HostProviderPort;
  readonly snapshot: HostRunSnapshot;
  readonly tools: Readonly<Record<string, HostTool>>;
}

export interface HostRunAdmissionRequest {
  readonly modelId: string;
  readonly signal: AbortSignal;
  /** Reopen the committed selection, rejecting changed executors rather than substituting. */
  readonly snapshot?: HostRunSnapshot;
  readonly threadId: string;
}

/** The existing configured authority and its generation-qualified executors. */
export interface HostMcpToolSelection {
  readonly bindings: Readonly<Record<string, McpHostToolBinding>>;
  /** Release this run's borrowed client after its executions and watches join. */
  close(): Promise<void>;
}
export interface HostMcpToolRequest {
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  readonly toolTimeoutMs: number;
}
export interface HostMcpRuntime {
  readonly authority: McpHostPort;
  close(): Promise<McpHostCloseReport>;
  executableTools(request: HostMcpToolRequest): Promise<HostMcpToolSelection>;
}
export interface HostTool {
  readonly description: string;
  execute(input: unknown, context: HostToolContext): Promise<unknown>;
  /** Existing executor/server-generation identity, bound into pending decisions. */
  readonly identity: string;
  readonly inputSchema: FlexibleSchema<unknown>;
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
  /** Supplied by the existing run configuration, not a second host default. */
  readonly maxSteps?: number | undefined;
  /** Run-scoped construction; cached shared memory must not capture a run signal. */
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  readPermissionPolicy(): PermissionToolGateSnapshot;
  resolveModel?(modelId: string): Promise<LanguageModel>;
  readonly tools?: Readonly<Record<string, HostTool>> | undefined;
}
export type HostSdkTools = ToolSet;
