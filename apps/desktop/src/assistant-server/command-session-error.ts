import { ToolInputError } from '@brainstrike/assistant-contract';

export type CommandSessionErrorCode =
  | 'aborted'
  | 'cursor-out-of-range'
  | 'cwd-not-found'
  | 'cwd-outside-root'
  | 'invalid-buffer'
  | 'invalid-input'
  | 'root-unavailable'
  | 'session-exited'
  | 'session-id-collision'
  | 'session-not-found'
  | 'start-failed'
  | 'stop-failed'
  | 'workspace-busy';

export class CommandSessionError extends Error {
  readonly code: CommandSessionErrorCode;

  constructor(code: CommandSessionErrorCode, message: string) {
    super(message);
    this.name = 'CommandSessionError';
    this.code = code;
  }
}

/** Preserve host-owned admission failures without relabeling them as spawn errors. */
export function commandSessionStartError(
  error: unknown,
  signal: AbortSignal | undefined
): CommandSessionError {
  if (signal?.aborted) {
    return new CommandSessionError('aborted', 'Command session start was aborted.');
  }
  if (error instanceof ToolInputError) {
    return new CommandSessionError('workspace-busy', error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CommandSessionError('start-failed', `Failed to start command session: ${message}`);
}
