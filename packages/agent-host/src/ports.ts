import type {
  McpHostCloseReport,
  McpHostPort,
  PermissionToolGateSnapshot,
  RuntimeData,
  ToolRiskCategory,
} from '@brainstrike/assistant-contract';
import type { FlexibleSchema, LanguageModel, ModelMessage, streamText, Tool, ToolSet } from 'ai';
import type { McpHostToolBinding } from './adapters/mcp.js';

export interface HostToolContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly toolCallId: string;
  /** Existing native/MCP progress is committed by the run-log owner. */
  readonly write?: (chunk: unknown) => Promise<void>;
}
export interface HostRunContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly threadId: string;
}
/** Fence new work and join every provider, memory, storage and hook tail. */
export interface HostRunOwner {
  close(): Promise<void>;
}

/** Trusted run configuration; credential resolution stays inside the adapter. */
export interface HostProviderRequest {
  readonly configuration: Readonly<RuntimeData>;
  readonly messages: readonly ModelMessage[];
  readonly modelId: string;
  readonly signal: AbortSignal;
}

export interface HostPreparedModelRequest {
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  readonly providerOptions?: Parameters<typeof streamText>[0]['providerOptions'];
  readonly system?: string;
}

/** Shipped provider selection and request hygiene, with no second agent loop. */
export interface HostProviderPort {
  prepare(request: HostProviderRequest): Promise<HostPreparedModelRequest>;
}

/** The existing configured authority and its generation-qualified executors. */
export interface HostMcpRuntime {
  readonly authority: McpHostPort;
  close(): Promise<McpHostCloseReport>;
  executableTools(): Promise<Readonly<Record<string, McpHostToolBinding>>>;
}
export interface HostTool {
  readonly description: string;
  execute(input: unknown, context: HostToolContext): Promise<unknown>;
  /** Existing executor/server-generation identity, bound into pending decisions. */
  readonly identity: string;
  readonly inputSchema: FlexibleSchema<unknown>;
  readonly risk: ToolRiskCategory;
  readonly strict?: boolean;
  readonly toModelOutput?: Tool<unknown, unknown>['toModelOutput'];
}

/** Credentials and process-local capabilities never become protocol payloads. */
export interface HostPlatform {
  close(): Promise<void>;
  /** Supplied by the existing run configuration, not a second host default. */
  readonly maxSteps: number;
  /** Run-scoped construction; cached shared memory must not capture a run signal. */
  openRun?(context: HostRunContext): Promise<HostRunOwner>;
  readPermissionPolicy(): PermissionToolGateSnapshot;
  resolveModel(modelId: string): Promise<LanguageModel>;
  readonly tools: Readonly<Record<string, HostTool>>;
}
export type HostSdkTools = ToolSet;
