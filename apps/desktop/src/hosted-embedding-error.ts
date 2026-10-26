import { type BoundaryFailure, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { EmbeddingProviderError } from '@brainstrike/embeddings/provider-core';
import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';

/** Why a hosted embedding request was refused (BST-1994). */
export type HostedEmbeddingErrorKind =
  | 'missing-key'
  | 'input-too-long'
  | 'rate-limit'
  | 'provider-status'
  | 'network';

export const HOSTED_EMBEDDING_MISSING_KEY_MESSAGE =
  'No API key configured for the embedding provider.';

/**
 * A typed hosted embedding refusal. `message` is model-safe: no keys, host paths
 * or raw provider body. Raw provider detail travels only on `cause`, which is
 * logged and redacted. The name and shape are a contract with the
 * `platform/embedding/query` refusal mapping (BST-1996).
 */
export class HostedEmbeddingError extends Error {
  override readonly name = 'HostedEmbeddingError';
  readonly kind: HostedEmbeddingErrorKind;

  constructor(kind: HostedEmbeddingErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
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
    message: HOSTED_EMBEDDING_MISSING_KEY_MESSAGE,
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

/**
 * A provider's typed failure as the refusal BST-1996 maps. Only typed facts choose the
 * kind (no message text is parsed), and the message never repeats the provider's body.
 */
export function hostedRefusal(
  provider: EmbeddingProviderType,
  error: EmbeddingProviderError
): Error {
  switch (error.type) {
    case 'missing_api_key':
      return new HostedEmbeddingError('missing-key', HOSTED_EMBEDDING_MISSING_KEY_MESSAGE, {
        cause: error,
      });
    case 'rate_limit_exceeded':
      return new HostedEmbeddingError(
        'rate-limit',
        `Embedding provider ${provider} is rate limiting requests; try again later.`,
        { cause: error }
      );
    case 'network_error':
      return new HostedEmbeddingError(
        'network',
        `Embedding provider ${provider} could not be reached.`,
        { cause: error }
      );
    case 'api_error':
      return error.statusCode === 413
        ? new HostedEmbeddingError(
            'input-too-long',
            `Embedding provider ${provider} refused the input as too large (HTTP 413).`,
            { cause: error }
          )
        : new HostedEmbeddingError(
            'provider-status',
            `Embedding provider ${provider} refused the request (HTTP ${error.statusCode}).`,
            { cause: error }
          );
    case 'dimension_mismatch':
      return new HostedEmbeddingError(
        'provider-status',
        `Embedding provider ${provider} returned ${error.received}-dimensional vectors; ${error.expected} were requested.`,
        { cause: error }
      );
    // Our own input: not a hosted provider refusal.
    case 'validation_error':
      return new Error(`Embedding provider ${provider} failed: ${error.type}`, { cause: error });
    default:
      return assertNever(error);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled embedding provider error: ${JSON.stringify(value)}`);
}
