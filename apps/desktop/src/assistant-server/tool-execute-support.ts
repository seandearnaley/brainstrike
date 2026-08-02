/**
 * Shared execute-time scaffolding for the desktop native tools (BST-743):
 * Mastra input unwrapping/parsing, tool-call-id reading, the shell-output
 * streamer bridge, and the redacted failure logging every tool family reuses.
 * Extracted from `assistant-tools.ts` so each per-family module can import one
 * cohesive support surface instead of re-deriving the boilerplate.
 *
 * Leaf module: it depends only on `@brainstrike/agent`, the sibling
 * `execute-command-tool` types, and the logger — never on `assistant-tools.ts`,
 * so no import cycle is possible.
 */
import { writeShellOutputChunk } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import type { z } from 'zod';
import type { ShellOutputStreamer } from './execute-command-tool';

const logger = createLogger('DesktopAssistantTools');

export type ToolExecuteInput<T> = { context: T } | T;

/**
 * Minimal structural view of Mastra's 2nd `execute` argument
 * (`ToolExecutionContext`, verified against @mastra/core@1.50.0 `tools/types.d.ts`
 * — `agent?: AgentToolExecutionContext` carries `toolCallId`). Typed loosely so it
 * stays assignable from the concrete Mastra context by contravariance; the
 * mutation tools read `agent.toolCallId` to key each edit's journal entry.
 */
export interface ToolExecuteRunContext {
  agent?: { toolCallId?: string };
}

export function readToolCallId(context: ToolExecuteRunContext | undefined): string | undefined {
  return context?.agent?.toolCallId;
}

export function resolveToolExecuteInputCandidate<T>(
  schema: z.ZodType<T>,
  input: ToolExecuteInput<T>
): unknown {
  const directResult = schema.safeParse(input);
  if (directResult.success) {
    return directResult.data;
  }

  // Mastra sometimes wraps tool args as { context: T } for compatibility. Try
  // direct schema parsing first so a future tool with a legitimate top-level
  // `context` field is not silently unwrapped by this compatibility bridge.
  const maybeWrapped = input as { context?: T };
  if (
    typeof input === 'object' &&
    input !== null &&
    Object.keys(input).length === 1 &&
    'context' in input &&
    maybeWrapped.context !== undefined
  ) {
    const wrappedResult = schema.safeParse(maybeWrapped.context);
    if (wrappedResult.success) {
      return wrappedResult.data;
    }
    return input;
  }

  return input;
}

export function parseToolExecuteInput<T>(schema: z.ZodType<T>, input: ToolExecuteInput<T>): T {
  return schema.parse(resolveToolExecuteInputCandidate(schema, input));
}

/** A verbatim-chunk stream writer, in either shape Mastra exposes. */
type StreamWriterLike = (chunk: { type: string } & Record<string, unknown>) => unknown;

/**
 * The subset of the Mastra tool-execution context executeCommand reads. Mastra
 * passes a `createTool` instance the `writer` (ToolStream) + `agent.toolCallId`,
 * but a plain tool OBJECT (what the desktop registry uses) gets the raw
 * `outputWriter` fn + a top-level `toolCallId`. Both are accepted.
 */
export interface ToolExecuteContext {
  abortSignal?: AbortSignal;
  agent?: { toolCallId?: string };
  outputWriter?: StreamWriterLike;
  toolCallId?: string;
  writer?: { custom: StreamWriterLike };
}

/**
 * Build a {@link ShellOutputStreamer} from whichever writer shape the context
 * carries, or `undefined` when neither a writer nor a tool-call id is present
 * (streaming is best-effort observability — its absence never blocks the run).
 * Writes are fire-and-forget: `custom`/`outputWriter` enqueue synchronously so
 * call order is emission order; a rejected enqueue is reported, never swallowed.
 */
export function resolveShellOutputStreamer(
  options: ToolExecuteContext | undefined,
  onError: (error: unknown) => void
): ShellOutputStreamer | undefined {
  const custom: StreamWriterLike | undefined = options?.writer?.custom ?? options?.outputWriter;
  const toolCallId = options?.agent?.toolCallId ?? options?.toolCallId;
  if (!(custom && toolCallId)) {
    return;
  }
  const writer = {
    custom: (data: { type: string } & Record<string, unknown>) =>
      Promise.resolve(custom(data)).then(() => undefined),
  };
  return (part) => {
    void writeShellOutputChunk(writer, { ...part, toolCallId }).catch(onError);
  };
}

function redactToolInputForLog(input: object): { fields: string[]; redacted: true } {
  return { fields: Object.keys(input), redacted: true };
}

export const REDACTED_PATH_LOG_VALUE = { redacted: true } as const;

export function redactToolErrorForLog(error: unknown): {
  code?: string | number;
  name: string;
  redacted: true;
} {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    name: error instanceof Error && error.name.length > 0 ? error.name : typeof error,
    redacted: true,
  };
}

export function logToolFailure(message: string, error: unknown, input: object): void {
  logger.error(message, {
    error: redactToolErrorForLog(error),
    input: redactToolInputForLog(input),
  });
}
