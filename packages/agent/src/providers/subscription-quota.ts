/**
 * Subscription quota is terminal (BST-1356, legal gate constraint 6): retrying
 * a 429 would spend the user's personal quota on their behalf and bury the
 * message the gate requires them to see. The legacy Mastra path holds this in
 * its error-processor wrapper; the host's SDK request retry honors this typed,
 * non-retryable error instead.
 */
import {
  isSubscriptionAuthProvider,
  isSubscriptionRateLimitError,
} from '../mastra-processors/error-processors';

export class SubscriptionQuotaExhaustedError extends Error {
  readonly code = 'subscription_quota_exhausted';
  readonly retryable = false;

  constructor(cause: unknown) {
    // The provider's own quota message reaches the user verbatim.
    super(
      cause instanceof Error && cause.message
        ? cause.message
        : 'The subscription usage limit was reached.',
      { cause }
    );
    this.name = 'SubscriptionQuotaExhaustedError';
  }
}

export function classifySubscriptionQuotaError(error: unknown, provider: string): unknown {
  return error instanceof SubscriptionQuotaExhaustedError ||
    !isSubscriptionAuthProvider(provider) ||
    !isSubscriptionRateLimitError(error)
    ? error
    : new SubscriptionQuotaExhaustedError(error);
}
