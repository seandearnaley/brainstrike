import { ToolInputError } from '@brainstrike/assistant-contract';
import {
  type BoundaryFailure,
  type BoundaryFailureCategory,
  refusal,
} from '@brainstrike/assistant-contract/boundary-failure';

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
  | 'workspace-busy';

export class CommandSessionError extends Error {
  readonly code: CommandSessionErrorCode;

  constructor(code: CommandSessionErrorCode, message: string) {
    super(message);
    this.name = 'CommandSessionError';
    this.code = code;
  }
}

/** How each manager refusal reads at a boundary; every other code is a fault whose cause stays in the log. */
const REFUSAL_CATEGORIES: Partial<Record<CommandSessionErrorCode, BoundaryFailureCategory>> = {
  aborted: 'availability',
  'cursor-out-of-range': 'input',
  'cwd-not-found': 'input',
  'cwd-outside-root': 'input',
  'invalid-input': 'input',
  'root-unavailable': 'availability',
  'session-exited': 'conflict',
  'session-not-found': 'input',
  'workspace-busy': 'conflict',
};

/**
 * The refusal `error` is when it is the caller's to correct (a cursor past the
 * output's end, an unknown or exited session), at the Terminal panel's boundary
 * and the model's alike; undefined for a fault.
 */
export function commandSessionRefusal(error: unknown): BoundaryFailure | undefined {
  if (!(error instanceof CommandSessionError)) {
    return;
  }
  const category = REFUSAL_CATEGORIES[error.code];
  return category === undefined
    ? undefined
    : refusal({ category, code: `command-session.${error.code}`, message: error.message });
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
