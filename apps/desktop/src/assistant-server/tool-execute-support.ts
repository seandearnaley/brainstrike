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
 * (`ToolExecutionContext`, verified against @mastra/core@1.55.0 `tools/types.d.ts`).
 * Mastra exposes the tool-call id in TWO documented locations, depending on how
 * the tool was registered: a `createTool` instance running under an agent gets
 * `agent.toolCallId` (`agent?: AgentToolExecutionContext`), while a plain tool
 * OBJECT — what the desktop registry passes (`assistant-tools.ts`) — receives a
 * TOP-LEVEL `toolCallId`. Typed loosely so it stays assignable from the concrete
 * Mastra context by contravariance; the mutation tools read the id to key each
 * edit's journal entry (`tool_call_id`), which is what binds the renderer's
 * checkpoint-undo affordances (`entriesByToolCallId`).
 */
export interface ToolExecuteRunContext {
  agent?: { toolCallId?: string };
  toolCallId?: string;
}

/**
 * The tool-call id from whichever documented location the context carries —
 * agent-scoped for agent-context tools, top-level for plain tool objects (the
 * same dual location {@link resolveShellOutputStreamer} already reads). This is
 * field selection between two documented Mastra shapes, not a fallback: a
 * context can only ever populate the location matching how its tool was
 * registered (BST-1164 review — the plain-tool path journaled NULL
 * `tool_call_id`, so the checkpoint-undo UI never rendered).
 */
export function readToolCallId(context: ToolExecuteRunContext | undefined): string | undefined {
  return context?.agent?.toolCallId ?? context?.toolCallId;
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

/** Hard cap so a pathological many-issue error can't flood the model context. */
const TOOL_INPUT_ERROR_MAX_CHARS = 600;

/**
 * Input-validation failure with a compact single-line `message` (the model
 * reads it verbatim) that still carries the raw Zod `issues`, so per-tool
 * enrichers that duck-type on `.issues` (e.g. `toQuerySelfInputError`) keep
 * working.
 */
export class ToolInputValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.ZodError['issues']
  ) {
    super(message);
    this.name = 'ToolInputValidationError';
  }
}

export function parseToolExecuteInput<T>(schema: z.ZodType<T>, input: ToolExecuteInput<T>): T {
  const result = schema.safeParse(resolveToolExecuteInputCandidate(schema, input));
  if (result.success) {
    return result.data;
  }
  // The model reads this text verbatim on every failed call — a raw ZodError
  // serializes as a multi-line JSON blob. Compact it to one dense line with
  // the same information (field path + message per issue), capped.
  const issueText = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'input'}: ${issue.message}`)
    .join('; ')
    .replace(/\s+/g, ' ');
  const message = `invalid tool input — ${issueText}`;
  throw new ToolInputValidationError(
    message.length > TOOL_INPUT_ERROR_MAX_CHARS
      ? `${message.slice(0, TOOL_INPUT_ERROR_MAX_CHARS - 1)}…`
      : message,
    result.error.issues
  );
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
  const custom: StreamWriterLike | undefined =
    options?.writer?.custom.bind(options.writer) ?? options?.outputWriter;
  const toolCallId = options?.agent?.toolCallId ?? options?.toolCallId;
  if (!(custom && toolCallId)) {
    return;
  }
  const writer = {
    custom: async (data: { type: string } & Record<string, unknown>): Promise<void> => {
      await custom(data);
    },
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
