import embeddingWorkerUrlHref from '../../../packages/embedding-worker/src/embedding.worker.ts?worker&url';

export function resolveEmbeddingWorkerUrlHref(): string {
  return embeddingWorkerUrlHref;
}
