import { type BoundaryFailure, refusal } from '@brainstrike/assistant-contract/boundary-failure';

/** Why a hosted embedding request was refused (BST-1994). */
export type HostedEmbeddingErrorKind =
  | 'missing-key'
  | 'input-too-long'
  | 'rate-limit'
  | 'provider-status'
  | 'network';

/**
 * A typed hosted embedding refusal. `message` is model-safe: no keys, host paths
 * or raw provider body. Raw provider detail travels only on `cause`, which is
 * logged and redacted. The name and shape are a contract with the
 * `platform/embedding/query` refusal mapping (BST-1996).
 */
export class HostedEmbeddingError extends Error {
  override readonly name = 'HostedEmbeddingError';
  constructor(
    readonly kind: HostedEmbeddingErrorKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** Existing model-actionable producer kinds; provider-status/network stay faults. */
export const HOSTED_EMBEDDING_REFUSALS = {
  'input-too-long': refusal({
    category: 'input',
    code: 'embedding.input-too-long',
    message: 'The embedding provider refused the input as too large.',
    remedy: 'Reduce the text sent for embedding, then retry.',
  }),
  'missing-key': refusal({
    category: 'configuration',
    code: 'embedding.missing-key',
    message: 'No API key configured for the embedding provider.',
    remedy: 'Configure the embedding provider API key in Settings, then retry indexing.',
  }),
  'rate-limit': refusal({
    category: 'availability',
    code: 'embedding.rate-limit',
    message: 'The embedding provider is rate limiting requests.',
    remedy: 'Wait for the provider rate limit to clear, then retry.',
  }),
} as const;

export function isActionableHostedEmbeddingError(
  error: unknown
): error is HostedEmbeddingError & { readonly kind: keyof typeof HOSTED_EMBEDDING_REFUSALS } {
  return (
    error instanceof HostedEmbeddingError && Object.hasOwn(HOSTED_EMBEDDING_REFUSALS, error.kind)
  );
}

/** The existing producer kind is authoritative; private detail never selects public text. */
export function hostedEmbeddingFailure(error: unknown): BoundaryFailure | undefined {
  return isActionableHostedEmbeddingError(error)
    ? HOSTED_EMBEDDING_REFUSALS[error.kind]
    : undefined;
}
