export const DEFAULT_CLAIM_BATCH_SIZE = 50;
export const CLAIM_SIZE_RESOLVER_RETRY_BACKOFF_MS = 1000;
export const DEFAULT_IDLE_POLL_INITIAL_MS = 400;
export const DEFAULT_IDLE_POLL_MAX_MS = 1000;

export interface IdlePollBackoffInput {
  idlePollInitialMs?: number;
  idlePollMaxMs?: number;
}

export function resolvePositiveIntegerOption(
  value: number | undefined,
  defaultValue: number,
  name: string
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }
  return resolved;
}

export function resolveIdlePollBackoffOptions(options: IdlePollBackoffInput): {
  readonly initialMs: number;
  readonly maxMs: number;
} {
  const initialMs = resolvePositiveIntegerOption(
    options.idlePollInitialMs,
    DEFAULT_IDLE_POLL_INITIAL_MS,
    'idlePollInitialMs'
  );
  const maxMs = resolvePositiveIntegerOption(
    options.idlePollMaxMs,
    DEFAULT_IDLE_POLL_MAX_MS,
    'idlePollMaxMs'
  );
  if (maxMs < initialMs) {
    throw new Error(
      `idlePollMaxMs must be greater than or equal to idlePollInitialMs; received ${maxMs} < ${initialMs}.`
    );
  }
  return { initialMs, maxMs };
}

export function shouldLogIdleBackoff(
  idlePollCount: number,
  hasReachedMaxBackoff: boolean,
  hasLoggedMaxBackoff: boolean
): boolean {
  if (hasReachedMaxBackoff && !hasLoggedMaxBackoff) {
    return true;
  }
  return (idlePollCount & (idlePollCount - 1)) === 0;
}
