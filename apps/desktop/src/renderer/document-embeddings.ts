import type { EmbeddingHostDocumentEmbeddingsPayload } from '../embedding-host-shared';

/** AbortSignal stays in its renderer; the context bridge carries only an exact token. */
export async function generateDesktopDocumentEmbeddings(
  payload: EmbeddingHostDocumentEmbeddingsPayload,
  options?: { readonly signal?: AbortSignal }
): Promise<number[][]> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const bridge = window.embeddingHost;
  if (!(bridge && 'documentEmbeddings' in bridge && 'cancelDocumentEmbeddings' in bridge)) {
    throw new Error('Hidden document embedding capability is unavailable.');
  }
  const requestId = crypto.randomUUID();
  const cancellation = Promise.withResolvers<never>();
  let cancellationDelivery: Promise<void> | null = null;
  const onAbort = (): void => {
    cancellationDelivery = bridge.cancelDocumentEmbeddings(requestId);
    void cancellationDelivery.then(
      () =>
        cancellation.reject(
          signal?.reason ?? new DOMException('Document embeddings canceled.', 'AbortError')
        ),
      (error: unknown) => cancellation.reject(error)
    );
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = bridge.documentEmbeddings(payload, { requestId });
    if (signal?.aborted) {
      onAbort();
    }
    const embeddings = await Promise.race([result, cancellation.promise]);
    if (signal?.aborted) {
      await cancellationDelivery;
      signal.throwIfAborted();
    }
    if (
      embeddings.length !== payload.texts.length ||
      embeddings.some(
        (vector) => vector.length !== payload.dimensions || !vector.every(Number.isFinite)
      )
    ) {
      throw new Error('Document embedding response does not match the requested batch.');
    }
    return embeddings;
  } catch (error) {
    if (signal?.aborted) {
      await cancellationDelivery;
      signal.throwIfAborted();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
