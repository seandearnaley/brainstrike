import type {
  EmbeddingHostQueryCancellationResult,
  EmbeddingHostQueryEmbeddingPayload,
} from '../embedding-host-shared';

/** The signal is renderer-local; main correlates this token with the physical manager request. */
export async function generateDesktopQueryEmbedding(
  payload: EmbeddingHostQueryEmbeddingPayload,
  options: { readonly signal: AbortSignal }
): Promise<readonly number[]> {
  const { signal } = options;
  signal.throwIfAborted();
  const bridge = window.embeddingHost;
  if (
    !(
      bridge &&
      'queryEmbedding' in bridge &&
      typeof bridge.queryEmbedding === 'function' &&
      'cancelQueryEmbedding' in bridge &&
      typeof bridge.cancelQueryEmbedding === 'function'
    )
  ) {
    throw new Error('Cancellable hidden renderer query inference capability is unavailable.');
  }
  const requestId = crypto.randomUUID();
  let cancellation: Promise<EmbeddingHostQueryCancellationResult> | undefined;
  const onAbort = (): void => {
    if (cancellation) {
      return;
    }
    cancellation = Promise.resolve().then(() => bridge.cancelQueryEmbedding(requestId));
    // Delivery is joined below after physical query settlement, including rejection.
    void cancellation.catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const request = bridge.queryEmbedding(payload, { requestId });
    if (signal.aborted) {
      onAbort();
    }
    const result = await request.then(
      (embedding) => ({ embedding, kind: 'result' as const }),
      (error: unknown) => ({ error, kind: 'error' as const })
    );
    // Physical work has settled. Only cancellation already delivered needs joining.
    signal.removeEventListener('abort', onAbort);
    let cancellationResult: EmbeddingHostQueryCancellationResult | undefined;
    try {
      cancellationResult = await cancellation;
      if (
        cancellation &&
        !(cancellationResult && typeof cancellationResult.cancelled === 'boolean')
      ) {
        throw new Error('Query cancellation returned an invalid settlement outcome.');
      }
    } catch (error) {
      if (result.kind === 'error') {
        throw new AggregateError(
          [result.error, error],
          'Query inference and cancellation delivery failed.'
        );
      }
      throw error;
    }
    if (result.kind === 'error' && cancellationResult?.cancelled !== true) {
      throw result.error;
    }
    signal.throwIfAborted();
    if (result.kind === 'error') {
      throw result.error;
    }
    return result.embedding;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
