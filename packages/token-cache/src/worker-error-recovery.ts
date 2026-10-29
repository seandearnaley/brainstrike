/**
 * worker-error-recovery
 *
 * Module-private helpers for useBackgroundTokenIndexer: terminal vs.
 * recoverable worker-error classification, restart-backoff pruning, and
 * error-detail formatting. Extracted verbatim from
 * use-background-token-indexer.ts (BST-1127).
 */

import type { WorkerLog } from './background-indexer-protocol';

export const TERMINAL_WORKER_ERROR_KEY = '__worker__';
// Tunable only if future environments show different restart characteristics.
export const MAX_RECOVERABLE_WORKER_RESTARTS = 2;
export const RECOVERABLE_WORKER_RESTART_BACKOFF_MS = 250;
// Sliding-window budget: up to MAX_RECOVERABLE_WORKER_RESTARTS restarts in
// any RECOVERABLE_WORKER_RESTART_WINDOW_MS window. A flapping worker that
// fails every 30s no longer restarts indefinitely — after the cap is hit
// inside the window, the next failure escalates to terminal. Outside the
// window, transient failures still get a fresh budget.
export const RECOVERABLE_WORKER_RESTART_WINDOW_MS = 60_000;

type RecoverableWorkerContext =
  | 'ready-timeout'
  | 'worker.onerror'
  | 'worker.addEventListener(error)'
  | 'worker.onmessageerror';

const RECOVERABLE_WORKER_CONTEXTS: ReadonlySet<RecoverableWorkerContext> = new Set([
  'ready-timeout',
  'worker.onerror',
  'worker.addEventListener(error)',
  'worker.onmessageerror',
]);
const TERMINAL_TOKENIZER_ERROR_PATTERNS: RegExp[] = [
  /^accurate token counting unavailable:/iu,
  /tiktoken encoder failed to initialize/iu,
];

interface TimerRef {
  current: ReturnType<typeof setTimeout> | null;
}

function normalizeTerminalErrorMessage(errorMessage: string): string {
  return errorMessage.trim().replace(/^error:\s*/iu, '');
}

export function isTerminalTokenizerError(errorMessage: string): boolean {
  const normalized = normalizeTerminalErrorMessage(errorMessage);
  return TERMINAL_TOKENIZER_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isRecoverableWorkerFailure(error: Error, context: string): boolean {
  if (isTerminalTokenizerError(error.message)) {
    return false;
  }
  // createWorkerInstance is intentionally excluded: constructor failures are deterministic.
  return RECOVERABLE_WORKER_CONTEXTS.has(context as RecoverableWorkerContext);
}

// Prunes restart timestamps older than the sliding window in-place and
// returns the count of restarts still in the budget window.
export function pruneRestartHistory(history: number[], now: number): number {
  const cutoff = now - RECOVERABLE_WORKER_RESTART_WINDOW_MS;
  while (history.length > 0) {
    const head = history[0];
    if (head === undefined || head >= cutoff) {
      break;
    }
    history.shift();
  }
  return history.length;
}

export function clearTimerRef(timerRef: TimerRef): void {
  if (timerRef.current !== null) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

export function extractTerminalTokenizerErrorFromWorkerLog(logMessage: WorkerLog): string | null {
  if (logMessage.level !== 'error') {
    return null;
  }

  const data = logMessage.data;
  const candidateMessages: string[] = [];
  if (typeof data?.['error'] === 'string') {
    candidateMessages.push(data['error']);
  }
  if (typeof data?.['message'] === 'string') {
    candidateMessages.push(data['message']);
  }
  if (typeof data?.['cause'] === 'string') {
    candidateMessages.push(data['cause']);
  }

  for (const candidate of candidateMessages) {
    if (isTerminalTokenizerError(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

export interface TerminalWorkerErrorDetails {
  readonly colno?: number;
  readonly eventError?: string;
  readonly eventErrorName?: string;
  readonly eventErrorStack?: string;
  readonly eventMessage?: string;
  readonly filename?: string;
  readonly lineno?: number;
  readonly reason?: string;
  readonly type: string;
}

type ErrorWithTerminalWorkerDetails = Error & {
  terminalWorkerErrorDetails?: TerminalWorkerErrorDetails;
};

function formatUnknownDetail(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function readEventReason(event: Event): unknown {
  if (!('reason' in event)) {
    return;
  }
  return (event as Event & { reason: unknown }).reason;
}

function readReportedErrorEventLocation(value: number): number | undefined {
  return value > 0 ? value : undefined;
}

export function createTerminalWorkerErrorDetails(event: Event): TerminalWorkerErrorDetails {
  const details: TerminalWorkerErrorDetails = { type: event.type };
  if (event instanceof ErrorEvent) {
    const eventError: unknown = event.error;
    const eventErrorDetail = formatUnknownDetail(eventError);
    const lineno = readReportedErrorEventLocation(event.lineno);
    const colno = readReportedErrorEventLocation(event.colno);
    const isEventError = eventError instanceof Error;
    return {
      ...details,
      ...(event.message ? { eventMessage: event.message } : {}),
      ...(event.filename ? { filename: event.filename } : {}),
      ...(lineno === undefined ? {} : { lineno }),
      ...(colno === undefined ? {} : { colno }),
      ...(eventErrorDetail ? { eventError: eventErrorDetail } : {}),
      ...(isEventError ? { eventErrorName: eventError.name } : {}),
      ...(isEventError && eventError.stack ? { eventErrorStack: eventError.stack } : {}),
    };
  }

  const reason = formatUnknownDetail(readEventReason(event));
  return {
    ...details,
    ...(reason ? { reason } : {}),
  };
}

export function attachTerminalWorkerErrorDetails(
  error: Error,
  details: TerminalWorkerErrorDetails
): Error {
  Object.defineProperty(error, 'terminalWorkerErrorDetails', {
    configurable: true,
    enumerable: false,
    value: details,
    writable: false,
  });
  return error;
}

export function getTerminalWorkerErrorDetails(
  error: unknown
): TerminalWorkerErrorDetails | undefined {
  if (!(error instanceof Error)) {
    return;
  }
  return (error as ErrorWithTerminalWorkerDetails).terminalWorkerErrorDetails;
}
