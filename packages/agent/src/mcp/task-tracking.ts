import type {
  McpHostExecution,
  McpTaskHandle,
  McpTaskPresentation,
} from '@brainstrike/assistant-contract';
import type { CreateTaskResult } from '@brainstrike/mcp-tasks-extension';

/**
 * Host-owned capability that lets an MCP tool call hand a freshly created
 * task to the durable task authorities (repository, lifecycle, interaction,
 * presentation). Present only when a trusted host composes it (desktop main);
 * absent on web and on runs without an MCP host, exactly like the artifact
 * settlement store. The tool never polls or answers input itself.
 */
export interface McpTaskTrackingRequest {
  readonly configuredServerId: string;
  /** The admitting host tool call's capability; absent outside an agent-host run. */
  readonly execution?: McpHostExecution;
  readonly result: CreateTaskResult;
  readonly toolName: string;
}

export type McpTaskSettlementOutcome =
  | { readonly settled: true; readonly task: McpTaskPresentation }
  | { readonly reason: 'timeout'; readonly settled: false; readonly task: McpTaskPresentation };

export interface McpTaskSettlementOptions {
  readonly signal?: AbortSignal;
  /** Bounded wait; the tool returns the live presentation when it elapses. */
  readonly timeoutMs: number;
}

export interface McpTaskTrackingCapability {
  /** Waits for a terminal status within the bound; never throws on timeout. */
  awaitSettlement(
    handle: McpTaskHandle,
    options: McpTaskSettlementOptions
  ): Promise<McpTaskSettlementOutcome>;
  /** Registers the task with the lifecycle and returns its initial presentation. */
  track(request: McpTaskTrackingRequest, signal?: AbortSignal): Promise<McpTaskPresentation>;
}
