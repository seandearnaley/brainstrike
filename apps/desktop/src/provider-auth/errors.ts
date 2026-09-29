import type { ProviderAuthErrorCode } from '@brainstrike/assistant-contract';

/**
 * Typed failure for provider-auth flows (BST-1355). `code` is the ONLY part
 * that ever crosses IPC (inside `{ state: 'error', code }` status payloads);
 * `message` stays in main-process logs and may carry bounded diagnostic
 * detail, but NEVER token material.
 */
export class ProviderAuthFlowError extends Error {
  readonly code: ProviderAuthErrorCode;

  constructor(code: ProviderAuthErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ProviderAuthFlowError';
    this.code = code;
  }
}

/**
 * A flow ended because the user cancelled it (programmatic cancel or the
 * loopback /cancel path). Deliberately NOT a {@link ProviderAuthFlowError}:
 * cancellation is not a failure — the engine maps it back to the idle status
 * instead of an `error` status.
 */
export class ProviderAuthFlowCancelledError extends Error {
  constructor(message = 'Provider auth flow cancelled') {
    super(message);
    this.name = 'ProviderAuthFlowCancelledError';
  }
}

export function isProviderAuthFlowCancelled(
  error: unknown
): error is ProviderAuthFlowCancelledError {
  return error instanceof ProviderAuthFlowCancelledError;
}
