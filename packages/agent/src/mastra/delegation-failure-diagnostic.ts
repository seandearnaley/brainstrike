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

export const EMBEDDING_ACCESS_FEEDBACK =
  "Subagent could not start because semantic recall's embedding request was denied. Check the embedding provider credentials and access, then retry in a new run.";
export const EMBEDDING_PROBE_FEEDBACK =
  'Subagent could not start because semantic recall could not check its embedding provider. Check the embedding provider configuration and availability, then retry in a new run.';

export interface DelegationFailureDiagnostic {
  readonly causeCategory: 'known-internal' | 'unclassified' | 'unreported';
  readonly causeReason?: string;
}

/** Never copies freeform Error text, stack, cause objects, or provider fields. */
export function summarizeDelegationFailure(error: unknown): DelegationFailureDiagnostic {
  if (error === undefined || error === null) {
    return { causeCategory: 'unreported' };
  }
  try {
    const seen = new WeakSet<object>();
    let current: unknown = error;
    let sawEmbeddingProbe = false;
    let sawAccessDenial = false;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
      const shaped = current as Error & {
        id?: unknown;
        reason?: unknown;
        status?: unknown;
        statusCode?: unknown;
      };
      sawEmbeddingProbe ||= shaped.id === EMBEDDING_PROBE_ERROR_ID;
      const status = shaped.statusCode ?? shaped.status;
      sawAccessDenial ||= status === 401 || status === 403;
      const reason = INTERNAL_REASONS.get(current.message);
      if (reason) {
        return { causeCategory: 'known-internal', causeReason: reason };
      }
      if (
        current.name === 'DelegatedConversationIdentityError' &&
        typeof shaped.reason === 'string' &&
        IDENTITY_REASONS.has(shaped.reason)
      ) {
        return { causeCategory: 'known-internal', causeReason: shaped.reason };
      }
      current = current.cause;
    }
    if (sawEmbeddingProbe) {
      return {
        causeCategory: 'known-internal',
        causeReason: sawAccessDenial
          ? 'memory-embedding-access-denied'
          : 'memory-embedding-probe-failed',
      };
    }
  } catch {
    // Hostile Error getters must not prevent recording the failed delegation.
  }
  return { causeCategory: 'unclassified' };
}
