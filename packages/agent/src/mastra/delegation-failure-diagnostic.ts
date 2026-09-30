/** Only code-authored causes cross the durable diagnostics boundary. */
const INTERNAL_REASONS = new Map<string, string>([
  [
    'Child execution configuration has no trusted native admission.',
    'child-execution-not-admitted',
  ],
  [
    'Delegated persistence requires the native tool execution identity.',
    'native-tool-identity-missing',
  ],
  ['Trusted delegated context exceeds its 64 KiB budget.', 'trusted-context-over-budget'],
]);

const IDENTITY_REASONS = new Set([
  'host-transaction-unavailable',
  'native-run-generation-mismatch',
]);
const EMBEDDING_PROBE_ERROR_ID = 'MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED';
const MAX_CAUSE_DEPTH = 5;
/** Exact native identifiers reviewed at the installed public Mastra boundary. */
const FRAMEWORK_ERROR_IDS = new Set([
  'AGENT_AGENT_TOOL_EXECUTION_FAILED',
  'AGENT_STREAM_FAILED',
  'AGENT_INPUT_PROCESSOR_ERROR',
  'AGENT_INPUT_STEP_PROCESSOR_ERROR',
  EMBEDDING_PROBE_ERROR_ID,
]);
export interface DelegationStartupEvidence {
  readonly childThreadId?: string;
  readonly failure?: DelegationFailureDiagnostic;
  readonly failureIsOwnerAbort?: boolean;
  readonly startupBoundary:
    | 'delegation-started'
    | 'delegation-prepared'
    | 'child-input-started'
    | 'child-admitted';
}
function readErrorField(error: Error, field: string): unknown {
  try {
    return (error as unknown as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/** Compare only observed error identity; no name or message implies cancellation. */
export function hasErrorCause(error: unknown, reason: unknown): boolean {
  const seen = new WeakSet<object>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    if (current === reason) {
      return true;
    }
    current = readErrorField(current, 'cause');
  }
  return false;
}

function readFrameworkErrorId(error: Error): string | undefined {
  const id = readErrorField(error, 'id');
  return typeof id === 'string' && FRAMEWORK_ERROR_IDS.has(id) ? id : undefined;
}

function readHttpStatus(error: Error): number | undefined {
  const status = readErrorField(error, 'statusCode') ?? readErrorField(error, 'status');
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return;
  }
  return status;
}

function readInternalReason(error: Error): string | undefined {
  const message = readErrorField(error, 'message');
  const internal = typeof message === 'string' ? INTERNAL_REASONS.get(message) : undefined;
  if (internal) {
    return internal;
  }
  const reason = readErrorField(error, 'reason');
  if (
    readErrorField(error, 'name') === 'DelegatedConversationIdentityError' &&
    typeof reason === 'string' &&
    IDENTITY_REASONS.has(reason)
  ) {
    return reason;
  }
  return;
}

export const EMBEDDING_ACCESS_FEEDBACK =
  "Subagent could not start because semantic recall's embedding request was denied. Check the embedding provider credentials and access, then retry in a new run.";
export const EMBEDDING_PROBE_FEEDBACK =
  'Subagent could not start because semantic recall could not check its embedding provider. Check the embedding provider configuration and availability, then retry in a new run.';

export interface DelegationFailureDiagnostic {
  readonly causeCategory: 'known-internal' | 'unclassified' | 'unreported';
  readonly causeReason?: string;
  readonly frameworkErrorIds?: readonly string[];
  readonly httpStatus?: number;
}

/** Never copies freeform Error text, stacks, cause objects, or provider payloads. */
export function summarizeDelegationFailure(
  error: unknown,
  observed?: DelegationFailureDiagnostic
): DelegationFailureDiagnostic {
  if (error === undefined || error === null) {
    return observed ?? { causeCategory: 'unreported' };
  }
  const ids = new Set<string>(observed?.frameworkErrorIds);
  let httpStatus = observed?.httpStatus;
  let causeReason = observed?.causeReason;
  let sawEmbeddingProbe = false;
  let sawAccessDenial = false;
  try {
    const seen = new WeakSet<object>();
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
      const id = readFrameworkErrorId(current);
      if (id) {
        ids.add(id);
      }
      sawEmbeddingProbe ||= id === EMBEDDING_PROBE_ERROR_ID;
      const status = readHttpStatus(current);
      httpStatus ??= status;
      // Only the probe and its descendants can prove embedding access denial.
      sawAccessDenial ||= sawEmbeddingProbe && (status === 401 || status === 403);
      causeReason ??= readInternalReason(current);
      current = readErrorField(current, 'cause');
    }
  } catch {
    // Hostile Error proxies cannot prevent recording already-observed evidence.
  }
  if (!causeReason && sawEmbeddingProbe) {
    causeReason = sawAccessDenial
      ? 'memory-embedding-access-denied'
      : 'memory-embedding-probe-failed';
  }
  return {
    causeCategory: causeReason ? 'known-internal' : 'unclassified',
    ...(causeReason ? { causeReason } : {}),
    ...(ids.size ? { frameworkErrorIds: [...ids] } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}
