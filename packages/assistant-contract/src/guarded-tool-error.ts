export const GUARDED_TOOL_ERROR_CODES = [
  'tool_timeout',
  'tool_failed',
  'tool_input_invalid',
  'tool_blocked_by_hook',
] as const;

export type GuardedToolErrorCode = (typeof GUARDED_TOOL_ERROR_CODES)[number];

const GUARDED_TOOL_ERROR_CODE_SET = new Set<string>(GUARDED_TOOL_ERROR_CODES);

export interface GuardedToolError {
  error: {
    code: GuardedToolErrorCode;
    message: string;
    toolName: string;
  };
  ok: false;
}

/**
 * A trusted, model-correctable tool-input error whose message is intentionally
 * safe to return to the model. Generic exceptions must stay redacted by the
 * execution guard because they can contain host paths, secrets, or internals.
 */
export class ToolInputError extends Error {
  readonly code = 'tool_input_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function isGuardedToolError(value: unknown): value is GuardedToolError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { ok?: unknown; error?: { code?: unknown } };
  return (
    candidate.ok === false &&
    typeof candidate.error === 'object' &&
    candidate.error !== null &&
    typeof candidate.error.code === 'string' &&
    GUARDED_TOOL_ERROR_CODE_SET.has(candidate.error.code)
  );
}
