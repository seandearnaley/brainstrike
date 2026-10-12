import type { HostedProviderType } from '@brainstrike/embeddings/provider-core';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { EmbeddingHostQueryEmbeddingPayload } from './embedding-host-shared';
import { generateHostedEmbeddings } from './hosted-embeddings';

/** Own provider operations until physical settlement, including stop/reset/dispose. */
export class HostedEmbeddingRequests {
  retirement: Promise<void> | null = null;
  private readonly requests = new Set<{
    readonly controller: AbortController;
    readonly settled: Promise<void>;
  }>();
  constructor(private readonly storage?: Pick<ElectronStorageAdapter, 'getItem'>) {}
  get hasPending(): boolean {
    return this.requests.size > 0 || this.retirement !== null;
  }
  async query(
    provider: HostedProviderType,
    payload: EmbeddingHostQueryEmbeddingPayload,
    signal?: AbortSignal
  ): Promise<number[]> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    const operation = Promise.resolve().then(() =>
      generateHostedEmbeddings({
        dimensions: payload.dimensions,
        modelId: payload.modelId,
        provider,
        purpose: 'query',
        signal: controller.signal,
        texts: [payload.query],
        ...(this.storage ? { storage: this.storage } : {}),
      })
    );
    const settled = operation.then(
      () => undefined,
      (error: unknown) => {
        if (controller.signal.aborted && error === controller.signal.reason) {
          return;
        }
        throw error;
      }
    );
    settled.catch(() => undefined);
    const owned = { controller, settled };
    this.requests.add(owned);
    let vectors: number[][];
    try {
      vectors = await operation;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.requests.delete(owned);
    }
    const vector = vectors[0];
    if (!vector) {
      throw new Error('Hosted query returned no vector.');
    }
    return vector;
  }
  async retire(): Promise<void> {
    if (this.retirement) {
      return this.retirement;
    }
    const pending = [...this.requests];
    const retirement = Promise.resolve().then(async () => {
      for (const request of pending) {
        request.controller.abort(new DOMException('Hosted query retired.', 'AbortError'));
      }
      const settled = await Promise.allSettled(pending.map((request) => request.settled));
      const errors = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Hosted query retirement failed.');
      }
    });
    this.retirement = retirement;
    try {
      await retirement;
    } finally {
      if (this.retirement === retirement) {
        this.retirement = null;
      }
    }
  }
}
