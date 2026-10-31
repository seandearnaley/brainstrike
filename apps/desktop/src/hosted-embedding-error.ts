import {
  extractProviderRunError,
  isLocalRunErrorClassification,
} from '@brainstrike/agent/provider-runtime';
import { type BoundaryFailure, refusal } from '@brainstrike/assistant-contract/boundary-failure';
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
  readonly httpStatus: number | undefined;

  constructor(
    kind: HostedEmbeddingErrorKind,
    message: string,
    options?: { cause?: unknown; httpStatus?: number }
  ) {
    super(message, options);
    this.kind = kind;
    this.httpStatus = options?.httpStatus;
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
 * A hosted embedding failure as the refusal BST-1996 maps. Only the provider's
 * own evidence chooses the kind: an HTTP status, or a call that got no response.
 * No message text is parsed, and the message never repeats the provider's body.
 * A failure that never crossed to the provider has no hosted classification.
 */
export function hostedRefusal(
  provider: EmbeddingProviderType,
  cause: unknown
): HostedEmbeddingError | undefined {
  // The bounded diagnostic (status, message, request id, cause chain) is the
  // cause, never the SDK error: that carries the request body, the embedded text.
  const evidence = extractProviderRunError(cause);
  const { code, httpStatus } = evidence;
  if (isLocalRunErrorClassification(code)) {
    return;
  }
  if (httpStatus === undefined) {
    return new HostedEmbeddingError(
      'network',
      `Embedding provider ${provider} could not be reached.`,
      { cause: evidence }
    );
  }
  const options = { cause: evidence, httpStatus };
  switch (httpStatus) {
    case 429:
      return new HostedEmbeddingError(
        'rate-limit',
        `Embedding provider ${provider} is rate limiting requests; try again later.`,
        options
      );
    case 413:
      return new HostedEmbeddingError(
        'input-too-long',
        `Embedding provider ${provider} refused the input as too large (HTTP 413).`,
        options
      );
    default:
      return new HostedEmbeddingError(
        'provider-status',
        `Embedding provider ${provider} refused the request (HTTP ${httpStatus}).`,
        options
      );
  }
}
