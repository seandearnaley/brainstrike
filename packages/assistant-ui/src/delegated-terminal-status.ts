/** The receiver's observed task terminal, distinct from an ordinary transport error. */
export const DELEGATED_TASK_TERMINAL_CODE = 'delegated-task-ended-before-stream-terminal';

export function delegatedTaskTerminalError(outcome: 'cancelled' | 'failed'): {
  readonly code: typeof DELEGATED_TASK_TERMINAL_CODE;
  readonly message: string;
  readonly outcome: 'cancelled' | 'failed';
} {
  return {
    code: DELEGATED_TASK_TERMINAL_CODE,
    message: `Delegated task ${outcome} before its child stream emitted a terminal.`,
    outcome,
  };
}

export function readDelegatedTaskTerminalError(
  value: unknown
): { readonly message: string; readonly outcome: 'cancelled' | 'failed' } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return;
  }
  const error = value as Record<string, unknown>;
  if (
    error['code'] !== DELEGATED_TASK_TERMINAL_CODE ||
    typeof error['message'] !== 'string' ||
    (error['outcome'] !== 'cancelled' && error['outcome'] !== 'failed')
  ) {
    return;
  }
  return { message: error['message'], outcome: error['outcome'] };
}
