import type { McpHostExecution } from '@brainstrike/assistant-contract';
import type { FlexibleSchema, Tool } from 'ai';

/** The host supplies execution identity and capabilities, separately from model input. */
export interface HostToolExecutionContext {
  readonly _meta?: Readonly<Record<string, unknown>> | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly brainstrikeMcp?: McpHostExecution | undefined;
  readonly resumeData?: unknown;
  readonly runId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly writer?: { custom(data: unknown): Promise<void> } | undefined;
}

/** Producer declaration; permissions and durable identities are attached by the host. */
export interface HostToolDefinition<Input = unknown, Output = unknown> {
  readonly description?: string | undefined;
  execute?(input: Input, context?: HostToolExecutionContext): Promise<Output> | Output;
  readonly id?: string | undefined;
  readonly inputSchema?: FlexibleSchema<Input> | undefined;
  readonly resumeSchema?: FlexibleSchema<unknown> | undefined;
  /**
   * BST-2360: whether this call would run inside the OS sandbox, for its
   * approval card. Only tools that run commands declare it.
   */
  readonly sandboxed?: ((input: unknown) => Promise<boolean>) | undefined;
  readonly strict?: boolean | undefined;
  toModelOutput?(output: Output): unknown;
}

/** Provider-native tools retain the AI SDK's own opaque definition. */
export type HostToolDefinitions = Record<string, HostToolDefinition | Tool>;
