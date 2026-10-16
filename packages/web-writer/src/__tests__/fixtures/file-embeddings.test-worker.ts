/// <reference lib="webworker" />
/**
 * A dedicated worker that hosts the index worker's document embeddings, so a
 * test runs them where the index worker does: in a worker, with no window.
 * The embedding worker URL is this worker's URL fragment (`#embedder=`).
 */
import type { CanonicalDocumentEmbeddingsPayload } from '@brainstrike/canonical-ingestion/browser';
import { WebDocumentEmbeddings } from '../../file-embeddings';

export type TestWorkerRequest =
  | { readonly id: number; readonly kind: 'close' }
  | {
      readonly abort?: boolean;
      readonly id: number;
      readonly kind: 'embed';
      readonly payload: CanonicalDocumentEmbeddingsPayload;
    }
  | { readonly id: number; readonly kind: 'realm' };

export type TestWorkerReply =
  | { readonly error: string; readonly id: number; readonly ok: false }
  | { readonly id: number; readonly ok: true; readonly result: unknown };

const embedder = new URLSearchParams(self.location.hash.slice(1)).get('embedder');
if (!embedder) {
  throw new Error('The test worker needs an embedding worker URL.');
}
const embeddings = new WebDocumentEmbeddings(embedder);

async function answer(request: TestWorkerRequest): Promise<unknown> {
  switch (request.kind) {
    case 'close':
      return embeddings.close();
    case 'embed': {
      const controller = new AbortController();
      if (request.abort) {
        controller.abort(new DOMException('The test aborted.', 'AbortError'));
      }
      return embeddings.documentEmbeddings(request.payload, { signal: controller.signal });
    }
    case 'realm':
      return { window: typeof window, worker: typeof Worker };
  }
}

self.onmessage = (event: MessageEvent<TestWorkerRequest>) => {
  const request = event.data;
  answer(request).then(
    (result) => self.postMessage({ id: request.id, ok: true, result } satisfies TestWorkerReply),
    (error: unknown) =>
      self.postMessage({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        id: request.id,
        ok: false,
      } satisfies TestWorkerReply)
  );
};
