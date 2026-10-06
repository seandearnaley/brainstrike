import type { PermissionToolGateSnapshot, ToolRiskCategory } from '@brainstrike/assistant-contract';
import type { LanguageModel, ToolSet } from 'ai';
import type { z } from 'zod';

export interface HostToolContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly toolCallId: string;
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
export interface HostTool {
  readonly description: string;
  execute(input: unknown, context: HostToolContext): Promise<unknown>;
  /** Existing executor/server-generation identity, bound into pending decisions. */
  readonly identity: string;
  readonly inputSchema: z.ZodType;
  readonly risk: ToolRiskCategory;
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
