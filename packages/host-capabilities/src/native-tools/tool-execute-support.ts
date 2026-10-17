/**
 * Shared execute-time scaffolding for the desktop native tools (BST-743):
 * Direct input parsing, host tool-call-id reading, the shell-output
 * streamer bridge, and the redacted failure logging every tool family reuses.
 * Extracted from `assistant-tools.ts` so each per-family module can import one
 * cohesive support surface instead of re-deriving the boilerplate.
 *
 * Leaf module: it depends only on `@brainstrike/agent` and the logger — never on `assistant-tools.ts`,
 * so no import cycle is possible.
 */
import { writeShellOutputChunk } from '@brainstrike/agent';
import {
  type ToolInputIssue,
  validateToolInputValue,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('DesktopAssistantTools');

/** One incremental slice of live subprocess output. */
export interface ShellOutputStreamPart {
  /** The incremental text (ANSI stripped, same as the final captured result). */
  readonly chunk: string;
  /** Which pipe the slice came from. */
  readonly stream: 'stdout' | 'stderr';
  /** True only on the single terminal notice emitted when the cap is hit. */
  readonly truncated?: boolean;
}

/**
 * Sink for live, incremental subprocess output. Invoked in emission order as the
 * child writes; the LAST call (when the streaming cap is hit) carries
 * `truncated: true`. Streaming is best-effort observability — a throwing sink
 * must never break command execution, so the caller wraps it defensively.
 */
export type ShellOutputStreamer = (part: ShellOutputStreamPart) => void;

export type ToolExecuteInput<T> = T;

/** The host supplies one tool-call identity independently of model input. */
export interface ToolExecuteRunContext {
  toolCallId?: string | undefined;
}

export function readToolCallId(context: ToolExecuteRunContext | undefined): string | undefined {
  return context?.toolCallId;
}

/** Hard cap so a pathological many-issue error can't flood the model context. */
const TOOL_INPUT_ERROR_MAX_CHARS = 600;

/**
 * Input-validation failure with a compact single-line `message` (the model
 * reads it verbatim) that still carries the per-field `issues`, so per-tool
 * enrichers that duck-type on `.issues` keep working. The issue shape is the
 * producer-neutral one both tool-schema libraries report in.
 */
export class ToolInputValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly ToolInputIssue[]
  ) {
    super(message);
    this.name = 'ToolInputValidationError';
  }
}

export function parseToolExecuteInput<T>(schema: unknown, input: ToolExecuteInput<T>): T {
  const result = validateToolInputValue(schema, input);
  if (result.success) {
    return result.value as T;
  }
  // The model reads this text verbatim on every failed call — a raw decode
  // error serializes as a multi-line JSON blob. Compact it to one dense line
  // with the same information (field path + message per issue), capped.
  const issueText = result.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.map(String).join('.') : 'input'}: ${issue.message}`
    )
    .join('; ')
    .replace(/\s+/g, ' ');
  const message = `invalid tool input — ${issueText}`;
  throw new ToolInputValidationError(
    message.length > TOOL_INPUT_ERROR_MAX_CHARS
      ? `${message.slice(0, TOOL_INPUT_ERROR_MAX_CHARS - 1)}…`
      : message,
    result.issues
  );
}

/** Structural writer supplied by the canonical host context. */
type StreamWriterLike = (chunk: unknown) => Promise<void>;
export interface ToolExecuteContext {
  abortSignal?: AbortSignal | undefined;
  toolCallId?: string | undefined;
  writer?: { custom: StreamWriterLike } | undefined;
}

/** Preserve emission order; rejected writes are reported by the caller. */
export function resolveShellOutputStreamer(
  options: ToolExecuteContext | undefined,
  onError: (error: unknown) => void
): ShellOutputStreamer | undefined {
  const custom = options?.writer?.custom.bind(options.writer);
  const toolCallId = options?.toolCallId;
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
