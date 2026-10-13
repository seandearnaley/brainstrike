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

/** The existing producer kind is authoritative; private detail never selects public text. */
export const HOSTED_EMBEDDING_MISSING_KEY = refusal({
  category: 'configuration',
  code: 'embedding.missing-key',
  message: 'No API key configured for the embedding provider.',
  remedy: 'Configure the embedding provider API key in Settings, then retry indexing.',
});

export function hostedEmbeddingFailure(error: unknown): BoundaryFailure | undefined {
  return error instanceof HostedEmbeddingError && error.kind === 'missing-key'
    ? HOSTED_EMBEDDING_MISSING_KEY
    : undefined;
}
