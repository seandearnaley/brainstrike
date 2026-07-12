export const GUARDED_TOOL_ERROR_CODES = [
  'tool_timeout',
  'tool_failed',
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
